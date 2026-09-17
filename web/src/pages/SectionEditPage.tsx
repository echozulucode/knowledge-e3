/**
 * SectionEditPage — `/admin/sections/new` and `/admin/sections/$slug`
 * (the admin UX review §4.1).
 *
 * A page, not a dialog: nine fields and growing, fields that depend on each
 * other (Slot only changes anything on the front page and portal topics), and a
 * live preview that has to sit beside the form. A page is also linkable.
 *
 * Every reference is PICKED, never typed: the content type from the registry,
 * the topic from `useTopics`, tags from `useTags(q)` (a new tag is allowed —
 * tags are emergent — with a note that it matches nothing yet). The old grid
 * took all three as free text, and a typo produced a section that silently
 * matched nothing.
 *
 * Save model: one section over the whole-list `PUT /sections`
 * (`useSaveSection`): re-fetch, check this entry is still what the page
 * loaded, replace it, write. If someone else changed it meanwhile the admin is
 * asked — Reload theirs or Overwrite with mine — instead of silently losing one
 * of the two edits. The slug is derived from the name on create and locked
 * behind "Change URL" on edit, because changing it breaks every existing
 * `/sections/<slug>` link.
 *
 * The preview asks `/pages` for exactly what the site resolves (published
 * items, the same filters, newest first) and shows the real match count, so
 * "matches nothing" — the state in which the site hides a section — is visible
 * before saving, as a warning that never blocks.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { ContentTypeBadge, ItemCard, itemPreview } from '@echozedlabs/ui';
import type { SectionSlot } from '@echozedlabs/knowledge-types';
import { AdminPageHeader } from '../components/admin/AdminPageHeader.js';
import { ConfirmDialog } from '../components/admin/ConfirmDialog.js';
import { EditPageLayout } from '../components/admin/EditPageLayout.js';
import { EmptyState } from '../components/admin/EmptyState.js';
import { FormField } from '../components/admin/FormField.js';
import { FormSection } from '../components/admin/FormSection.js';
import { ReferencePicker } from '../components/admin/ReferencePicker.js';
import { StatusChip } from '../components/admin/StatusChip.js';
import { itemHref, itemSlugLink } from '../components/itemLink.js';
import { pushToast } from '../hooks/useToast.js';
import { SLOT_OPTIONS, pickHomeTopic } from '../features/topic/slots.js';
import { useSiteConfig, type TopicListEntry } from '../features/topic/queries.js';
import {
  SectionSaveConflict,
  useAccess,
  useAnonymousMatchCount,
  useContentTypes,
  usePagesWithTotal,
  useSaveSection,
  useSections,
  useTags,
  useTopics,
  useUpdateSections,
  type ContentType,
  type Page,
  type Section,
  type TaxonomyTag,
} from '../queries.js';
import {
  SECTION_LIMIT_MAX,
  SECTION_LIMIT_MIN,
  appearsOn,
  deleteConsequences,
  draftFromSection,
  duplicateDraft,
  findContentTypeLabel,
  findTopic,
  hasProblems,
  leadSlug,
  matchFilters,
  moveInGroup,
  nextOrderInGroup,
  placementKey,
  placementName,
  positionLabel,
  removeSection,
  restoreSection,
  sectionFromDraft,
  slotApplies,
  slotOptionLabel,
  slugifySection,
  upsertSection,
  validateSection,
  type SectionDraft,
  type TopicRef,
} from './sectionsAdminModel.js';
import { SectionsSubnav } from './SectionsAdmin.js';
import './SectionsAdmin.css';
import './SectionEditPage.css';

const PREVIEW_ITEMS = 5;
const PREVIEW_DEBOUNCE_MS = 300;

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

function previewOf(page: Page): string | null {
  const fm = page.frontmatter as Record<string, unknown> | undefined;
  const str = (key: string) => (fm && typeof fm[key] === 'string' ? (fm[key] as string) : null);
  return itemPreview({ description: str('description'), summary: str('summary'), body: page.body_markdown });
}

/**
 * Stored values in the shape the pickers choose them: a type as its registry
 * label, a topic id as its slug. Applied to the INITIAL draft too, so opening a
 * section saved as `faq` does not count as an unsaved change.
 */
