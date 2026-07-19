/**
 * PageView — Apple-professional redesign (Wave J-γ)
 *
 * Layout structure:
 * 1. PageChrome (top) — title, breadcrumb, action pill
 * 2. FrontmatterStrip — visible in edit mode (below chrome, above editor)
 * 3. Three-zone grid (responsive):
 *    - Mobile/Tablet (<1280px): Single column, editor fills body
 *    - Desktop (>=1280px): Left rail (280px) | Body (1fr) | Right rail (280px)
 * 4. Right rail: Search box (top) + Backlinks panel (collapsed by default)
 *
 * Read mode: Editor in preview mode (CM6 decoration, read-only)
 * Edit mode: Editor in hybrid/preview mode with FrontmatterStrip + SaveFab
 *
 * Save: PUT /api/v1/pages/:id with If-Match (version_token).
 * Conflict (409): ConflictDialog with diff and overwrite option.
 * Rename: RenameDialog to consent to updating backlinks.
 */

import { useParams, useSearch, useNavigate } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useState, useMemo, useRef } from 'react';
import { usePageBySlug, useBacklinks, usePage, useTags, usePrimaryCategories, useGroups, useTopics, useMe, useLinkIndex, type Page } from '../queries.js';
import { apiClient } from '../api.js';
import { parse } from '@echozedlabs/codec';
import { stringify } from 'yaml';
import type { EditorMode } from '@echozedlabs/react';
import { ItemEditorHost, buildKnowledgeItemPropertySchema, createItemEditorHostServices, searchItemLinkSuggestions, uploadImageAsset } from '../features/items/ItemEditorHost.js';
import { PageChrome } from '../components/PageChrome.js';
import { ConflictDialog } from '../components/ConflictDialog.js';
import { RenameDialog } from '../components/RenameDialog.js';
import { BacklinksPanel } from '../components/BacklinksPanel.js';
import { ReadView, headingSlug } from '../components/ReadView.js';
import { ContentTypeBadge, resolveContentTypeMeta } from '../components/ContentTypeBadge.js';
import { useContentTypes } from '../queries.js';
import { authorsOf, coverImageOf, displayDateOf, formatDate, readingTimeMinutes, seriesOf } from '../features/blog/blogMeta.js';
import { RightContextPane, type TocEntry, type PaneProperty } from '../components/RightContextPane.js';
import { extractCopyableEntries } from '../features/items/copyableContent.js';
import { syncFirstHeadingWithTitle } from '../features/items/titleHeadingSync.js';
import { buildTopicLookup, buildTopicOptions, displayFromSlug, displayTopic, frontmatterString, topicForPage } from '../features/topics/topicFilters.js';
import { useToast } from '../hooks/useToast.js';
import type { Frontmatter } from '@echozedlabs/codec';
import { Icon, appIcons } from '../icons.js';
import './PageView.css';

interface EditState {
  markdown: string;
  frontmatter: Frontmatter;
}

interface ConflictState {
  theirPage: any;
  yourMarkdown: string;
}

type SaveStatus = 'idle' | 'dirty' | 'saving' | 'saved' | 'error' | 'conflict';

interface LocalNotice {
  kind: 'success' | 'error';
  message: string;
  actionLabel?: string;
  onAction?: () => void;
}

function buildRawMarkdown(frontmatter: Frontmatter, body: string): string {
  const yaml = stringify(frontmatter).trim();
  return yaml.length > 0 ? `---\n${yaml}\n---\n${body}` : body;
}

function frontmatterFromMarkdown(markdown: string): Frontmatter {
  return parse(markdown).frontmatter as Frontmatter;
}

function titleFromEditState(editState: EditState | null, fallback: string): string {
  const title = editState?.frontmatter?.title;
  return typeof title === 'string' ? title : fallback;
}

function withCanonicalTopic(frontmatter: Frontmatter, topic: string): Frontmatter {
  const next = { ...frontmatter } as Frontmatter;
  delete (next as Record<string, unknown>)['space'];
  const trimmed = topic.trim();
  if (trimmed) {
    (next as Record<string, unknown>)['topic'] = trimmed;
  } else {
    delete (next as Record<string, unknown>)['topic'];
  }
  return next;
}

