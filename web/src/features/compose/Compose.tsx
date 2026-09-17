/**
 * Compose — the Hashnode-style writing surface (plan §4.1).
 *
 * Routes: `/new?type=<key>&topic=<slug>` and `/p/:slug/edit`.
 * Layout: Title → Cover → Body (ItemEditorHost) → sticky footer
 * (Save draft · Preview · Publish…). Everything else lives in the Publish
 * drawer. Persistence reuses the PageView calls: POST /pages on first save
 * from `/new`, then PUT /pages/:id with If-Match (ConflictDialog on 409).
 * Autosave debounces 3 s while dirty.
 */
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { EditorMode } from '@echozedlabs/react';
import type { Frontmatter } from '@echozedlabs/codec';
import { FreshnessBadge } from '@echozedlabs/ui';
import {
  useBacklinks,
  useContentTypes,
  useGroups,
  useLinkIndex,
  useMe,
  usePageBySlug,
  usePrimaryCategories,
  useSections,
  useTags,
  useTopics,
  type ContentType,
  type Page,
} from '../../queries.js';
import { apiClient } from '../../api.js';
import {
  ItemEditorHost,
  buildKnowledgeItemPropertySchema,
  createItemEditorHostServices,
  searchItemLinkSuggestions,
  uploadImageAsset,
} from '../items/ItemEditorHost.js';
import { syncFirstHeadingWithTitle } from '../items/titleHeadingSync.js';
import { buildTopicOptions } from '../topics/topicFilters.js';
import { openReviewOf } from '../review/reviewModel.js';
import { useCuratedCategories, useItemSignals } from './queries.js';
import { ConflictDialog } from '../../components/ConflictDialog.js';
import { RenameDialog } from '../../components/RenameDialog.js';
import { Modal } from '../../components/Modal.js';
import { ReadView } from '../../components/ReadView.js';
import { useToast } from '../../hooks/useToast.js';
import { Icon, appIcons } from '../../icons.js';
import { PublishDrawer } from './PublishDrawer.js';
import {
  appendVerified,
  applyTemplate,
  buildRawMarkdown,
  defaultEditorMode,
  findType,
  initialFrontmatter,
  splitMarkdown,
  staleAfterFixFrom,
  withDrawerValues,
  type DrawerValues,
} from './composeModel.js';
import { drawerFieldLabel, saveOutcome, type SaveDiagnostic } from './saveErrors.js';
import './Compose.css';

interface EditState {
  markdown: string;
  frontmatter: Frontmatter;
}

interface ItemRef {
  id: string;
  slug: string;
  title: string;
  versionToken: number;
}

type SaveStatus = 'idle' | 'dirty' | 'saving' | 'saved' | 'error' | 'conflict' | 'upstream';

const AUTOSAVE_DELAY_MS = 3000;

async function fetchItemLinkSearchResults(query: string, signal?: AbortSignal): Promise<Page[]> {
  const params = new URLSearchParams({ q: query, include_drafts: '1', limit: '8' });
  const response = await fetch(`/api/v1/search?${params.toString()}`, { credentials: 'include', signal });
  if (!response.ok) throw new Error(`Item link search failed (${response.status})`);
  const body = (await response.json()) as { results?: Page[] };
  return body.results ?? [];
}

function titleOf(state: EditState | null): string {
  const title = state?.frontmatter?.title;
  return typeof title === 'string' ? title : '';
}

/**
 * Resolve the document to edit. The frontmatter the server parsed from the
 * stored version wins; the envelope inside `raw_markdown` and a synthesised
 * {title, status} are the fallbacks, so an imported row never opens with a
 * blank Title for an item that has one.
 */
function editStateFromPage(page: Page): EditState {
  const parsedStored = page.raw_markdown ? splitMarkdown(page.raw_markdown) : null;
  const frontmatter = (
    page.frontmatter && Object.keys(page.frontmatter).length > 0
      ? page.frontmatter
      : parsedStored && Object.keys(parsedStored.frontmatter).length > 0
        ? parsedStored.frontmatter
        : { title: page.title, status: page.status }
  ) as Frontmatter;
  const body = page.body_markdown ?? parsedStored?.body ?? '';
  return { markdown: buildRawMarkdown(frontmatter, body), frontmatter };
}