function canonicalDraft(draft: SectionDraft, types: readonly ContentType[] | undefined, topics: readonly TopicRef[]): SectionDraft {
  return {
    ...draft,
    type: findContentTypeLabel(draft.type, types) ?? draft.type,
    space: findTopic(draft.space, topics)?.slug ?? draft.space,
  };
}

type Conflict = { kind: 'changed' | 'deleted'; current: Section | undefined };

export function SectionEditPage(): JSX.Element {
  const navigate = useNavigate();
  const params = useParams({ strict: false }) as { slug?: string };
  const search = useSearch({ strict: false }) as { from?: unknown } | undefined;
  const routeSlug = params.slug ?? null;
  const fromSlug = typeof search?.from === 'string' ? search.from : null;

  const { data: sections, isLoading, isError, refetch } = useSections();
  const { data: topicsData, isLoading: topicsLoading } = useTopics();
  const { data: site } = useSiteConfig();
  const { data: contentTypes, isLoading: typesLoading } = useContentTypes();
  const { data: readMode } = useAccess();
  const save = useSaveSection();
  const update = useUpdateSections();

  const topics = useMemo<TopicRef[]>(() => (topicsData ?? []) as TopicListEntry[], [topicsData]);
  const homeTopicSlug = pickHomeTopic(topics, site?.home_topic)?.slug;
  const all = useMemo(() => sections ?? [], [sections]);

  // The section as loaded (null on create). Its `order` is kept current after
  // a Move on this page, so the stale check does not mistake our own move for
  // someone else's edit.
  const [loaded, setLoaded] = useState<Section | null>(null);
  const [initial, setInitial] = useState<SectionDraft | null>(null);
  const [draft, setDraft] = useState<SectionDraft | null>(null);
  const [slugTouched, setSlugTouched] = useState(false);
  const [slugUnlocked, setSlugUnlocked] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [tagQuery, setTagQuery] = useState('');
  const debouncedTagQuery = useDebounced(tagQuery, 200);
  const { data: tagOptions, isFetching: tagsFetching } = useTags(debouncedTagQuery);

  // Initialise once per route slug, when the lists it needs have answered —
  // never again on a refetch, which would wipe what the admin has typed. (The
  // effect-loop lesson from the old editor: key on identity that only changes
  // when the query answers anew, and guard with a ref.)
  const initialisedFor = useRef<string | null>(null);
  const ready = !isLoading && !topicsLoading && !typesLoading && sections !== undefined;
  const routeKey = routeSlug ?? `new:${fromSlug ?? ''}`;
  useEffect(() => {
    if (!ready || initialisedFor.current === routeKey) return;
    initialisedFor.current = routeKey;
    const existing = routeSlug ? all.find((s) => s.slug === routeSlug) : undefined;
    const source = !routeSlug && fromSlug ? all.find((s) => s.slug === fromSlug) : undefined;
    const base = existing ? draftFromSection(existing) : source ? duplicateDraft(source, all) : draftFromSection(undefined);
    const start = canonicalDraft(base, contentTypes, topics);
    setLoaded(existing ?? null);
    // A duplicate starts dirty: its prefilled fields are unsaved work, and
    // Create must be available without touching anything.
    setInitial(source ? canonicalDraft(draftFromSection(undefined), contentTypes, topics) : start);
    setDraft(start);
    setSlugTouched(Boolean(source));
    setSlugUnlocked(false);
    setAttempted(false);
    setSaveError(null);
  }, [ready, routeKey, routeSlug, fromSlug, all, contentTypes, topics]);

  const isNew = routeSlug === null;
  const notFound = ready && routeSlug !== null && initialisedFor.current === routeKey && !loaded && !save.isPending;
  const current = draft ?? draftFromSection(undefined);
  const effectiveSlug = current.slug || slugifySection(current.name);
  const originalSlug = loaded?.slug ?? null;
  const problems = validateSection(current, all, originalSlug);
  const isDirty = draft !== null && initial !== null && JSON.stringify(draft) !== JSON.stringify(initial);
  // Slug problems show at once (a clash is worth knowing while typing); the rest after a Save attempt.
  const shown = attempted ? problems : { slug: current.slug || current.name ? problems.slug : undefined };

  const placementChanged = loaded ? placementKey(loaded, topics) !== placementKey({ space: current.space }, topics) : true;
  const orderForSave = !loaded || placementChanged ? nextOrderInGroup(all.filter((s) => s.slug !== originalSlug), current.space, topics) : loaded.order;
  const draftSection = sectionFromDraft({ ...current, slug: effectiveSlug }, orderForSave);

  // Debounced by its JSON: `matchFilters` builds a new object every render, and
  // debouncing the object itself would re-arm the timer forever.
  const previewKey = useDebounced(JSON.stringify(matchFilters(draftSection)), PREVIEW_DEBOUNCE_MS);
  const previewFilters = useMemo(() => JSON.parse(previewKey) as ReturnType<typeof matchFilters>, [previewKey]);
  const limit = current.limit === '' ? undefined : current.limit;
  const preview = usePagesWithTotal({ ...previewFilters, sort: 'published', limit: PREVIEW_ITEMS }, { enabled: draft !== null });
  const total = preview.data?.total;
  const anonymous = useAnonymousMatchCount(previewFilters, { enabled: draft !== null && readMode === 'public' });

  const withDraft = upsertSection(all, originalSlug, draftSection);
  const isLead = leadSlug(withDraft, total === undefined ? undefined : { [draftSection.slug]: total }) === draftSection.slug;
  const position = loaded && !placementChanged ? positionLabel(loaded.slug, all, topics) : undefined;
  const chosenTopic = findTopic(current.space, topics);

  function patch(next: Partial<SectionDraft>) {
    setDraft((prev) => (prev ? { ...prev, ...next } : prev));
    setSaveError(null);
  }

  function onNameChange(name: string) {
    // On create the URL follows the name until the admin edits the URL itself.
    if (isNew && !slugTouched) patch({ name, slug: slugifySection(name) });
    else patch({ name });
  }

  async function doSave(force = false) {
    setAttempted(true);
    if (!draft) return;
    if (hasProblems(problems)) {
      const n = Object.values(problems).filter(Boolean).length;
      setSaveError(n === 1 ? '1 field needs attention.' : `${n} fields need attention.`);
      return;
    }
    setSaveError(null);
    try {
      const { saved } = await save.mutateAsync({ originalSlug, loaded, next: draftSection, force });
      setConflict(null);
      const savedDraft = canonicalDraft(draftFromSection(saved), contentTypes, topics);
      setLoaded(saved);
      setInitial(savedDraft);
      setDraft(savedDraft);
      setSlugUnlocked(false);
      setAttempted(false);
      pushToast({
        kind: 'success',
        message: `Section “${saved.name}” saved.`,
        action: { label: 'View on site', onAction: () => void navigate({ to: '/sections/$slug', params: { slug: saved.slug } }) },
      });
      if (saved.slug !== routeSlug) {
        // The new URL re-initialises the page from the list, which the save has
        // already put in the cache — so it opens on exactly what was stored.
        void navigate({ to: '/admin/sections/$slug', params: { slug: saved.slug }, replace: true, ignoreBlocker: true });
      }
    } catch (error) {
      if (error instanceof SectionSaveConflict) {
        if (error.kind === 'duplicate') {
          setSaveError(`Another section already uses /sections/${draftSection.slug}. Choose a different URL.`);
          void refetch();
        } else {
          setConflict({ kind: error.kind, current: error.current });
        }
        return;
      }
      setSaveError((error as { message?: string })?.message || 'The section could not be saved.');
    }
  }

  function reloadTheirs() {
    const theirs = conflict?.current;
    setConflict(null);
    void refetch();
    if (!theirs) {
      void navigate({ to: '/admin/sections', ignoreBlocker: true });
      return;
    }
    const start = canonicalDraft(draftFromSection(theirs), contentTypes, topics);
    setLoaded(theirs);
    setInitial(start);
    setDraft(start);
    setAttempted(false);
  }

  function move(delta: -1 | 1) {
    if (!loaded) return;
    const slug = loaded.slug;
    update.mutate((list) => moveInGroup(list, slug, delta, topics), {
      onSuccess: ({ before, after }) => {
        const moved = after.find((s) => s.slug === slug);
        setLoaded((prev) => (prev && moved ? { ...prev, ...(moved.order !== undefined ? { order: moved.order } : {}) } : prev));
        pushToast({
          kind: 'success',
          message: 'Position saved.',
          action: {
            label: 'Undo',
            onAction: () =>
              update.mutate(() => before, {
                onSuccess: ({ after: restored }) => {
                  const back = restored.find((s) => s.slug === slug);
                  setLoaded((prev) => (prev && back ? { ...prev, order: back.order } : prev));
                },
              }),
          },
        });
      },
      onError: () => pushToast({ kind: 'error', message: 'The position could not be saved.' }),
    });
  }

  async function doDelete() {
    if (!loaded) return;
    const removed = loaded;
    setDeleteError(null);
    try {
      await update.mutateAsync((list) => removeSection(list, removed.slug));
      setConfirmDelete(false);
      pushToast({
        kind: 'success',
        message: `Deleted “${removed.name}”.`,
        action: { label: 'Undo', onAction: () => update.mutate((list) => restoreSection(list, removed)) },
      });
      void navigate({ to: '/admin/sections', ignoreBlocker: true });
    } catch {
      setDeleteError('The section could not be deleted. Nothing was changed.');
    }
  }

  // ---- states before the form ------------------------------------------

  if (isError) {
    return (
      <main className="SectionEditPage" aria-labelledby="section-edit-title">
        <AdminPageHeader titleId="section-edit-title" title="Section" back={<Link to="/admin/sections">‹ Sections</Link>} />
        <EmptyState
          title="Sections could not be loaded"
          action={
            <button type="button" className="kp-admin-button" onClick={() => void refetch()}>
              Retry
            </button>
          }
        />
      </main>
    );
  }
  if (!draft) {
    return (
      <main className="SectionEditPage" aria-labelledby="section-edit-title" aria-busy="true">
        <AdminPageHeader titleId="section-edit-title" title={isNew ? 'New section' : 'Section'} back={<Link to="/admin/sections">‹ Sections</Link>} />
        <p role="status" className="SectionEditPage__muted">
          Loading…
        </p>
      </main>
    );
  }
  if (notFound) {
    return (
      <main className="SectionEditPage" aria-labelledby="section-edit-title">
        <AdminPageHeader titleId="section-edit-title" title="Section not found" back={<Link to="/admin/sections">‹ Sections</Link>} />
        <EmptyState
          title={`No section uses /sections/${routeSlug}`}
          body="It may have been renamed or deleted."
          action={
            <Link to="/admin/sections" className="kp-admin-button kp-admin-button--primary">
              Back to Sections
            </Link>
          }
        />
      </main>
    );
  }

  // ---- the form ---------------------------------------------------------

  const slugLocked = !isNew && !slugUnlocked;
  const slotVisible = slotApplies(current.space, topics, homeTopicSlug);
  const shows = total === undefined || limit === undefined ? undefined : Math.min(total, limit);

  const aside = (
    <div className="SectionEditPage__preview" aria-live="polite" aria-busy={preview.isFetching || undefined}>
      <div className="SectionEditPage__previewBlock">
        <h2 className="SectionEditPage__previewTitle">Appears on</h2>
        <ul className="SectionEditPage__appears">
          {appearsOn(draftSection, topics, homeTopicSlug, isLead).map((where) => (
            <li key={where}>{where}</li>
          ))}
          <li>
            Its own page, <code>/sections/{draftSection.slug || '…'}</code>
          </li>
        </ul>
      </div>
      <div className="SectionEditPage__previewBlock">
        <h2 className="SectionEditPage__previewTitle">Matches</h2>
        {preview.isError ? (
          <p className="SectionEditPage__muted">The preview could not be loaded.</p>
        ) : total === undefined ? (
          <p className="SectionEditPage__muted">Counting…</p>
        ) : total === 0 ? (
          <p className="SectionEditPage__zero">
            <StatusChip tone="warn" label="Matches no items" />
            <span>Hidden on the site until a published item matches. You can still save it.</span>
          </p>
        ) : (
          <p data-testid="section-preview-count">
            Matches {total} {total === 1 ? 'item' : 'items'} · shows {shows}
          </p>
        )}
        {readMode === 'public' && typeof anonymous.data === 'number' && total !== undefined && total > 0 ? (
          <p className="SectionEditPage__muted">
            Anonymous visitors see {anonymous.data}
            {anonymous.data < total ? ` (${total - anonymous.data} ${total - anonymous.data === 1 ? 'is' : 'are'} in private topics)` : ''}
          </p>
        ) : null}
        {chosenTopic?.visibility === 'private' ? (
          <p className="SectionEditPage__muted">{chosenTopic.name} is private: visitors who are not signed in do not see this section.</p>
        ) : null}
      </div>
      {preview.data && preview.data.items.length > 0 ? (
        <div className="SectionEditPage__previewItems">
          {preview.data.items.slice(0, Math.min(PREVIEW_ITEMS, limit ?? PREVIEW_ITEMS)).map((item) => (
            <ItemCard
              key={item.id}
              layout="stacked"
              title={item.title}
              href={itemHref(item.slug)}
              renderLink={itemSlugLink(item.slug)}
              preview={previewOf(item)}
              badges={item.type ? <ContentTypeBadge type={item.type} size="sm" /> : null}
              testId="section-preview-item"
            />
          ))}
        </div>
      ) : null}
    </div>
  );

  return (
    <main className="SectionEditPage" aria-label={isNew ? 'New section' : `Edit ${loaded?.name ?? 'section'}`}>
      <SectionsSubnav current="sections" />
      <EditPageLayout
        backTo="/admin/sections"
        backLabel="Sections"
        title={isNew ? 'New section' : loaded?.name || 'Section'}
        subtitle={!isNew && loaded ? <code>/sections/{loaded.slug}</code> : undefined}
        isDirty={isDirty}
        isSaving={save.isPending}
        canSave={isDirty}
        saveLabel={isNew ? 'Create section' : 'Save section'}
        onSave={() => void doSave()}
        onCancel={() => void navigate({ to: '/admin/sections' })}
        aside={aside}
        errorSummary={saveError}
        dangerZone={
          !isNew ? (
            <FormSection title="Danger zone" tone="danger">
              <p className="SectionEditPage__muted">Deleting removes the section from the site at once. Links to /sections/{loaded?.slug} stop working.</p>
              <button
                type="button"
                className="kp-admin-button SectionEditPage__danger"
                onClick={() => {
                  setDeleteError(null);
                  setConfirmDelete(true);
                }}
              >
                Delete section…
              </button>
            </FormSection>
          ) : undefined
        }
      >
        <FormSection title="Basics">
          <FormField label="Name" htmlFor="section-name" required error={shown.name}>
            {(control) => <input {...control} className="SectionEditPage__input" value={current.name} onChange={(e) => onNameChange(e.target.value)} autoComplete="off" />}
          </FormField>
          <FormField
            label="URL"
            htmlFor="section-slug"
            error={shown.slug}
            helper={
              slugLocked ? undefined : isNew ? (
                'Made from the name. Lowercase letters, numbers and hyphens.'
              ) : (
                <span className="SectionEditPage__warn">Changing the URL breaks existing links to /sections/{loaded?.slug}.</span>
              )
            }
          >
            {(control) => (
              <div className="SectionEditPage__slugRow">
                <span className="SectionEditPage__slugPrefix" aria-hidden="true">
                  /sections/
                </span>
                <input
                  {...control}
                  className="SectionEditPage__input"
                  value={current.slug}
                  readOnly={slugLocked}
                  onChange={(e) => {
                    setSlugTouched(true);
                    patch({ slug: e.target.value });
                  }}
                  onBlur={() => patch({ slug: slugifySection(current.slug) })}
                  autoComplete="off"
                  spellCheck={false}
                />
                {slugLocked ? (
                  <button type="button" className="kp-admin-button" onClick={() => setSlugUnlocked(true)}>
                    Change URL
                  </button>
                ) : null}
              </div>
            )}
          </FormField>
          <FormField label="Description" htmlFor="section-description" helper="One line, shown above the items.">
            {(control) => <textarea {...control} className="SectionEditPage__input" rows={2} value={current.description} onChange={(e) => patch({ description: e.target.value })} />}
          </FormField>
        </FormSection>

        <FormSection title="What it shows" aside="The filters combine">
          <FormField label="Content type" htmlFor="section-type" helper="Only items of this type. Any type when unset.">
            {(control) => (
              <ReferencePicker<ContentType>
                id={control.id}
                aria-describedby={control['aria-describedby']}
                options={contentTypes ?? []}
                loading={typesLoading}
                getKey={(t) => t.label}
                getLabel={(t) => t.label}
                emptyOption={{ label: 'Any type' }}
                value={current.type}
                onChange={(type) => patch({ type })}
                invalidValueMessage={(v) => `“${v}” is not a registered content type; the section still matches items typed exactly that.`}
                placeholder="Any type"
              />
            )}
          </FormField>
          <FormField label="Topic" htmlFor="section-topic" helper="A section with no topic spans every topic and appears on the front page.">
            {(control) => (
              <ReferencePicker<TopicRef>
                id={control.id}
                aria-describedby={control['aria-describedby']}
                options={topics}
                loading={topicsLoading}
                getKey={(t) => t.slug}
                getLabel={(t) => t.name}
                renderOption={(t) => (
                  <span className="SectionEditPage__topicOption">
                    <span>{t.name}</span>
                    <span className="SectionEditPage__muted">
                      {[t.presentation, t.visibility === 'private' ? 'private' : undefined].filter(Boolean).join(' · ')}
                    </span>
                  </span>
                )}
                emptyOption={{ label: 'All topics (front page)' }}
                value={current.space}
                onChange={(space) => patch({ space })}
                invalidValueMessage={(v) => `Topic “${v}” was not found. The section shows nowhere until you choose another.`}
                placeholder="All topics (front page)"
              />
            )}
          </FormField>
          <FormField label="Tags" htmlFor="section-tags" helper="Matches items with any of these tags. A new tag matches nothing until items carry it.">
            {(control) => (
              <ReferencePicker<TaxonomyTag>
                id={control.id}
                aria-describedby={control['aria-describedby']}
                multiple
                options={tagOptions ?? []}
                loading={tagsFetching}
                onQueryChange={setTagQuery}
                getKey={(t) => t.slug}
                getLabel={(t) => t.name}
                renderOption={(t) => (
                  <span className="SectionEditPage__topicOption">
                    <span>{t.name}</span>
                    <span className="SectionEditPage__muted">{t.count}</span>
                  </span>
                )}
                allowCreate
                value={current.tags}
                onChange={(tags) => patch({ tags })}
                placeholder={current.tags.length ? 'Add a tag…' : 'Any tags'}
              />
            )}
          </FormField>
        </FormSection>

        <FormSection title="Where and how much">
          {slotVisible ? (
            <FormField
              label="Slot"
              htmlFor="section-slot"
              helper={current.space ? 'On this topic’s landing, a slot places the section under a fixed heading.' : 'Below the front page’s lead, a slot places the section under a fixed heading.'}
            >
              {(control) => (
                <select {...control} className="SectionEditPage__input" value={current.slot} onChange={(e) => patch({ slot: e.target.value as SectionSlot })}>
                  {SLOT_OPTIONS.map((slot) => (
                    <option key={slot} value={slot}>
                      {slotOptionLabel(slot)}
                    </option>
                  ))}
                </select>
              )}
            </FormField>
          ) : null}
          <FormField label="Max items" htmlFor="section-limit" labelHint={`(${SECTION_LIMIT_MIN}–${SECTION_LIMIT_MAX})`} error={shown.limit}>
            {(control) => (
              <div className="SectionEditPage__stepper">
                <button
                  type="button"
                  className="kp-admin-button"
                  aria-label="Fewer items"
                  disabled={current.limit !== '' && current.limit <= SECTION_LIMIT_MIN}
                  onClick={() => patch({ limit: Math.max(SECTION_LIMIT_MIN, (current.limit === '' ? SECTION_LIMIT_MIN + 1 : current.limit) - 1) })}
                >
                  −
                </button>
                <input
                  {...control}
                  className="SectionEditPage__input SectionEditPage__number"
                  type="number"
                  inputMode="numeric"
                  min={SECTION_LIMIT_MIN}
                  max={SECTION_LIMIT_MAX}
                  step={1}
                  value={current.limit}
                  onChange={(e) => patch({ limit: e.target.value === '' ? '' : Number(e.target.value) })}
                />
                <button
                  type="button"
                  className="kp-admin-button"
                  aria-label="More items"
                  disabled={current.limit !== '' && current.limit >= SECTION_LIMIT_MAX}
                  onClick={() => patch({ limit: Math.min(SECTION_LIMIT_MAX, (current.limit === '' ? SECTION_LIMIT_MIN - 1 : current.limit) + 1) })}
                >
                  +
                </button>
              </div>
            )}
          </FormField>
          <div className="SectionEditPage__position" role="group" aria-labelledby="section-position-label">
            <span id="section-position-label" className="SectionEditPage__positionLabel">
              Position
            </span>
            {position ? (
              <>
                <span data-testid="section-position">{position.label}</span>
                <span className="SectionEditPage__positionActions">
                  <button type="button" className="kp-admin-button" onClick={() => move(-1)} disabled={position.index === 0 || update.isPending}>
                    Move up
                  </button>
                  <button type="button" className="kp-admin-button" onClick={() => move(1)} disabled={position.index >= position.count - 1 || update.isPending}>
                    Move down
                  </button>
                </span>
                {position.count > 1 && (position.index === 0 || position.index >= position.count - 1) ? (
                  <span className="SectionEditPage__muted">{position.index === 0 ? 'Already first.' : 'Already last.'}</span>
                ) : null}
              </>
            ) : (
              <span className="SectionEditPage__muted">
                {isNew ? `Added last on ${placementName(current.space, topics)} when created.` : `Moves to the end of ${placementName(current.space, topics)} when saved.`}
              </span>
            )}
          </div>
        </FormSection>
      </EditPageLayout>

      {conflict ? (
        <ConfirmDialog
          title={conflict.kind === 'deleted' ? 'This section was deleted since you opened it' : 'This section changed since you opened it'}
          body={
            <>
              <p>
                {conflict.kind === 'deleted'
                  ? 'Someone deleted it while you were editing. Saving puts your version back.'
                  : 'Someone saved a different version while you were editing. Overwriting replaces their changes with yours.'}
              </p>
              <button type="button" className="kp-admin-button" onClick={reloadTheirs}>
                {conflict.kind === 'deleted' ? 'Discard mine and go back' : 'Discard mine and reload theirs'}
              </button>
            </>
          }
          confirmLabel={conflict.kind === 'deleted' ? 'Save it again' : 'Overwrite with mine'}
          tone="danger"
          pending={save.isPending}
          onConfirm={() => void doSave(true)}
          onCancel={() => setConflict(null)}
        />
      ) : null}

      {confirmDelete && loaded ? (
        <ConfirmDialog
          title={`Delete “${loaded.name}”?`}
          body="The section is removed from the site straight away. You can undo from the message that follows."
          consequences={deleteConsequences(loaded, topics, homeTopicSlug, leadSlug(all) === loaded.slug)}
          confirmLabel="Delete section"
          tone="danger"
          pending={update.isPending}
          error={deleteError}
          onConfirm={() => void doDelete()}
          onCancel={() => setConfirmDelete(false)}
        />
      ) : null}
    </main>
  );
}