function propertyValueText(value: unknown): string {
  if (Array.isArray(value)) return value.map(propertyValueText).filter(Boolean).join(', ');
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function visiblePropertyEntries(frontmatter: Frontmatter | undefined): Array<[string, string]> {
  return Object.entries((frontmatter ?? {}) as Record<string, unknown>)
    .map(([key, value]) => [key, propertyValueText(value).trim()] as [string, string])
    .filter(([, value]) => value.length > 0)
    .sort(([a], [b]) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
}

function propertyLabel(key: string): string {
  return displayFromSlug(key);
}

async function fetchItemLinkSearchResults(query: string, signal?: AbortSignal): Promise<Page[]> {
  const params = new URLSearchParams();
  params.set('q', query);
  params.set('include_drafts', '1');
  params.set('limit', '8');
  const response = await fetch(`/api/v1/search?${params.toString()}`, {
    credentials: 'include',
    signal,
  });
  if (!response.ok) {
    throw new Error(`Item link search failed (${response.status})`);
  }
  const body = (await response.json()) as { results?: Page[] };
  return body.results ?? [];
}

export function PageView() {
  const params = useParams({ strict: false }) as { slug?: string; id?: string };
  const routeItemId = params.id;
  const routeSlug = params.slug ?? '';
  const searchParams = useSearch({ strict: false }) as { edit?: string } | undefined;
  const { data: pageByRouteId, isLoading: pageByIdLoading, refetch: refetchRouteIdPage } = usePage(routeItemId ?? '');
  const { data: pageByRouteSlug, isLoading: pageBySlugLoading, refetch: refetchRouteSlugPage } = usePageBySlug(routeItemId ? '' : routeSlug);
  const page = routeItemId ? pageByRouteId : pageByRouteSlug;
  const pageLoading = routeItemId ? pageByIdLoading : pageBySlugLoading;
  const refetchPage = routeItemId ? refetchRouteIdPage : refetchRouteSlugPage;
  const { data: backlinks = [] } = useBacklinks(page?.id || '');
  const { data: taxonomyTags = [] } = useTags();
  const { data: taxonomyCategories = [] } = usePrimaryCategories();
  const { data: taxonomyGroups = [] } = useGroups();
  const { data: topics = [] } = useTopics();
  const { data: currentUser } = useMe();
  const { data: knownSlugs } = useLinkIndex();
  const canWrite = !!currentUser; // anonymous (public read mode) is view-only
  const { refetch: refetchPageById } = usePage(page?.id || '');
  const autoEditProcessedRef = useRef(false);
  const autoEditBodyFocusDoneRef = useRef(false);
  const saveInFlightRef = useRef(false);
  const titleInputRef = useRef<HTMLInputElement | null>(null);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { push: pushToast } = useToast();

  const [isEditing, setIsEditing] = useState(false);
  const [editState, setEditState] = useState<EditState | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [conflict, setConflict] = useState<ConflictState | null>(null);
  const [renameDialog, setRenameDialog] = useState<{
    oldTitle: string;
    newTitle: string;
    pageId: string;
    affectedCount: number;
  } | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [isDirty, setIsDirty] = useState(false);
  const [editorMode, setEditorMode] = useState<EditorMode>('hybrid');
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle');
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(null);
  const [currentVersionToken, setCurrentVersionToken] = useState<number | null>(null);
  const [railCollapsed, setRailCollapsed] = useState(false);
  const [localNotice, setLocalNotice] = useState<LocalNotice | null>(null);
  const editSearchValue = String(searchParams?.edit ?? '').replaceAll('"', '');
  const shouldAutoEdit = editSearchValue === '1' || editSearchValue === 'true';
  const itemEditorPropertySchema = useMemo(
    () =>
      buildKnowledgeItemPropertySchema({
        topics: buildTopicOptions({ pages: page ? [page] : [], topics }),
        tags: taxonomyTags.map((tag) => tag.slug || tag.name),
        categories: taxonomyCategories.map((category) => category.slug || category.name),
        groups: taxonomyGroups.map((group) => group.slug || group.name),
      }),
    [page, topics, taxonomyTags, taxonomyCategories, taxonomyGroups],
  );

  const topicLookup = useMemo(() => buildTopicLookup(topics), [topics]);

  const itemEditorHostServices = useMemo(
    () =>
      createItemEditorHostServices({
        searchItems: (query, signal) =>
          searchItemLinkSuggestions(query, fetchItemLinkSearchResults, {
            currentItemId: page?.id,
            signal,
          }),
        resolveItemLink: (target) => `/p/${encodeURIComponent(target)}`,
        navigateToItem: (href) => {
          navigate({ to: href }).catch(() => {
            window.open(href, '_blank', 'noopener');
          });
        },
        // Paste/drag-drop/insert an image → upload to E3, get a bundle-relative URL.
        uploadAsset: uploadImageAsset,
      }),
    [navigate, page?.id],
  );

  // Fire the page-view telemetry event once per page navigation. Best-effort —
  // failures are silently swallowed so they never disrupt the read flow.
  useEffect(() => {
    if (!page?.id) return;
    apiClient.post('/events/page-view', { page_id: page.id }).catch(() => {});
  }, [page?.id]);

  useEffect(() => {
    autoEditBodyFocusDoneRef.current = false;
  }, [page?.id, shouldAutoEdit]);

  useEffect(() => {
    window.dispatchEvent(new CustomEvent('kp:page-edit-mode-changed', { detail: { isEditing } }));
    return () => {
      window.dispatchEvent(new CustomEvent('kp:page-edit-mode-changed', { detail: { isEditing: false } }));
    };
  }, [isEditing]);

  useEffect(() => {
    if (!page) return;
    setCurrentVersionToken(page.version_token);
  }, [page?.id, page?.version_token]);

  useEffect(() => {
    if (localNotice?.kind !== 'success') return;
    const timeout = window.setTimeout(() => setLocalNotice(null), 3200);
    return () => window.clearTimeout(timeout);
  }, [localNotice]);


  // (Auto-edit useEffect moved below — see after enterEditMode declaration.
  //  Same TDZ pattern that bit us with the keyboard shortcuts effect: deps
  //  array references parsedPage + enterEditMode which are declared further
  //  down; evaluating the deps array here would throw ReferenceError.)

  // (Keyboard shortcuts useEffect moved BELOW handleSave/exitEditMode to fix
  //  TDZ error: deps array references those callbacks, and JS evaluates the
  //  deps during render — at this position they're still in the temporal
  //  dead zone. Hooks rules say "always call in the same order"; we satisfy
  //  that by always calling the moved hook in the same place lower in the body.)

  // Parse frontmatter from body. The server hands us body_markdown (without
  // frontmatter) plus a parsed frontmatter object on the page directly; we
  // re-parse via the codec so other extracted fields stay consistent.
  const parsedPage = useMemo(() => {
    if (!page) return null;
    return parse(page.raw_markdown ?? page.body_markdown ?? '');
  }, [page]);

  const enterEditMode = useCallback(() => {
    if (!page || !parsedPage) return;
    // Frontmatter source priority: server-supplied frontmatter (already parsed
    // from the version's stored YAML) wins over re-parsing raw_markdown. Falls
    // back to parsedPage.frontmatter, then a synthesised {title, status} so we
    // never enter edit mode with a blank Title field for a page that has one.
    const frontmatter =
      (page.frontmatter && Object.keys(page.frontmatter).length > 0
        ? (page.frontmatter as Frontmatter)
        : Object.keys(parsedPage.frontmatter).length > 0
          ? parsedPage.frontmatter
          : { title: page.title, status: page.status }) as Frontmatter;
    // The reusable editor needs a full Markdown document with a YAML envelope for
    // hybrid properties. Older/imported rows may expose body_markdown plus parsed
    // frontmatter while raw_markdown is absent or body-only, so synthesize the
    // envelope when needed instead of mounting with no properties controls.
    const storedMarkdown = page.raw_markdown ?? '';
    const parsedStoredMarkdown = storedMarkdown ? parse(storedMarkdown) : null;
    const storedFrontmatterTitle = parsedStoredMarkdown?.frontmatter?.title;
    const expectedTitle = frontmatter.title ?? page.title;
    const rawMarkdownHasTrustedEnvelope =
      parsedStoredMarkdown?.hasFrontmatter === true &&
      (expectedTitle === undefined || String(storedFrontmatterTitle ?? '') === String(expectedTitle ?? ''));
    const editorMarkdown = rawMarkdownHasTrustedEnvelope
      ? storedMarkdown
      : buildRawMarkdown(frontmatter, page.body_markdown ?? parsedPage.body ?? storedMarkdown);
    setEditState({
      markdown: editorMarkdown,
      frontmatter,
    });
    setIsEditing(true);
    setSaveError(null);
    setSaveStatus('idle');
  }, [page, parsedPage]);

  // Auto-enter edit mode if edit=1 query param is present (e.g., from new
  // page creation). MUST be declared after parsedPage + enterEditMode so the
  // deps array can reference them without hitting a TDZ ReferenceError.
  useEffect(() => {
    if (
      shouldAutoEdit &&
      canWrite &&
      page &&
      parsedPage &&
      !isEditing &&
      !autoEditProcessedRef.current
    ) {
      autoEditProcessedRef.current = true;
      enterEditMode();
    }
  }, [shouldAutoEdit, canWrite, page, parsedPage, isEditing, enterEditMode]);

  const exitEditMode = useCallback(() => {
    setIsEditing(false);
    setEditState(null);
    setConflict(null);
    setRenameDialog(null);
    setSaveError(null);
    setIsDirty(false);
    setSaveStatus('idle');
  }, []);

  const handleSave = useCallback(async () => {
    if (!page || !editState) return;
    if (saveInFlightRef.current) return;
    saveInFlightRef.current = true;

    const activeElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const parsedDraft = parse(editState.markdown);
    const draftFrontmatter = {
      ...(parsedDraft.frontmatter as Frontmatter),
      ...editState.frontmatter,
      ...(titleInputRef.current ? { title: titleInputRef.current.value } : {}),
    } as Frontmatter;
    let draftMarkdown = buildRawMarkdown(draftFrontmatter, parsedDraft.body);

    // Client-side validation: title is required (mirrors spec §3.1).
    const trimmedTitle = (draftFrontmatter.title ?? '').toString().trim();
    if (!trimmedTitle) {
      setSaveError('title is required');
      setSaveStatus('error');
      saveInFlightRef.current = false;
      return;
    }

    const oldTitle = parsedPage?.frontmatter.title || page.title;
    const newTitle = trimmedTitle;
    const titleChanged = oldTitle !== newTitle;
    if (titleChanged) {
      draftMarkdown = syncFirstHeadingWithTitle(draftMarkdown, oldTitle, newTitle).markdown;
    }

    // Client assist only: catch duplicate titles before attempting the save so
    // the editor stays mounted with the unsaved draft intact. The server-side
    // duplicate check remains authoritative and is still handled below.
    if (titleChanged) {
      try {
        const possibleDuplicates = await apiClient.get<{ items: Page[] }>(`/pages?q=${encodeURIComponent(newTitle)}&limit=25`);
        const duplicate = possibleDuplicates.items.find(
          (candidate) =>
            candidate.id !== page.id &&
            candidate.title === newTitle &&
            (candidate.space_id ?? null) === (page.space_id ?? null),
        );
        if (duplicate) {
          setSaveError(`An item titled "${newTitle}" already exists in this topic. Choose a unique title before saving.`);
          setSaveStatus('error');
          saveInFlightRef.current = false;
          return;
        }
      } catch {
        // Preflight is a UX assist only. If it fails, continue to the
        // authoritative server-side validation during the save.
      }
    }

    // If title changed and there are backlinks, show rename dialog
    if (titleChanged && backlinks.length > 0) {
      setRenameDialog({
        oldTitle,
        newTitle,
        pageId: page.id,
        affectedCount: backlinks.length,
      });
      setSaveStatus('conflict');
      saveInFlightRef.current = false;
      return;
    }

    // Perform the save in-place: the focused editor shell stays mounted and the
    // sticky status bar reports progress/success/failure beside the primary action.
    try {
      await performSave(draftMarkdown, draftFrontmatter, currentVersionToken ?? page.version_token);
      window.requestAnimationFrame(() => activeElement?.focus());
    } finally {
      saveInFlightRef.current = false;
    }
  }, [page, editState, parsedPage, backlinks, currentVersionToken]);

  // Keyboard shortcuts in edit mode: Cmd/Ctrl+S to save, Esc to cancel.
  // MUST be declared after handleSave/exitEditMode so the deps array can
  // reference them without hitting a temporal-dead-zone ReferenceError.
  useEffect(() => {
    if (!isEditing) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      // Cmd+S / Ctrl+S → Save
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        handleSave();
      }
      // Esc → Cancel with discard confirmation if dirty.
      // Skip if the event originated inside a form control or contenteditable
      // surface — those have their own Esc semantics (close popover, cancel
      // inline edit, blur cell, etc.) and bubbling up to "exit edit mode" is
      // surprising. Also skip if the frontmatter strip has an inline edit
      // open — the popover/chip editor handles Esc itself, and the event's
      // target is `body` in that case (no input focused), so the tag guard
      // doesn't catch it.
      if (e.key === 'Escape') {
        const target = e.target as HTMLElement | null;
        const tag = target?.tagName;
        if (
          tag === 'INPUT' ||
          tag === 'TEXTAREA' ||
          tag === 'SELECT' ||
          target?.isContentEditable ||
          document.querySelector('[data-strip-active="true"]')
        ) {
          return;
        }
        e.preventDefault();
        if (isDirty) {
          const confirm = window.confirm('Discard unsaved changes?');
          if (confirm) exitEditMode();
        } else {
          exitEditMode();
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isEditing, isDirty, handleSave, exitEditMode]);

  // Update document.title with dirty indicator
  useEffect(() => {
    const baseTitle = page?.title || 'Untitled';
    document.title = isDirty ? `• ${baseTitle}` : baseTitle;
  }, [isDirty, page?.title]);

  // New-item drafts should land with the body editor ready for immediate typing.
  // Only do this once for the auto-edit mount. Re-running on every editState
  // update steals focus back from the title input after the first typed
  // character because title edits also update editState.
  useEffect(() => {
    if (!isEditing || !editState || !shouldAutoEdit || autoEditBodyFocusDoneRef.current) return;
    autoEditBodyFocusDoneRef.current = true;
    const frame = window.requestAnimationFrame(() => {
      const activeElement = document.activeElement;
      if (
        activeElement &&
        activeElement !== document.body &&
        activeElement !== document.documentElement
      ) {
        return;
      }
      const editor = document.querySelector<HTMLElement>('.cm-content, .ProseMirror');
      editor?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [isEditing, editState, shouldAutoEdit, page?.id]);

  const performSave = useCallback(
    async (markdown: string, frontmatter: Frontmatter, versionToken: number) => {
      if (!page) return false;

      setIsSaving(true);
      setSaveStatus('saving');
      setSaveError(null);

      try {
        const response = await apiClient.put<{ page: Page; version_token: number }>(
          `/pages/${page.id}`,
          {
            raw: markdown,
            frontmatter,
          },
          {
            'If-Match': String(versionToken),
          }
        );

        // Success: remain in the focused data-entry workspace and make the save
        // state visible in the sticky bar rather than hiding it in a toast-only flow.
        await queryClient.invalidateQueries({ queryKey: ['pages'] });
        await queryClient.invalidateQueries({ queryKey: ['search'] });
        pushToast({
          kind: 'success',
          message: 'Page saved.',
        });
        setLocalNotice({ kind: 'success', message: 'Page saved.' });
        setCurrentVersionToken(response.version_token ?? response.page?.version_token ?? versionToken + 1);
        setLastSavedAt(new Date().toISOString());
        setSaveStatus('saved');
        setIsDirty(false);
        refetchPage();
        refetchPageById();
        exitEditMode();
        return true;
      } catch (err: any) {
        if (err.statusCode === 409 && /already exists/i.test(err.message || '')) {
          const visibleErrorMsg = err.message || 'Duplicate title. Choose a unique title before saving.';
          setSaveStatus('error');
          setSaveError(visibleErrorMsg);
          setLocalNotice({
            kind: 'error',
            message: visibleErrorMsg,
            actionLabel: 'Retry',
            onAction: () => performSave(markdown, frontmatter, versionToken),
          });
          pushToast({ kind: 'error', message: visibleErrorMsg });
        } else if (err.statusCode === 409) {
          setSaveStatus('conflict');
          setSaveError('Conflict detected. Review the version conflict below before saving again.');
          // Conflict: fetch current version and show dialog + info toast
          try {
            const currentResponse = await apiClient.get<{ page: Page }>(`/pages/${page.id}`);
            setConflict({
              theirPage: currentResponse.page,
              yourMarkdown: markdown,
            });
            pushToast({
              kind: 'info',
              message: 'Conflict detected. Resolve below.',
            });
          } catch (fetchErr) {
            setSaveStatus('error');
            setSaveError('Failed to load current version. Please refresh and try again.');
            pushToast({
              kind: 'error',
              message: 'Failed to load current version.',
            });
          }
        } else {
          const errorMsg = err.message || 'Failed to save. Please try again.';
          const visibleErrorMsg = `Save failed: ${errorMsg}`;
          setSaveStatus('error');
          setSaveError(visibleErrorMsg);
          setLocalNotice({
            kind: 'error',
            message: visibleErrorMsg,
            actionLabel: 'Retry',
            onAction: () => performSave(markdown, frontmatter, versionToken),
          });
          pushToast({
            kind: 'error',
            message: visibleErrorMsg,
            actionLabel: 'Retry',
            onAction: () => performSave(markdown, frontmatter, versionToken),
          });
        }
        return false;
      } finally {
        setIsSaving(false);
      }
    },
    [page, refetchPage, refetchPageById, pushToast, queryClient, exitEditMode]
  );

  const handleConflictOverwrite = useCallback(async () => {
    if (!page || !editState || !conflict) return;
    // Guard against a double-click firing two overwrite PUTs (parity with handleSave).
    if (saveInFlightRef.current) return;
    saveInFlightRef.current = true;
    try {
      // Refetch the current version token so the overwrite carries a fresh If-Match.
      const current = await apiClient.get<{ page: Page }>(`/pages/${page.id}`);
      const ok = await performSave(
        editState.markdown,
        frontmatterFromMarkdown(editState.markdown),
        current.page.version_token,
      );
      // Only dismiss the conflict UI once the overwrite actually succeeded. On a
      // fresh conflict, performSave re-populates `conflict` with the latest
      // server version, so leaving it set keeps the dialog accurate.
      if (ok) setConflict(null);
    } catch (err: any) {
      setSaveError('Failed to resolve conflict. Please refresh and try again.');
    } finally {
      saveInFlightRef.current = false;
    }
  }, [page, editState, conflict, performSave]);

  const handleRenameUpdateAll = useCallback(async () => {
    if (!renameDialog) return;

    setIsSaving(true);
    setSaveError(null);

    try {
      // First save the page normally
      await performSave(editState!.markdown, frontmatterFromMarkdown(editState!.markdown), page!.version_token);

      // Then call rename endpoint
      await apiClient.post(`/pages/${renameDialog.pageId}/rename`, {
        new_title: renameDialog.newTitle,
        link_action: 'update_all',
      });

      setRenameDialog(null);
      refetchPage();
      refetchPageById();
    } catch (err: any) {
      setSaveError(err.message || 'Failed to rename. Please try again.');
    } finally {
      setIsSaving(false);
    }
  }, [renameDialog, editState, page, performSave, refetchPage, refetchPageById]);

  const handleRenameSkip = useCallback(async () => {
    if (!renameDialog) return;

    setIsSaving(true);
    setSaveError(null);

    try {
      // First save the page normally
      await performSave(editState!.markdown, frontmatterFromMarkdown(editState!.markdown), page!.version_token);

      // Then call rename endpoint with skip
      await apiClient.post(`/pages/${renameDialog.pageId}/rename`, {
        new_title: renameDialog.newTitle,
        link_action: 'skip',
      });

      setRenameDialog(null);
      refetchPage();
      refetchPageById();
    } catch (err: any) {
      setSaveError(err.message || 'Failed to rename. Please try again.');
    } finally {
      setIsSaving(false);
    }
  }, [renameDialog, editState, page, performSave, refetchPage, refetchPageById]);

  const handleCancel = useCallback(() => {
    if (isDirty && !window.confirm('Discard unsaved changes?')) return;
    exitEditMode();
  }, [isDirty, exitEditMode]);

  const handlePreviewToggle = useCallback(() => {
    setEditorMode((mode) => (mode === 'preview' ? 'hybrid' : 'preview'));
  }, []);

  const handleReadCopy = useCallback(async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      pushToast({ kind: 'success', message: 'Copied to clipboard.' });
    } catch {
      setLocalNotice({ kind: 'error', message: 'Copy failed. Check browser clipboard permissions and try again.' });
      pushToast({ kind: 'error', message: 'Copy failed. Check browser clipboard permissions and try again.' });
    }
  }, [pushToast]);

  // Content types drive the blog-vs-plain header decision below. Called here,
  // with the other hooks and BEFORE any early return, so hook order is stable
  // across renders (Rules of Hooks).
  const { data: contentTypes = [] } = useContentTypes();

  if (pageLoading) {
    return <div className="text-center text-slate-500">Loading...</div>;
  }

  if (!page || !parsedPage) {
    return <div className="text-center text-slate-500">Page not found</div>;
  }

  const visibleFrontmatter = editState?.frontmatter ?? (page.frontmatter as Frontmatter | undefined) ?? (parsedPage.frontmatter as Frontmatter);
  const metadataSummary = typeof (visibleFrontmatter as any)?.summary === 'string' ? (visibleFrontmatter as any).summary : null;
  const readCopyableEntries = extractCopyableEntries(page).filter((entry) => entry.source === 'frontmatter');
  const visibleStatus = typeof visibleFrontmatter?.status === 'string' ? visibleFrontmatter.status : (page.status ?? 'draft');
  const visibleTopic = topicForPage({ ...page, frontmatter: visibleFrontmatter as Record<string, unknown> }, topicLookup)
    ?? frontmatterString({ ...page, frontmatter: visibleFrontmatter as Record<string, unknown> }, 'topic')
    ?? '';
  const propertyEntries = visiblePropertyEntries(visibleFrontmatter);
  const statusTone = visibleStatus === 'published' ? 'published' : 'draft';

  // Blog-style presentation for publishing-group types (blog-post, series,
  // release-note), or any item that carries a cover/author. Such items get an
  // article header — cover banner + "By X · date · N min read" — instead of the
  // plain "Updated <date>" line. (contentTypes is fetched above the early
  // returns — see the hook near pageLoading — to satisfy the Rules of Hooks.)
  const blogLike = {
    body_markdown: page.body_markdown,
    updated_at: page.updated_at,
    published_at: page.published_at,
    authors: page.authors,
    frontmatter: visibleFrontmatter as Record<string, unknown>,
    type: page.type,
  };
  const cover = coverImageOf(blogLike);
  const articleAuthors = authorsOf(blogLike);
  const articleSeries = seriesOf(blogLike);
  const isArticle =
    resolveContentTypeMeta(page.type, contentTypes)?.groupKey === 'publishing' ||
    Boolean(cover) ||
    articleAuthors.length > 0;
  const articleDate = formatDate(displayDateOf(blogLike));

  // Table of contents for the right context pane — parsed from the body's
  // headings (H1–H3 in source; ids match ReadView's rendered heading anchors).
  // Plain computation (not a hook): this runs after PageView's early returns.
  const toc: TocEntry[] = (() => {
    const body = page?.body_markdown ?? '';
    const out: TocEntry[] = [];
    let inFence = false;
    for (const raw of body.split('\n')) {
      const line = raw.trimEnd();
      if (/^\s*```/.test(line)) { inFence = !inFence; continue; }
      if (inFence) continue;
      const m = /^(#{1,3})\s+(.+?)\s*#*$/.exec(line);
      if (!m) continue;
      const text = m[2]!.replace(/[`*_~]/g, '').trim();
      if (text) out.push({ depth: m[1]!.length, text, id: headingSlug(text) });
    }
    return out;
  })();

  // Object properties for the pane — core meta first, then any other frontmatter.
  const paneProperties: PaneProperty[] = (() => {
    const fm = (visibleFrontmatter ?? {}) as Record<string, unknown>;
    const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
    const out: PaneProperty[] = [
      { label: 'Type', value: page.type || '—' },
      { label: 'Status', value: visibleStatus },
      { label: 'Space', value: visibleTopic || '—' },
      { label: 'Updated', value: new Date(page.updated_at).toLocaleDateString() },
    ];
    const visibility = str(fm['visibility']);
    const owner = str(fm['owner']);
    const source = str(fm['source']);
    if (visibility) out.push({ label: 'Visibility', value: visibility });
    if (owner) out.push({ label: 'Owner', value: owner });
    if (source) out.push({ label: 'Source', value: source, mono: true });
    const shown = new Set(['Type', 'Status', 'Space', 'Topic', 'Updated', 'Visibility', 'Owner', 'Source', 'Title', 'Summary']);
    for (const [key, value] of propertyEntries) {
      const label = propertyLabel(key);
      if (shown.has(label)) continue;
      out.push({ label, value });
    }
    return out;
  })();

  const scrollToHeading = (id: string) => {
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  const saveStatusText = isSaving
    ? 'Saving item…'
    : saveStatus === 'saved'
      ? `Saved${lastSavedAt ? ` ${new Date(lastSavedAt).toLocaleTimeString()}` : ''}`
      : saveStatus === 'error'
        ? 'Save failed'
        : saveStatus === 'conflict'
          ? 'Conflict needs attention'
          : isDirty
            ? 'Unsaved changes'
            : 'Ready to edit';

  return (
    <div className="kp-pageview" data-mode={isEditing ? 'edit' : 'read'} data-rail-collapsed={railCollapsed ? 'true' : 'false'}>
      {/* PageChrome: breadcrumb, title, metadata, edit/save button */}
      <PageChrome
        pageTitle={page.title}
        slug={page.slug}
        isEditing={isEditing}
        canEdit={canWrite}
        onEnterEditMode={enterEditMode}
        onSave={handleSave}
        onCancel={handleCancel}
        isSaving={isSaving}
        updatedAt={page.updated_at}
        status={page.status}
        isDirty={isDirty}
      />

      {/* Responsive grid: single column mobile, three-pane at >=1280px */}
      <div className="kp-pageview-grid">
        {/* Body: editor fills this cell completely */}
        <article className="kp-pageview-body">
          {!isEditing ? (
            <div
              className="kp-page-hero"
              style={{
                padding: 'var(--kp-space-6) var(--kp-content-pad) var(--kp-space-3)',
                background: 'var(--kp-surface-base)',
              }}
            >
              {isArticle && cover ? (
                <img
                  src={cover}
                  alt=""
                  loading="lazy"
                  style={{
                    width: '100%',
                    maxHeight: '340px',
                    objectFit: 'cover',
                    borderRadius: 'var(--kp-radius-lg)',
                    marginBottom: 'var(--kp-space-4)',
                    background: 'var(--kp-surface-sunken)',
                  }}
                />
              ) : null}
              {(page.type || visibleTopic) && (
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    flexWrap: 'wrap',
                    gap: 'var(--kp-space-2)',
                    marginBottom: 'var(--kp-space-3)',
                  }}
                >
                  {page.type ? <ContentTypeBadge type={page.type} /> : null}
                  {visibleTopic ? (
                    <span style={{ fontSize: 'var(--kp-text-sm)', color: 'var(--kp-text-secondary)' }}>
                      in <span style={{ color: 'var(--kp-text-primary)', fontWeight: 'var(--kp-weight-medium)' }}>{visibleTopic}</span>
                    </span>
                  ) : null}
                </div>
              )}
              <h1
                style={{
                  margin: 0,
                  fontFamily: 'var(--kp-font-ui)',
                  fontSize: 'var(--kp-text-3xl)',
                  fontWeight: 'var(--kp-weight-bold)',
                  letterSpacing: 'var(--kp-tracking-tight)',
                  lineHeight: 'var(--kp-leading-tight)',
                  color: 'var(--kp-text-primary)',
                }}
              >
                {page.title || 'Untitled'}
              </h1>
              {metadataSummary ? (
                <p
                  style={{
                    margin: 'var(--kp-space-3) 0 0',
                    fontSize: 'var(--kp-text-md)',
                    lineHeight: 'var(--kp-leading-snug)',
                    color: 'var(--kp-text-secondary)',
                    maxWidth: '68ch',
                  }}
                >
                  {metadataSummary}
                </p>
              ) : null}
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  flexWrap: 'wrap',
                  gap: 'var(--kp-space-2)',
                  marginTop: 'var(--kp-space-4)',
                  fontSize: 'var(--kp-text-sm)',
                  color: 'var(--kp-text-muted)',
                }}
              >
                <span
                  style={{
                    fontSize: 'var(--kp-text-xs)',
                    fontWeight: 'var(--kp-weight-semibold)',
                    padding: '2px 9px',
                    borderRadius: 'var(--kp-radius-pill)',
                    color: statusTone === 'published' ? 'var(--kp-success)' : 'var(--kp-text-secondary)',
                    background: statusTone === 'published' ? 'var(--kp-success-bg)' : 'var(--kp-surface-sunken)',
                  }}
                >
                  {statusTone === 'published' ? 'Published' : 'Draft'}
                </span>
                {isArticle ? (
                  <>
                    {articleSeries ? <span>· Series: {articleSeries}</span> : null}
                    {articleAuthors.length ? <span>· By {articleAuthors.join(', ')}</span> : null}
                    {articleDate ? <span>· {articleDate}</span> : null}
                    <span>· {readingTimeMinutes(page.body_markdown)} min read</span>
                  </>
                ) : (
                  page.updated_at && <span>· Updated {new Date(page.updated_at).toLocaleDateString()}</span>
                )}
              </div>
            </div>
          ) : null}

          {isEditing && editState ? (
            <>
              <div className="kp-edit-titlebar">
                <label className="kp-edit-titlebar-label" htmlFor="kp-edit-title-input">
                  Title
                </label>
                <input
                  id="kp-edit-title-input"
                  ref={titleInputRef}
                  className="kp-edit-titlebar-input"
                  value={titleFromEditState(editState, page.title)}
                  placeholder="Untitled"
                  onChange={(event) => {
                    const nextTitle = event.target.value;
                    setEditState((previous) => {
                      if (!previous) return previous;
                      const previousTitle = titleFromEditState(previous, page.title);
                      return {
                        markdown: syncFirstHeadingWithTitle(previous.markdown, previousTitle, nextTitle).markdown,
                        frontmatter: { ...previous.frontmatter, title: nextTitle } as Frontmatter,
                      };
                    });
                    setSaveError(null);
                    setIsDirty(true);
                    setSaveStatus('dirty');
                  }}
                />

                <div className="kp-edit-header-meta" role="region" aria-label="Item metadata">
                  <label className="kp-edit-topic-select">
                    <span>Space</span>
                    <select
                      value={visibleTopic}
                      onChange={(event) => {
                        const nextTopic = event.target.value;
                        setEditState((previous) => {
                          if (!previous) return previous;
                          const parsedPrevious = parse(previous.markdown);
                          const frontmatter = withCanonicalTopic(previous.frontmatter, nextTopic);
                          return {
                            markdown: buildRawMarkdown(frontmatter, parsedPrevious.body),
                            frontmatter,
                          };
                        });
                        setSaveError(null);
                        setIsDirty(true);
                        setSaveStatus('dirty');
                      }}
                    >
                      <option value="">No topic</option>
                      {topics.map((topic) => (
                        <option key={topic.id} value={displayTopic(topic)}>{displayTopic(topic)}</option>
                      ))}
                      {visibleTopic && !topics.some((topic) => displayTopic(topic) === visibleTopic) ? (
                        <option value={visibleTopic}>{displayFromSlug(visibleTopic)}</option>
                      ) : null}
                    </select>
                  </label>
                  <span
                    className={`kp-item-status-chip kp-item-status-chip--${statusTone}`}
                    aria-label={`Item status: ${visibleStatus}`}
                    title={`Status: ${visibleStatus}`}
                  >
                    <span className="kp-item-status-chip-dot" aria-hidden="true" />
                    <span>{visibleStatus}</span>
                  </span>
                  {metadataSummary && <p className="kp-edit-metadata-summary">{metadataSummary}</p>}
                </div>
              </div>

              <div
                className="kp-edit-editor-frame"
                onKeyDownCapture={(event) => {
                  if (event.metaKey || event.ctrlKey || event.altKey) return;
                  if (event.key.length === 1 || event.key === 'Backspace' || event.key === 'Delete') {
                    setIsDirty(true);
                    setSaveStatus('dirty');
                    setSaveError(null);
                  }
                }}
                onInputCapture={() => {
                  setIsDirty(true);
                  setSaveStatus('dirty');
                  setSaveError(null);
                }}
              >
                <ItemEditorHost
                value={editState.markdown}
                mode={editorMode}
                hostServices={itemEditorHostServices}
                propertySchema={itemEditorPropertySchema}
                frontmatterDisplay="hidden"
                onChange={(fullDoc) => {
                  setEditState((previous) => {
                    const parsedNext = parse(fullDoc);
                    const nextFrontmatter = parsedNext.frontmatter as Frontmatter;

                    if (!previous) {
                      return { markdown: fullDoc, frontmatter: nextFrontmatter };
                    }

                    const previousParsed = parse(previous.markdown);
                    const bodyChanged = parsedNext.body !== previousParsed.body;
                    // Hybrid/WYSIWYG body edits can emit a frontmatter block from
                    // the editor's previous internal document. Preserve the
                    // first-class titlebar value when the body changed so typing
                    // in the body cannot revert Title back to Untitled.
                    const needsTitleOverride =
                      bodyChanged && previous.frontmatter.title !== undefined;
                    const mergedFrontmatter = (
                      needsTitleOverride
                        ? { ...nextFrontmatter, title: previous.frontmatter.title }
                        : nextFrontmatter
                    ) as Frontmatter;

                    return {
                      // Common typing path: keep the editor's own emitted document
                      // verbatim. Re-stringifying via buildRawMarkdown on every
                      // keystroke churned the YAML frontmatter and risked cursor
                      // resets — only rebuild when we must force the title back on.
                      markdown: needsTitleOverride
                        ? buildRawMarkdown(mergedFrontmatter, parsedNext.body)
                        : fullDoc,
                      frontmatter: mergedFrontmatter,
                    };
                  });
                  setIsDirty(true);
                  setSaveStatus('dirty');
                }}
                onModeChange={setEditorMode}
                onSaveShortcut={handleSave}
                onCancelShortcut={handleCancel}
                onDiagnostics={(diagnostics) => {
                  const firstError = diagnostics.find((diagnostic) => diagnostic.severity === 'error');
                  if (firstError) {
                    setSaveError(firstError.message);
                  }
                }}
                />
              </div>

              <section
                className={`kp-edit-savebar kp-edit-savebar--${saveStatus}`}
                aria-label="Item save status"
                aria-live="polite"
              >
                <div className="kp-edit-savebar-status">
                  <strong>{saveStatusText}</strong>
                  <span>{editorMode === 'preview' ? 'Previewing rendered Markdown' : 'Editing Markdown body'}</span>
                  {saveError && <p>{saveError}</p>}
                </div>
                <div className="kp-edit-savebar-actions">
                  <button type="button" className="kp-edit-secondary-action" onClick={handlePreviewToggle} disabled={isSaving}>
                    <Icon icon={appIcons.eye} />
                    <span>{editorMode === 'preview' ? 'Edit' : 'Preview'}</span>
                  </button>
                  <button type="button" className="kp-edit-secondary-action" onClick={handleCancel} disabled={isSaving}>
                    <Icon icon={appIcons.xmark} />
                    <span>Cancel</span>
                  </button>
                  <button type="button" className="kp-edit-primary-action" onClick={handleSave} disabled={isSaving}>
                    {isSaving ? (
                      'Saving…'
                    ) : (
                      <>
                        <Icon icon={appIcons.floppyDisk} />
                        <span>Save</span>
                      </>
                    )}
                  </button>
                </div>
              </section>
            </>
          ) : (
            <>
              {readCopyableEntries.length > 0 ? (
                <section className="kp-copyable-panel" aria-label="Copyable content">
                  <div className="kp-copyable-panel-header">
                    <p className="kp-copyable-eyebrow">Copyable content</p>
                    <h2>Quick copy</h2>
                  </div>
                  <div className="kp-copyable-list">
                    {readCopyableEntries.map((entry) => (
                      <button
                        key={`${entry.label}:${entry.value}`}
                        type="button"
                        className="kp-copyable-entry"
                        onClick={() => void handleReadCopy(entry.value)}
                        title={entry.value}
                        aria-label={`Copy ${entry.label}`}
                      >
                        <span className="kp-copyable-entry-label">{entry.label}</span>
                        <code>{entry.value}</code>
                        <Icon icon={appIcons.copy} />
                      </button>
                    ))}
                  </div>
                </section>
              ) : null}
              <ReadView markdown={page.body_markdown ?? ''} knownSlugs={knownSlugs} />
            </>
          )}
        </article>

        {/* Right context pane: TOC / Properties / Tags — Obsidian-style, scrolls
            independently from the article. Backlinks live under the Tags tab. */}
        <aside className="kp-pageview-rail">
          <RightContextPane
            toc={toc}
            properties={paneProperties}
            tags={page.tags ?? []}
            collapsed={railCollapsed}
            onToggleCollapsed={() => setRailCollapsed((v) => !v)}
            onScrollTo={scrollToHeading}
            onTagClick={(tag) => navigate({ to: '/browse', search: { view: 'grouped', tag } as any })}
            relatedSlot={page ? <BacklinksPanel pageId={page.id} pageTitle={page.title} /> : null}
          />
        </aside>
      </div>

      {localNotice && (
        <div className="kp-local-notice" role={localNotice.kind === 'error' ? 'alert' : 'status'}>
          <span>{localNotice.message}</span>
          {localNotice.actionLabel && localNotice.onAction && (
            <button
              type="button"
              onClick={() => {
                const action = localNotice.onAction;
                setLocalNotice(null);
                action?.();
              }}
            >
              {localNotice.actionLabel}
            </button>
          )}
        </div>
      )}

      {/* Conflict Dialog with improved version info */}
      {conflict && editState && (
        <ConflictDialog
          yourVersion={editState.markdown}
          theirVersion={conflict.theirPage.body_markdown}
          theirPage={conflict.theirPage}
          yourUpdatedAt={new Date().toISOString()}
          theirUpdatedAt={conflict.theirPage.updated_at}
          onOverwrite={handleConflictOverwrite}
          onCancel={() => setConflict(null)}
          isLoading={isSaving}
        />
      )}

      {/* Rename Dialog */}
      {renameDialog && (
        <RenameDialog
          oldTitle={renameDialog.oldTitle}
          newTitle={renameDialog.newTitle}
          affectedCount={renameDialog.affectedCount}
          onUpdateAll={handleRenameUpdateAll}
          onSkip={handleRenameSkip}
          onCancel={() => setRenameDialog(null)}
          isLoading={isSaving}
        />
      )}
    </div>
  );
}
