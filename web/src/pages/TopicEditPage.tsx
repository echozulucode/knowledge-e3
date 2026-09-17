/**
 * TopicEditPage — `/admin/topics/$slug` (the admin UX review §4.5).
 *
 * A page, not a dialog: the old rename dialog had grown to seven fields, some
 * of which only make sense together (Start here is the landing's "Get started"
 * button; the landing text renders above the sections), and the landing
 * markdown needs room to write and a preview to check. A page is also linkable.
 *
 * Save model: ONE `PUT /topics/:id` carrying every field
 * (`useUpdateTopicPresentation`, whose input already takes name and
 * description). The old dialog sent two requests — name first, then the rest —
 * so a failure between them left a saved name beside an unsaved visibility
 * change; one request cannot. The server audits a visibility flip as
 * `space.visibility_change` from the same request.
 *
 * Visibility is the one exposure-widening choice here, so switching an
 * existing private topic to Public asks first, with the count of published
 * items that become readable (review §3.3). Narrowing to Private does not ask.
 * Either way nothing changes until Save.
 *
 * Start here is PICKED from this topic's published items (it used to be a typed
 * slug that silently led nowhere on a typo); a stored value that no longer
 * resolves, is a draft, or belongs to another topic is flagged, never blocked.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { AdminPageHeader } from '../components/admin/AdminPageHeader.js';
import { ConfirmDialog } from '../components/admin/ConfirmDialog.js';
import { EditPageLayout } from '../components/admin/EditPageLayout.js';
import { EmptyState } from '../components/admin/EmptyState.js';
import { FormField } from '../components/admin/FormField.js';
import { FormSection } from '../components/admin/FormSection.js';
import { ReferencePicker } from '../components/admin/ReferencePicker.js';
import { StatusChip } from '../components/admin/StatusChip.js';
import { ReadView } from '../components/ReadView.js';
import { pushToast } from '../hooks/useToast.js';
import type { ApiError } from '../api.js';
import { useUpdateTopicPresentation, type TopicListEntry } from '../features/topic/queries.js';
import { useSources } from '../features/sources/queries.js';
import { formatAge, lastSyncedAt, sourceStateChip, stateTone } from '../features/sources/sourcesAdminModel.js';
import { loadStartHereOptions, type StartHereOption } from '../features/topics-admin/queries.js';
import {
  PRESENTATION_CHOICES,
  archiveBlockedReason,
  archiveConsequences,
  draftFromTopic,
  isDraftDirty,
  makePublicConfirmation,
  markdownLength,
  plural,
  presentationLabel,
  sectionsOnLanding,
  sourceForTopic,
  startHereProblem,
  topicDisplayName,
  updateBodyFromDraft,
  validateTopicDraft,
  type TopicDraft,
} from '../features/topics-admin/topicsAdminModel.js';
import { useAccess, useArchiveTopic, usePageBySlug, useSections, useTopics } from '../queries.js';
import './TopicAdmin.css';
import './TopicEditPage.css';

export function TopicEditPage(): JSX.Element {
  const navigate = useNavigate();
  const params = useParams({ strict: false }) as { slug?: string };
  const routeSlug = params.slug ?? '';

  const { data: topicsData, isLoading, isError, refetch } = useTopics();
  const { data: readMode } = useAccess();
  const { data: sections, isLoading: sectionsLoading } = useSections();
  const sources = useSources();
  const save = useUpdateTopicPresentation();
  const archiveTopic = useArchiveTopic();

  const topic = useMemo(() => ((topicsData ?? []) as TopicListEntry[]).find((t) => t.slug === routeSlug), [topicsData, routeSlug]);

  const [initial, setInitial] = useState<TopicDraft | null>(null);
  const [draft, setDraft] = useState<TopicDraft | null>(null);
  const [attempted, setAttempted] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [confirmPublic, setConfirmPublic] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [archiveError, setArchiveError] = useState<string | null>(null);
  const [markdownTab, setMarkdownTab] = useState<'write' | 'preview'>('write');
  const [copyNote, setCopyNote] = useState<string | null>(null);

  // Initialise once per route slug, when the topic has answered — never again
  // on a refetch (a save invalidates `['topics']`), which would wipe what the
  // admin has typed since.
  const initialisedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!topic || initialisedFor.current === routeSlug) return;
    initialisedFor.current = routeSlug;
    const start = draftFromTopic(topic);
    setInitial(start);
    setDraft(start);
    setAttempted(false);
    setSaveError(null);
    setMarkdownTab('write');
  }, [topic, routeSlug]);

  const startHereSlug = draft?.start_here.trim() ?? '';
  const startHere = usePageBySlug(startHereSlug);
  const loadOptions = useCallback((query: string) => loadStartHereOptions(routeSlug, query), [routeSlug]);

  // ---- states before the form ------------------------------------------

  const back = <Link to="/admin/topics">‹ Topics</Link>;
  if (isError) {
    return (
      <main className="TopicEditPage" aria-labelledby="topic-edit-title">
        <AdminPageHeader titleId="topic-edit-title" title="Topic" back={back} />
        <EmptyState
          title="Topics could not be loaded"
          action={
            <button type="button" className="kp-admin-button" onClick={() => void refetch()}>
              Retry
            </button>
          }
        />
      </main>
    );
  }
  if (!isLoading && !topic) {
    return (
      <main className="TopicEditPage" aria-labelledby="topic-edit-title">
        <AdminPageHeader titleId="topic-edit-title" title="Topic not found" back={back} />
        <EmptyState
          title={`No topic uses /topics/${routeSlug}`}
          body="It may have been archived, or the link is out of date."
          action={
            <Link to="/admin/topics" className="kp-admin-button kp-admin-button--primary">
              Back to Topics
            </Link>
          }
        />
      </main>
    );
  }
  if (!topic || !draft || !initial) {
    return (
      <main className="TopicEditPage" aria-labelledby="topic-edit-title" aria-busy="true">
        <AdminPageHeader titleId="topic-edit-title" title="Topic" back={back} />
        <p role="status" className="TopicEditPage__muted">
          Loading…
        </p>
      </main>
    );
  }

  // ---- the form ---------------------------------------------------------

  const current = draft;
  const loadedTopic = topic;
  const isDirty = isDraftDirty(initial, current);
  const problems = validateTopicDraft(current);
  const length = markdownLength(current.landing_markdown);
  const landingSections = sectionsOnLanding(sections ?? [], loadedTopic);
  const source = sourceForTopic(sources.data, loadedTopic);
  const archiveReason = archiveBlockedReason(loadedTopic);
  const publicConfirmation = makePublicConfirmation(loadedTopic, readMode);
  const startHereMissing = startHere.isError && (startHere.error as unknown as ApiError | null)?.statusCode === 404;
  const startHereWarning = startHereProblem(startHereSlug, { item: startHere.data, missing: startHereMissing }, loadedTopic);
  const startHereTitle = startHere.data && startHere.data.slug === startHereSlug ? startHere.data.title : undefined;

  function patch(next: Partial<TopicDraft>) {
    setDraft((prev) => (prev ? { ...prev, ...next } : prev));
    setSaveError(null);
  }

  function chooseVisibility(value: TopicDraft['visibility']) {
    if (value === current.visibility) return;
    // Only widening a topic that is private AS SAVED asks: flipping back to the
    // saved Public after trying Private exposes nothing new.
    if (value === 'public' && initial?.visibility === 'private') {
      setConfirmPublic(true);
      return;
    }
    patch({ visibility: value });
  }

  async function doSave() {
    setAttempted(true);
    const n = Object.values(problems).filter(Boolean).length;
    if (n > 0) {
      setSaveError(n === 1 ? '1 field needs attention.' : `${n} fields need attention.`);
      return;
    }
    setSaveError(null);
    const body = updateBodyFromDraft(current);
    try {
      await save.mutateAsync({ id: loadedTopic.id, ...body });
      // What was sent is what is stored (the server trims nothing further), so
      // it becomes the clean state without waiting for the list to refetch.
      setInitial(body);
      setDraft(body);
      setAttempted(false);
      pushToast({
        kind: 'success',
        message: `Topic saved: ${body.name}`,
        action: { label: 'View landing page', onAction: () => void navigate({ to: '/topics/$slug', params: { slug: loadedTopic.slug } }) },
      });
    } catch (error) {
      setSaveError((error as { message?: string })?.message || 'The topic could not be saved.');
    }
  }

  async function doArchive() {
    setArchiveError(null);
    try {
      await archiveTopic.mutateAsync(loadedTopic.id);
      setConfirmArchive(false);
      pushToast({ kind: 'success', message: `Topic archived: ${topicDisplayName(loadedTopic)}` });
      void navigate({ to: '/admin/topics', ignoreBlocker: true });
    } catch (error) {
      setArchiveError((error as { message?: string })?.message || 'The topic could not be archived. Nothing was changed.');
    }
  }

  async function copySlug() {
    try {
      // Absent outside a secure context: a failure to report, not a crash.
      if (!navigator.clipboard) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(loadedTopic.slug);
      setCopyNote('Copied.');
    } catch {
      setCopyNote('Copy failed — select the slug and copy it by hand.');
    }
  }

  const shown = attempted ? problems : { landing_markdown: problems.landing_markdown };

  const aside = (
    <div className="TopicEditPage__preview" aria-live="polite">
      <div className="TopicEditPage__previewBlock">
        <h2 className="TopicEditPage__previewTitle">Landing page</h2>
        <p>
          <Link to="/topics/$slug" params={{ slug: loadedTopic.slug }} className="TopicEditPage__viewLink">
            View landing page
          </Link>
        </p>
        {isDirty ? <p className="TopicEditPage__muted">The live page changes when you save.</p> : null}
      </div>
      <dl className="TopicEditPage__summary">
        <dt>Presentation</dt>
        <dd>{presentationLabel(current.presentation)}</dd>
        <dt>Visitors</dt>
        <dd>{current.visibility === 'private' ? 'Signed-in users only' : 'Anyone who can read the site'}</dd>
        <dt>Get started</dt>
        <dd>{startHereSlug ? (startHereTitle ?? startHereSlug) : 'None'}</dd>
        <dt>Landing text</dt>
        <dd>{current.landing_markdown.trim() ? plural(length.count, 'character') : 'None'}</dd>
        <dt>Sections</dt>
        <dd>{sectionsLoading ? '…' : landingSections.length === 0 ? 'None' : plural(landingSections.length, 'section')}</dd>
      </dl>
    </div>
  );

  return (
    <main className="TopicEditPage" aria-label={`Edit ${topicDisplayName(loadedTopic)}`}>
      <EditPageLayout
        backTo="/admin/topics"
        backLabel="Topics"
        title={topicDisplayName(loadedTopic)}
        subtitle={<code>/topics/{loadedTopic.slug}</code>}
        headerMeta={current.visibility === 'private' ? <StatusChip tone="warn" size="sm" label="Private" /> : undefined}
        isDirty={isDirty}
        isSaving={save.isPending}
        canSave={isDirty}
        saveLabel="Save topic"
        onSave={() => void doSave()}
        onCancel={() => void navigate({ to: '/admin/topics' })}
        aside={aside}
        asideLabel="Landing preview"
        errorSummary={saveError}
        dangerZone={
          <FormSection title="Danger zone" tone="danger">
            <p className="TopicEditPage__muted">
              Archiving removes the topic from the site. Links to /topics/{loadedTopic.slug} stop working.
            </p>
            <button
              type="button"
              className="kp-admin-button TopicEditPage__danger"
              aria-disabled={archiveReason ? true : undefined}
              aria-describedby={archiveReason ? 'topic-archive-reason' : undefined}
              onClick={() => {
                if (archiveReason) return;
                setArchiveError(null);
                setConfirmArchive(true);
              }}
            >
              Archive…
            </button>
            {archiveReason ? (
              <p id="topic-archive-reason" className="TopicEditPage__muted">
                {archiveReason}.{archiveReason.startsWith('Has ') ? ' Move its items to another topic or delete them first.' : ''}
              </p>
            ) : null}
          </FormSection>
        }
      >
        <FormSection title="General">
          <FormField label="Name" htmlFor="topic-name" required error={shown.name}>
            {(control) => <input {...control} className="TopicForm__input" value={current.name} onChange={(e) => patch({ name: e.target.value })} maxLength={200} autoComplete="off" />}
          </FormField>
          <FormField label="Description" htmlFor="topic-description" helper="One line, shown on the topic list and the landing page.">
            {(control) => <textarea {...control} className="TopicForm__input" rows={2} value={current.description} onChange={(e) => patch({ description: e.target.value })} maxLength={1000} />}
          </FormField>
          <FormField label="Slug" htmlFor="topic-slug" helper={copyNote ?? 'Fixed once the topic exists: items, sections and links refer to it.'}>
            {(control) => (
              <div className="TopicForm__row">
                <input {...control} className="TopicForm__input TopicForm__mono" value={loadedTopic.slug} readOnly />
                <button type="button" className="kp-admin-button" onClick={() => void copySlug()} aria-label={`Copy slug ${loadedTopic.slug}`}>
                  Copy
                </button>
              </div>
            )}
          </FormField>
        </FormSection>

        <FormSection title="Visibility">
          <fieldset className="TopicForm__fieldset" aria-describedby="topic-visibility-note">
            <legend className="TopicForm__legend TopicForm__legend--hidden">Visibility</legend>
            <div className="TopicForm__radios">
              {(['public', 'private'] as const).map((value) => (
                <label key={value} className="TopicForm__radio">
                  <input type="radio" name="topic-visibility" value={value} checked={current.visibility === value} onChange={() => chooseVisibility(value)} />
                  <span>{value === 'public' ? 'Public' : 'Private'}</span>
                </label>
              ))}
            </div>
            {/*
              Stated, not implied: this narrows PUBLIC exposure only. It is not
              an ACL, and an admin who read it as one would leave content open
              they thought was closed to their own team.
            */}
            <p className="TopicForm__note" id="topic-visibility-note">
              Private hides this topic from anonymous visitors. Signed-in users are unaffected.
            </p>
          </fieldset>
        </FormSection>

        <FormSection title="Landing page">
          <fieldset className="TopicForm__fieldset">
            <legend className="TopicForm__legend">Presentation</legend>
            <div className="TopicEditPage__cards">
              {PRESENTATION_CHOICES.map((choice) => (
                <label key={choice.value} className="TopicEditPage__card" data-checked={current.presentation === choice.value || undefined}>
                  <input
                    type="radio"
                    name="topic-presentation"
                    value={choice.value}
                    checked={current.presentation === choice.value}
                    onChange={() => patch({ presentation: choice.value })}
                    aria-describedby={`topic-presentation-${choice.value}`}
                  />
                  <span className="TopicEditPage__cardTitle">{choice.label}</span>
                  <span id={`topic-presentation-${choice.value}`} className="TopicEditPage__cardBody">
                    {choice.description}
                  </span>
                </label>
              ))}
            </div>
          </fieldset>

          <FormField
            label="Start here"
            htmlFor="topic-start-here"
            helper={
              startHereWarning ? (
                <span className="TopicEditPage__warn">{startHereWarning}</span>
              ) : (
                'The item the landing’s Get started button opens. Published items in this topic.'
              )
            }
          >
            {(control) => (
              <ReferencePicker<StartHereOption>
                id={control.id}
                aria-describedby={control['aria-describedby']}
                loadOptions={loadOptions}
                getKey={(o) => o.slug}
                getLabel={(o) => o.title}
                labelForKey={(key) => (key === startHereSlug ? startHereTitle : undefined)}
                emptyOption={{ label: '(none)' }}
                value={current.start_here}
                onChange={(slug) => patch({ start_here: slug })}
                placeholder="(none)"
                testId="topic-start-here"
              />
            )}
          </FormField>

          <div className="kp-field TopicEditPage__markdown" data-invalid={length.over || undefined}>
            <div className="TopicEditPage__markdownHead">
              <label htmlFor="topic-landing-markdown" className="kp-field__label" id="topic-landing-markdown-label">
                Landing markdown
              </label>
              <div className="TopicEditPage__tabs" role="tablist" aria-label="Landing markdown">
                {(['write', 'preview'] as const).map((tab) => (
                  <button
                    key={tab}
                    type="button"
                    role="tab"
                    id={`topic-markdown-tab-${tab}`}
                    aria-selected={markdownTab === tab}
                    aria-controls={`topic-markdown-panel-${tab}`}
                    tabIndex={markdownTab === tab ? 0 : -1}
                    className="TopicEditPage__tab"
                    onClick={() => setMarkdownTab(tab)}
                    onKeyDown={(e) => {
                      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
                        e.preventDefault();
                        const next = markdownTab === 'write' ? 'preview' : 'write';
                        setMarkdownTab(next);
                        document.getElementById(`topic-markdown-tab-${next}`)?.focus();
                      }
                    }}
                  >
                    {tab === 'write' ? 'Write' : 'Preview'}
                  </button>
                ))}
              </div>
            </div>
            {markdownTab === 'write' ? (
              <div role="tabpanel" id="topic-markdown-panel-write" aria-labelledby="topic-markdown-tab-write">
                <textarea
                  id="topic-landing-markdown"
                  className="TopicForm__input TopicEditPage__textarea"
                  rows={10}
                  value={current.landing_markdown}
                  onChange={(e) => patch({ landing_markdown: e.target.value })}
                  aria-describedby="topic-landing-markdown-helper topic-landing-markdown-count"
                  aria-invalid={length.over || undefined}
                  spellCheck
                />
              </div>
            ) : (
              <div role="tabpanel" id="topic-markdown-panel-preview" aria-labelledby="topic-markdown-tab-preview" className="TopicEditPage__markdownPreview" tabIndex={0}>
                {current.landing_markdown.trim() ? <ReadView markdown={current.landing_markdown} /> : <p className="TopicEditPage__muted">Nothing to preview yet.</p>}
              </div>
            )}
            <div className="TopicEditPage__markdownFoot">
              <span id="topic-landing-markdown-helper" className="kp-field__helper">
                Shown above the sections on the landing page.
              </span>
              <span id="topic-landing-markdown-count" className="TopicEditPage__count" data-over={length.over || undefined} data-testid="topic-markdown-count">
                {length.label}
              </span>
            </div>
            {length.error ? (
              <p className="kp-field__error" role="alert">
                <span>{length.error}</span>
              </p>
            ) : null}
          </div>
        </FormSection>

        <FormSection title="Sections on this landing" aside={<Link to="/admin/sections">Manage sections →</Link>}>
          {sectionsLoading ? (
            <p className="TopicEditPage__muted">Loading sections…</p>
          ) : landingSections.length === 0 ? (
            <p className="TopicEditPage__muted">No sections name this topic, so the landing shows no curated sections.</p>
          ) : (
            <ul className="TopicEditPage__sections" aria-label="Sections on this landing">
              {landingSections.map((s) => (
                <li key={s.slug}>
                  <Link to="/admin/sections/$slug" params={{ slug: s.slug }}>
                    {s.name}
                  </Link>
                  <span className="TopicEditPage__muted"> /sections/{s.slug}</span>
                </li>
              ))}
            </ul>
          )}
        </FormSection>

        <FormSection title="Repository">
          {sources.isLoading ? (
            <p className="TopicEditPage__muted">Checking…</p>
          ) : sources.isError ? (
            <p className="TopicEditPage__muted">Repository status is unavailable.</p>
          ) : source ? (
            <div className="TopicEditPage__repo">
              <p className="TopicEditPage__repoLine">
                <StatusChip tone={stateTone(sourceStateChip(source))} size="sm" label={sourceStateChip(source).label} />
                <span>Synced {formatAge(lastSyncedAt(source))}</span>
              </p>
              <p className="TopicEditPage__muted">
                <code>{source.remote_url ?? source.local_dir}</code>
                {source.branch ? ` · ${source.branch}` : ''}
              </p>
              <Link to="/admin/repos" search={{ source: source.id } as never}>
                Open {source.id} in Sources →
              </Link>
            </div>
          ) : (
            <p className="TopicEditPage__muted">
              This topic lives in the main repository. <Link to="/admin/repos">Sources →</Link>
            </p>
          )}
        </FormSection>
      </EditPageLayout>

      {confirmPublic ? (
        <ConfirmDialog
          title={publicConfirmation.title}
          body={publicConfirmation.body}
          consequences={publicConfirmation.consequences}
          confirmLabel="Make public"
          tone="danger"
          onConfirm={() => {
            setConfirmPublic(false);
            patch({ visibility: 'public' });
          }}
          onCancel={() => setConfirmPublic(false)}
        />
      ) : null}

      {confirmArchive ? (
        <ConfirmDialog
          title={`Archive ${topicDisplayName(loadedTopic)}?`}
          body="The topic is removed from the site straight away."
          consequences={archiveConsequences(loadedTopic)}
          confirmLabel="Archive topic"
          tone="danger"
          pending={archiveTopic.isPending}
          error={archiveError}
          onConfirm={() => void doArchive()}
          onCancel={() => setConfirmArchive(false)}
        />
      ) : null}
    </main>
  );
}