export function Compose() {
  const params = useParams({ strict: false }) as { slug?: string };
  const search =
    (useSearch({ strict: false }) as
      | { type?: string; topic?: string; title?: string; tag?: string; category?: string; group?: string }
      | undefined) ?? {};
  const routeSlug = params.slug ?? '';
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { push: pushToast } = useToast();

  const { data: page, isLoading: pageLoading, isError: pageError } = usePageBySlug(routeSlug);
  const { data: contentTypes = [], isPending: contentTypesPending } = useContentTypes();
  const { data: topics = [] } = useTopics();
  const { data: sections = [] } = useSections();
  // Two category vocabularies, deliberately: the union ("what exists") drives the
  // raw item-editor property schema so an existing item's own term still appears,
  // while the Publish drawer offers the CURATED catalog alone ("what may I publish
  // into"). Primary categories are curated, not emergent (Eric, 2026-09-11 —
  // issues 97/106), and the publish gate lints against the curated list.
  const { data: categories = [] } = usePrimaryCategories();
  const { data: curatedCategories = [] } = useCuratedCategories();
  const { data: groups = [] } = useGroups();
  const { data: taxonomyTags = [] } = useTags();
  const { data: currentUser } = useMe();
  const { data: knownSlugs } = useLinkIndex();

  const [item, setItem] = useState<ItemRef | null>(null);
  const [editState, setEditState] = useState<EditState | null>(null);
  const [editorMode, setEditorMode] = useState<EditorMode>('hybrid');
  const [isDirty, setIsDirty] = useState(false);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [conflict, setConflict] = useState<{ theirPage: Page; markdown: string; frontmatter: Frontmatter } | null>(null);
  /** The "Changed upstream" banner: the file moved under the index, not the version (plan §8.3). */
  const [upstreamChange, setUpstreamChange] = useState<string | null>(null);
  /** The publish gate's refusal: the content-model errors to fix, each naming its frontmatter key. */
  const [lintRefusal, setLintRefusal] = useState<{ message: string; diagnostics: SaveDiagnostic[] } | null>(null);
  const [renameDialog, setRenameDialog] = useState<{ oldTitle: string; newTitle: string; markdown: string; frontmatter: Frontmatter } | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [staleAfterSuggestion, setStaleAfterSuggestion] = useState<string | undefined>(undefined);
  const [coverBusy, setCoverBusy] = useState(false);

  const { data: backlinks = [] } = useBacklinks(item?.id ?? '');
  // Under a `review` sync policy this item's edits sit on their own branch
  // behind a change request (plan §8.2); surface that while composing.
  const { data: itemSignals } = useItemSignals(item?.id);
  const initializedRef = useRef(false);
  /** Slug of the most recently saved page; `item` state lags one render behind a first save. */
  const savedSlugRef = useRef<string | null>(null);
  const saveInFlightRef = useRef(false);
  const editStateRef = useRef<EditState | null>(null);
  editStateRef.current = editState;

  // --- initialise -----------------------------------------------------------
  useEffect(() => {
    if (initializedRef.current) return;
    if (routeSlug) {
      if (!page) return;
      initializedRef.current = true;
      const state = editStateFromPage(page);
      setItem({ id: page.id, slug: page.slug, title: page.title, versionToken: page.version_token });
      setEditState(state);
      setEditorMode(defaultEditorMode(state.frontmatter.type, contentTypes));
      return;
    }
    if (contentTypesPending) return;
    initializedRef.current = true;
    const typeDef = findType(search.type, contentTypes);
    const frontmatter = initialFrontmatter(typeDef, search.topic, {
      title: search.title,
      tag: search.tag,
      category: search.category,
      group: search.group,
    });
    setEditState({ markdown: buildRawMarkdown(frontmatter, applyTemplate('', typeDef).body), frontmatter });
    setEditorMode(defaultEditorMode(typeDef?.label, contentTypes));
  }, [routeSlug, page, contentTypes, contentTypesPending, search.type, search.topic, search.title, search.tag, search.category, search.group]);

  useEffect(() => {
    window.dispatchEvent(new CustomEvent('kp:page-edit-mode-changed', { detail: { isEditing: true } }));
    return () => {
      window.dispatchEvent(new CustomEvent('kp:page-edit-mode-changed', { detail: { isEditing: false } }));
    };
  }, []);

  useEffect(() => {
    const baseTitle = titleOf(editState) || 'Untitled';
    document.title = isDirty ? `• ${baseTitle}` : baseTitle;
  }, [isDirty, editState]);

  const markDirty = useCallback(() => {
    setIsDirty(true);
    setSaveStatus('dirty');
    setSaveError(null);
  }, []);

  const itemEditorPropertySchema = useMemo(
    () =>
      buildKnowledgeItemPropertySchema({
        topics: buildTopicOptions({ pages: [], topics }),
        tags: taxonomyTags.map((tag) => tag.slug || tag.name),
        categories: categories.map((category) => category.slug || category.name),
        groups: groups.map((group) => group.slug || group.name),
      }),
    [topics, taxonomyTags, categories, groups],
  );

  const itemEditorHostServices = useMemo(
    () =>
      createItemEditorHostServices({
        searchItems: (query, signal) =>
          searchItemLinkSuggestions(query, fetchItemLinkSearchResults, { currentItemId: item?.id, signal }),
        resolveItemLink: (target) => `/p/${encodeURIComponent(target)}`,
        navigateToItem: (href) => {
          navigate({ to: href }).catch(() => window.open(href, '_blank', 'noopener'));
        },
        uploadAsset: uploadImageAsset,
      }),
    [navigate, item?.id],
  );

  // --- persistence ----------------------------------------------------------
  const finishSave = useCallback(
    (saved: Page, markdown: string, frontmatter: Frontmatter, snapshot: EditState | null, diagnostics: unknown) => {
      setItem({ id: saved.id, slug: saved.slug, title: saved.title, versionToken: saved.version_token });
      setStaleAfterSuggestion(staleAfterFixFrom(diagnostics));
      // Only clear dirty when nothing changed while the request was in flight.
      if (editStateRef.current === snapshot) {
        setEditState({ markdown, frontmatter });
        setIsDirty(false);
        setSaveStatus('saved');
      }
      setLastSavedAt(new Date().toISOString());
      void queryClient.invalidateQueries({ queryKey: ['pages'] });
      void queryClient.invalidateQueries({ queryKey: ['pages-by-slug'] });
      void queryClient.invalidateQueries({ queryKey: ['search'] });
    },
    [queryClient],
  );

  /**
   * Persist the document. Returns true on success. `silent` (autosave) never
   * opens the rename dialog and never toasts.
   */
  const performSave = useCallback(
    async (frontmatterOverride?: Frontmatter, options: { silent?: boolean; versionToken?: number } = {}): Promise<boolean> => {
      const snapshot = editStateRef.current;
      if (!snapshot || saveInFlightRef.current) return false;
      const { frontmatter: envelope, body } = splitMarkdown(snapshot.markdown);
      const frontmatter = { ...envelope, ...snapshot.frontmatter, ...(frontmatterOverride ?? {}) } as Frontmatter;
      const title = String(frontmatter.title ?? '').trim();
      if (!title) {
        if (!options.silent) {
          setSaveError('title is required');
          setSaveStatus('error');
        }
        return false;
      }
      frontmatter.title = title;
      const markdown = buildRawMarkdown(frontmatter, body);

      if (item && item.title !== title && backlinks.length > 0 && !renameDialog) {
        if (options.silent) return false;
        setRenameDialog({ oldTitle: item.title, newTitle: title, markdown, frontmatter });
        return false;
      }

      saveInFlightRef.current = true;
      setIsSaving(true);
      setSaveStatus('saving');
      setSaveError(null);
      setUpstreamChange(null);
      setLintRefusal(null);
      try {
        if (!item) {
          const response = await apiClient.post<{ page: Page; diagnostics?: unknown }>('/pages', {
            title,
            body,
            status: frontmatter.status === 'published' ? 'published' : 'draft',
            tags: Array.isArray(frontmatter.tags) ? frontmatter.tags : [],
            frontmatter,
          });
          finishSave(response.page, markdown, frontmatter, snapshot, response.diagnostics);
          savedSlugRef.current = response.page.slug;
          void navigate({ to: '/p/$slug/edit', params: { slug: response.page.slug }, replace: true });
        } else {
          const response = await apiClient.put<{ page: Page; version_token: number; diagnostics?: unknown }>(
            `/pages/${item.id}`,
            { raw: markdown, frontmatter },
            { 'If-Match': String(options.versionToken ?? item.versionToken) },
          );
          finishSave(response.page, markdown, frontmatter, snapshot, response.diagnostics);
          savedSlugRef.current = response.page.slug;
        }
        if (!options.silent) pushToast({ kind: 'success', message: 'Draft saved.' });
        return true;
      } catch (err: unknown) {
        const outcome = saveOutcome(err, { hasItem: !!item });
        switch (outcome.kind) {
          case 'version-conflict': {
            setSaveStatus('conflict');
            setSaveError('Conflict detected. Review the version conflict before saving again.');
            try {
              // Only reported for an item that already exists (`hasItem`).
              const current = await apiClient.get<{ page: Page }>(`/pages/${item!.id}`);
              setConflict({ theirPage: current.page, markdown, frontmatter });
            } catch {
              setSaveError('Failed to load current version. Please refresh and try again.');
            }
            break;
          }
          case 'changed-upstream': {
            // Deliberately NOT the ConflictDialog: it diffs your document
            // against the STORED version, and the stored version is not what
            // changed here — the file did.
            setSaveStatus('upstream');
            // The banner carries the explanation; the footer only has to stop
            // promising an autosave that is now suppressed.
            setSaveError('Autosave is paused until the newer file is reloaded.');
            setUpstreamChange(outcome.message);
            break;
          }
          case 'lint-failed': {
            // Not a toast-and-forget: the diagnostics are the instructions, so
            // they stay on screen until the document satisfies them. The item is
            // still a draft — nothing was written — so editing continues.
            setSaveStatus('error');
            setSaveError(outcome.message);
            setLintRefusal({ message: outcome.message, diagnostics: outcome.diagnostics });
            break;
          }
          case 'read-only-source':
          case 'review-unsupported':
          case 'duplicate-title': {
            // Nothing to retry: the same request would be refused again until the
            // document changes, so these toast without the Retry action.
            setSaveStatus('error');
            setSaveError(outcome.message);
            if (!options.silent) pushToast({ kind: 'error', message: outcome.message });
            break;
          }
          case 'failed': {
            setSaveStatus('error');
            setSaveError(outcome.message);
            if (!options.silent) {
              pushToast({
                kind: 'error',
                message: outcome.message,
                actionLabel: 'Retry',
                onAction: () => void performSaveRef.current(frontmatterOverride, options),
              });
            }
            break;
          }
        }
        return false;
      } finally {
        saveInFlightRef.current = false;
        setIsSaving(false);
      }
    },
    [item, backlinks.length, renameDialog, finishSave, navigate, pushToast],
  );

  const performSaveRef = useRef(performSave);
  performSaveRef.current = performSave;

  // Autosave: 3 s after the last change while dirty.
  useEffect(() => {
    // While the file is ahead of the index, autosave would just re-refuse every
    // three seconds; the banner owns the next step.
    if (!isDirty || conflict || renameDialog || upstreamChange) return;
    const timer = window.setTimeout(() => void performSaveRef.current(undefined, { silent: true }), AUTOSAVE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [isDirty, editState, conflict, renameDialog, upstreamChange]);

  const handleSaveDraft = useCallback(() => void performSave(), [performSave]);

  const handleConflictOverwrite = useCallback(async () => {
    if (!item || !conflict) return;
    const current = await apiClient.get<{ page: Page }>(`/pages/${item.id}`);
    const ok = await performSave(conflict.frontmatter, { versionToken: current.page.version_token });
    if (ok) setConflict(null);
  }, [item, conflict, performSave]);

  const handleRename = useCallback(
    async (linkAction: 'update_all' | 'skip') => {
      if (!item || !renameDialog) return;
      const pending = renameDialog;
      setRenameDialog(null);
      // Save first (with the dialog cleared so the guard does not re-open it), then rename links.
      const ok = await performSaveRef.current(pending.frontmatter);
      if (!ok) return;
      try {
        await apiClient.post(`/pages/${item.id}/rename`, { new_title: pending.newTitle, link_action: linkAction });
        void queryClient.invalidateQueries({ queryKey: ['backlinks'] });
      } catch (err: any) {
        setSaveError(err?.message || 'Failed to rename. Please try again.');
      }
    },
    [item, renameDialog, queryClient],
  );

  // --- editing --------------------------------------------------------------
  const handleTitleChange = useCallback(
    (nextTitle: string) => {
      setEditState((previous) => {
        if (!previous) return previous;
        return {
          markdown: syncFirstHeadingWithTitle(previous.markdown, titleOf(previous), nextTitle).markdown,
          frontmatter: { ...previous.frontmatter, title: nextTitle } as Frontmatter,
        };
      });
      markDirty();
    },
    [markDirty],
  );

  const setFrontmatter = useCallback(
    (next: Frontmatter) => {
      setEditState((previous) => {
        if (!previous) return previous;
        return { markdown: buildRawMarkdown(next, splitMarkdown(previous.markdown).body), frontmatter: next };
      });
      markDirty();
    },
    [markDirty],
  );

  const setCover = useCallback(
    (url: string | undefined) => {
      const next = { ...(editStateRef.current?.frontmatter ?? {}) } as Record<string, unknown>;
      if (url) next['cover'] = url;
      else delete next['cover'];
      setFrontmatter(next as Frontmatter);
    },
    [setFrontmatter],
  );

  const uploadCover = useCallback(async (file: File) => (await uploadImageAsset(file)).url, []);

  const handleCoverFile = useCallback(
    async (file: File) => {
      setCoverBusy(true);
      try {
        setCover(await uploadCover(file));
      } catch (error) {
        pushToast({ kind: 'error', message: error instanceof Error ? error.message : 'Cover upload failed.' });
      } finally {
        setCoverBusy(false);
      }
    },
    [setCover, uploadCover, pushToast],
  );

  const handleApplyTemplate = useCallback(
    (type: ContentType) => {
      setEditState((previous) => {
        if (!previous) return previous;
        const { body } = splitMarkdown(previous.markdown);
        const frontmatter = { ...previous.frontmatter, type: type.label } as Frontmatter;
        return { markdown: buildRawMarkdown(frontmatter, applyTemplate(body, type).body), frontmatter };
      });
      setEditorMode(defaultEditorMode(type.label, contentTypes));
      markDirty();
    },
    [contentTypes, markDirty],
  );

  const handleDrawerSave = useCallback(
    async (values: DrawerValues, options: { publish: boolean; reviewed: boolean }) => {
      const base = editStateRef.current?.frontmatter ?? ({} as Frontmatter);
      let frontmatter = withDrawerValues(base, options.publish ? { ...values, status: 'published' } : values);
      if (options.publish && options.reviewed && currentUser) {
        frontmatter = appendVerified(frontmatter, currentUser.username, new Date().toISOString());
      }
      // The save writes the merged frontmatter back into editState on success;
      // on failure the drawer stays open with its own values intact.
      const ok = await performSave(frontmatter);
      if (!ok) return;
      setDrawerOpen(false);
      if (options.publish) {
        pushToast({ kind: 'success', message: 'Published.' });
        const slug = item?.slug ?? savedSlugRef.current;
        if (slug) void navigate({ to: '/p/$slug', params: { slug } });
      }
    },
    [currentUser, performSave, pushToast, item?.slug, navigate],
  );

  // Stable dismiss callbacks: Modal re-runs its focus effect when `onClose`
  // changes, which would steal focus from drawer inputs on every re-render.
  const closeDrawer = useCallback(() => setDrawerOpen(false), []);
  const closePreview = useCallback(() => setPreviewOpen(false), []);

  const handleCancel = useCallback(() => {
    if (isDirty && !window.confirm('Discard unsaved changes?')) return;
    if (item) void navigate({ to: '/p/$slug', params: { slug: item.slug } });
    else void navigate({ to: '/' });
  }, [isDirty, item, navigate]);

  // Save and leave from anywhere on the surface, not only from inside the
  // editor: the title field, the cover picker and the drawer are all outside it.
  // Declared after handleSaveDraft/handleCancel so the deps array does not
  // reference them inside their temporal dead zone.
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === 's') {
        event.preventDefault();
        handleSaveDraft();
        return;
      }
      if (event.key !== 'Escape') return;
      // Every layer above the editor owns Esc for itself — the drawer and the
      // preview close, the dialogs cancel — and a form control may be mid-edit.
      if (drawerOpen || previewOpen || conflict || renameDialog) return;
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target?.isContentEditable) return;
      event.preventDefault();
      handleCancel();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleSaveDraft, handleCancel, drawerOpen, previewOpen, conflict, renameDialog]);

  // --- render ---------------------------------------------------------------
  if (routeSlug && (pageLoading || (!page && !pageError))) {
    return <div className="text-center text-slate-500">Loading...</div>;
  }
  if (routeSlug && !page) {
    return <div className="text-center text-slate-500">Page not found</div>;
  }
  // A `read-only` source writes nothing back (plan §8.2). The read page already
  // withdraws its Edit action; this covers the author who arrived by URL, so the
  // refusal is stated up front rather than discovered by saving.
  if (page?.source?.mode === 'read-only') {
    return (
      <main className="kp-compose">
        <section className="kp-compose-upstream" role="note" aria-label="Read-only source">
          <div className="kp-compose-upstream-text">
            <strong>This item cannot be edited here</strong>
            {/* Plan §6, R4.1: the fact, not the plumbing. A link to the original
                is fine; a repository path and the word "sync" are not. */}
            <p>Changes to this page are made by the team that owns it.</p>
            <p>
              {page.source?.url ? (
                <a href={page.source.url} target="_blank" rel="noreferrer noopener">View the original</a>
              ) : null}{' '}
              <Link to="/p/$slug" params={{ slug: page.slug }}>Back to the item</Link>
            </p>
          </div>
        </section>
      </main>
    );
  }
  if (!editState) {
    return <div className="text-center text-slate-500">Loading...</div>;
  }

  const title = titleOf(editState);
  const openReview = openReviewOf(itemSignals);
  const body = splitMarkdown(editState.markdown).body;
  const cover = typeof editState.frontmatter.cover === 'string' ? editState.frontmatter.cover : '';
  const typeDef = findType(editState.frontmatter.type, contentTypes);
  const saveStatusText = isSaving
    ? 'Saving…'
    : saveStatus === 'saved'
      ? `Saved${lastSavedAt ? ` ${new Date(lastSavedAt).toLocaleTimeString()}` : ''}`
      : saveStatus === 'error'
        ? 'Save failed'
        : saveStatus === 'upstream'
          ? 'Changed outside the app'
          : saveStatus === 'conflict'
            ? 'Conflict needs attention'
            : isDirty
              ? title.trim()
                ? 'Unsaved changes'
                : 'Add a title to save'
              : item
                ? 'Draft'
                : 'New draft';

  return (
    <main className="kp-compose" aria-labelledby="compose-title-input">
      <div className="kp-compose-head">
        <nav className="kp-compose-crumbs" aria-label="Breadcrumb">
          <Link to="/">Pages</Link>
          <span aria-hidden="true">/</span>
          <span>{item ? item.slug : 'New item'}</span>
          {typeDef ? <span className="kp-compose-type">{typeDef.label}</span> : null}
          {openReview ? <FreshnessBadge displayState="in-review" reviewUrl={openReview.url} canOpenReview /> : null}
        </nav>
        <label className="kp-compose-title-label" htmlFor="compose-title-input">
          Title
        </label>
        <input
          id="compose-title-input"
          className="kp-compose-title"
          value={title}
          placeholder="Untitled"
          autoFocus={!routeSlug}
          onChange={(event) => handleTitleChange(event.target.value)}
        />
        <div className="kp-compose-cover">
          {cover ? (
            <>
              <img src={cover} alt="Cover preview" className="kp-compose-cover-preview" />
              <button type="button" className="kp-compose-inline-action" onClick={() => setCover(undefined)}>
                Remove cover
              </button>
            </>
          ) : (
            <label className="kp-compose-cover-add">
              <Icon icon={appIcons.image} />
              <span>{coverBusy ? 'Uploading cover…' : 'Add a cover image'}</span>
              <input
                type="file"
                accept="image/*"
                aria-label="Cover image"
                disabled={coverBusy}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = '';
                  if (file) void handleCoverFile(file);
                }}
              />
            </label>
          )}
        </div>
      </div>

      {lintRefusal ? (
        <section className="kp-compose-lint" role="alert" aria-label="Cannot publish yet">
          <div className="kp-compose-lint-text">
            <strong>Cannot publish yet</strong>
            <p>{lintRefusal.message}</p>
            {lintRefusal.diagnostics.length > 0 ? (
              <ul className="kp-compose-lint-list">
                {lintRefusal.diagnostics.map((diagnostic) => (
                  <li key={`${diagnostic.code}:${diagnostic.path ?? ''}`}>
                    {/* Name the drawer control, not the YAML key, when we know it. */}
                    {diagnostic.path ? <code>{drawerFieldLabel(diagnostic.path) ?? diagnostic.path}</code> : null}
                    <span>{diagnostic.message}</span>
                  </li>
                ))}
              </ul>
            ) : null}
            <p>The item is unchanged — nothing was saved. Fix these in the Publish drawer, then publish again.</p>
          </div>
          <button type="button" className="kp-compose-secondary" onClick={() => setDrawerOpen(true)}>
            <span>Open Publish drawer</span>
          </button>
        </section>
      ) : null}

      {upstreamChange ? (
        <section className="kp-compose-upstream" role="alert" aria-label="Changed outside the app">
          <div className="kp-compose-upstream-text">
            <strong>Changed outside the app</strong>
            <p>{upstreamChange}</p>
            <p>Reloading replaces what is in the editor with the newer file, so copy anything you want to keep first.</p>
          </div>
          <button type="button" className="kp-compose-secondary" onClick={() => window.location.reload()}>
            <span>Reload</span>
          </button>
        </section>
      ) : null}

      <div
        className="kp-compose-editor"
        onKeyDownCapture={(event) => {
          if (event.metaKey || event.ctrlKey || event.altKey) return;
          if (event.key.length === 1 || event.key === 'Backspace' || event.key === 'Delete') markDirty();
        }}
        onInputCapture={markDirty}
      >
        <ItemEditorHost
          value={editState.markdown}
          mode={editorMode}
          hostServices={itemEditorHostServices}
          propertySchema={itemEditorPropertySchema}
          frontmatterDisplay="hidden"
          onChange={(fullDoc) => {
            setEditState((previous) => {
              const parsedNext = splitMarkdown(fullDoc);
              if (!previous) return { markdown: fullDoc, frontmatter: parsedNext.frontmatter };
              // Keep the editor's own document verbatim on the common typing
              // path (re-stringifying every keystroke risks cursor resets). Only
              // rebuild when the editor echoed a stale envelope: the compose
              // title and drawer-owned keys always win.
              const echoedEnvelope = buildRawMarkdown(parsedNext.frontmatter, '');
              const ownedEnvelope = buildRawMarkdown(previous.frontmatter, '');
              return echoedEnvelope === ownedEnvelope
                ? { markdown: fullDoc, frontmatter: previous.frontmatter }
                : { markdown: buildRawMarkdown(previous.frontmatter, parsedNext.body), frontmatter: previous.frontmatter };
            });
            markDirty();
          }}
          onModeChange={setEditorMode}
          onSaveShortcut={handleSaveDraft}
          onCancelShortcut={handleCancel}
          onDiagnostics={(diagnostics) => {
            const firstError = diagnostics.find((diagnostic) => diagnostic.severity === 'error');
            if (firstError) setSaveError(firstError.message);
          }}
        />
      </div>

      <section className={`kp-compose-footer kp-compose-footer--${saveStatus}`} aria-label="Item save status" aria-live="polite">
        <div className="kp-compose-footer-status">
          <strong>{saveStatusText}</strong>
          {saveError ? <p>{saveError}</p> : <span>Autosaves a few seconds after you stop typing.</span>}
        </div>
        <div className="kp-compose-footer-actions">
          <button type="button" className="kp-compose-secondary" onClick={handleCancel} disabled={isSaving}>
            <Icon icon={appIcons.xmark} />
            <span>Cancel</span>
          </button>
          <button type="button" className="kp-compose-secondary" onClick={handleSaveDraft} disabled={isSaving}>
            <Icon icon={appIcons.floppyDisk} />
            <span>Save draft</span>
          </button>
          <button type="button" className="kp-compose-secondary" onClick={() => setPreviewOpen(true)}>
            <Icon icon={appIcons.eye} />
            <span>Preview</span>
          </button>
          <button type="button" className="kp-compose-primary" onClick={() => setDrawerOpen(true)} disabled={isSaving}>
            <Icon icon={appIcons.penNib} />
            <span>Publish…</span>
          </button>
        </div>
      </section>

      {previewOpen ? (
        <Modal onClose={closePreview} labelledBy="compose-preview-title" backdropClassName="kp-compose-preview-backdrop" className="kp-compose-preview">
          <div className="kp-compose-preview-header">
            <h2 id="compose-preview-title">Preview</h2>
            <button type="button" className="kp-compose-drawer-close" onClick={closePreview} aria-label="Close preview">
              ×
            </button>
          </div>
          <div className="kp-compose-preview-body">
            <h1 className="kp-compose-preview-title">{title || 'Untitled'}</h1>
            <ReadView markdown={body} knownSlugs={knownSlugs} />
          </div>
        </Modal>
      ) : null}

      {drawerOpen ? (
        <PublishDrawer
          title={title}
          frontmatter={editState.frontmatter}
          bodyIsEmpty={body.trim().length === 0}
          contentTypes={contentTypes}
          topics={topics}
          sections={sections}
          categories={curatedCategories}
          groups={groups}
          staleAfterSuggestion={staleAfterSuggestion}
          source={page?.source}
          saving={isSaving}
          onClose={closeDrawer}
          onApplyTemplate={handleApplyTemplate}
          onFrontmatterChange={setFrontmatter}
          onUploadCover={uploadCover}
          onSave={handleDrawerSave}
        />
      ) : null}

      {conflict ? (
        <ConflictDialog
          yourVersion={conflict.markdown}
          theirVersion={conflict.theirPage.body_markdown}
          theirPage={conflict.theirPage}
          yourUpdatedAt={new Date().toISOString()}
          theirUpdatedAt={conflict.theirPage.updated_at}
          onOverwrite={() => void handleConflictOverwrite()}
          onCancel={() => setConflict(null)}
          isLoading={isSaving}
        />
      ) : null}

      {renameDialog ? (
        <RenameDialog
          oldTitle={renameDialog.oldTitle}
          newTitle={renameDialog.newTitle}
          affectedCount={backlinks.length}
          onUpdateAll={() => void handleRename('update_all')}
          onSkip={() => void handleRename('skip')}
          onCancel={() => setRenameDialog(null)}
          isLoading={isSaving}
        />
      ) : null}
    </main>
  );
}
