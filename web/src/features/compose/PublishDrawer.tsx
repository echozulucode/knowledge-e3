/**
 * PublishDrawer — the right-side panel behind "Publish…" (plan §4.2).
 *
 * Groups: Where (topic, section) · What (type, primary category, tags, groups)
 * · Blog (description, authors, series, published at, cover) · Lifecycle
 * (status, stale_after, reviewed-by-me) · Advanced (raw FrontmatterPanel).
 *
 * The drawer edits a local copy of the values and only writes to frontmatter
 * when Save changes / Publish is pressed; the parent owns persistence.
 *
 * Primary category is a REQUIRED, curated choice: exactly one, picked from the
 * admin catalog (Eric, 2026-09-11 — issues 97/106). There is deliberately no
 * default: under a curated vocabulary, silently filing an item into someone
 * else's category is worse than asking the author to choose.
 */
import { useCallback, useMemo, useRef, useState } from 'react';
import type { Frontmatter } from '@echozedlabs/codec';
import type { ItemSourceRef } from '@echozedlabs/knowledge-types';
import type { ContentType, Section, TaxonomyCategory, TaxonomyGroup, Topic } from '../../queries.js';
import { useTags } from '../../queries.js';
import { Modal } from '../../components/Modal.js';
import { FrontmatterPanel } from '../../components/FrontmatterPanel.js';
import { displayTopic } from '../topics/topicFilters.js';
import { itemLocation } from '../sources/itemLocation.js';
import {
  drawerValuesFrom,
  findType,
  tokens,
  validateForPublish,
  withDrawerValues,
  type DrawerValues,
  type PublishField,
} from './composeModel.js';

/**
 * The primary-category vocabulary the publish gate accepts, mirroring the
 * server's `lintContext`: a document may name its category by slug or by the
 * catalog's display name, so both are accepted here too.
 */
function curatedTokens(categories: TaxonomyCategory[]): string[] {
  return categories.flatMap((c) => [c.slug, c.name].filter((v): v is string => Boolean(v && v.trim())));
}

function isCurated(value: string, categories: TaxonomyCategory[]): boolean {
  const needle = value.trim().toLowerCase();
  return curatedTokens(categories).some((token) => token.trim().toLowerCase() === needle);
}

/**
 * The catalog SLUG for whatever the document happens to carry — a slug already,
 * or the display name an older item was filed under (`Research notes`).
 *
 * The picker's option values are slugs, so an item whose frontmatter names its
 * category the human way would otherwise open with nothing selected and lose
 * the value on the next save. Resolving here (rather than rewriting the state)
 * keeps the stored value untouched until the author actually picks something:
 * both forms lint clean, so a silent rewrite would be churn in git for nothing.
 */
function slugFor(value: string, categories: TaxonomyCategory[]): string {
  const needle = value.trim().toLowerCase();
  const match = categories.find(
    (c) => c.slug?.trim().toLowerCase() === needle || c.name?.trim().toLowerCase() === needle,
  );
  return match?.slug || value;
}

export interface PublishDrawerProps {
  title: string;
  frontmatter: Frontmatter;
  bodyIsEmpty: boolean;
  contentTypes: ContentType[];
  topics: Topic[];
  sections: Section[];
  /**
   * The CURATED primary-category catalog (`useCuratedCategories`), NOT the
   * catalog-plus-usage union browse uses. Primary categories are curated, not
   * emergent (Eric, 2026-09-11), so this is the whole of what may be published
   * into; passing the union would offer terms the publish gate then refuses.
   */
  categories: TaxonomyCategory[];
  groups: TaxonomyGroup[];
  /** `stale_after.missing` fix from the last write's diagnostics, if any. */
  staleAfterSuggestion?: string;
  /**
   * Where this item's canonical file lives (plan B1). Partial by design — the
   * server redacts it per viewer — so the drawer renders what it was given and
   * omits the group when there is nothing to say. Absent on a new item, which
   * has no file yet.
   */
  source?: ItemSourceRef | null;
  saving: boolean;
  onClose: () => void;
  onApplyTemplate: (type: ContentType) => void;
  onFrontmatterChange: (frontmatter: Frontmatter) => void;
  onUploadCover: (file: File) => Promise<string>;
  onSave: (values: DrawerValues, options: { publish: boolean; reviewed: boolean }) => Promise<void>;
}

function TokenField({
  id,
  label,
  values,
  suggestions,
  placeholder,
  hint,
  onChange,
  onQuery,
}: {
  id: string;
  label: string;
  values: string[];
  suggestions?: string[];
  placeholder?: string;
  hint?: string;
  onChange: (values: string[]) => void;
  onQuery?: (query: string) => void;
}) {
  const [entry, setEntry] = useState('');
  const commit = (raw: string) => {
    const next = tokens(raw).filter((token) => !values.includes(token));
    if (next.length) onChange([...values, ...next]);
    setEntry('');
    onQuery?.('');
  };
  const listId = suggestions ? `${id}-suggestions` : undefined;
  return (
    <div className="kp-compose-field">
      <label htmlFor={id}>{label}</label>
      <div className="kp-compose-tokens">
        {values.map((value) => (
          <span key={value} className="kp-compose-token">
            {value}
            <button type="button" onClick={() => onChange(values.filter((v) => v !== value))} aria-label={`Remove ${value}`}>
              ×
            </button>
          </span>
        ))}
        <input
          id={id}
          value={entry}
          list={listId}
          placeholder={placeholder}
          onChange={(event) => {
            setEntry(event.target.value);
            onQuery?.(event.target.value);
          }}
          onBlur={() => commit(entry)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ',') {
              event.preventDefault();
              commit(entry);
            }
          }}
        />
        {listId ? (
          <datalist id={listId}>
            {(suggestions ?? []).filter((s) => !values.includes(s)).map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>
        ) : null}
      </div>
      {hint ? <p className="kp-compose-field-hint">{hint}</p> : null}
    </div>
  );
}

export function PublishDrawer({
  title,
  frontmatter,
  bodyIsEmpty,
  contentTypes,
  topics,
  sections,
  categories,
  groups,
  staleAfterSuggestion,
  source,
  saving,
  onClose,
  onApplyTemplate,
  onFrontmatterChange,
  onUploadCover,
  onSave,
}: PublishDrawerProps) {
  const [values, setValues] = useState<DrawerValues>(() => {
    const initial = drawerValuesFrom(frontmatter);
    return initial.staleAfter || !staleAfterSuggestion ? initial : { ...initial, staleAfter: staleAfterSuggestion };
  });
  const [reviewed, setReviewed] = useState(false);
  const [tagQuery, setTagQuery] = useState('');
  const [coverError, setCoverError] = useState<string | null>(null);
  const { data: tagSuggestions = [] } = useTags(tagQuery);

  // Modal re-focuses its first control whenever `onClose` changes identity, so
  // keep it stable across keystrokes (read `saving` through a ref).
  const savingRef = useRef(saving);
  savingRef.current = saving;
  const handleClose = useCallback(() => {
    if (!savingRef.current) onClose();
  }, [onClose]);

  const update = <K extends keyof DrawerValues>(key: K, value: DrawerValues[K]) => {
    setValues((current) => ({ ...current, [key]: value }));
  };

  const location = itemLocation(source);
  const typeDef = findType(values.type, contentTypes);
  const errors = useMemo(
    () => validateForPublish({ title, ...values }, contentTypes, curatedTokens(categories)),
    [title, values, contentTypes, categories],
  );
  const errorList = Object.entries(errors) as Array<[PublishField, string]>;
  const canPublish = errorList.length === 0 && !saving;

  const topicOptions = topics.map(displayTopic);
  const currentSection =
    sections.find((s) => (s.type ? findType(s.type, contentTypes)?.key : '') === (typeDef?.key ?? '') && (s.space ?? '') === values.topic)?.slug ?? '';
  const mergedFrontmatter = useMemo(() => withDrawerValues(frontmatter, values), [frontmatter, values]);

  const errorFor = (field: PublishField) =>
    errors[field] ? (
      <p className="kp-compose-field-error" id={`publish-${field}-error`} role="alert">
        {errors[field]}
      </p>
    ) : null;

  return (
    <Modal
      onClose={handleClose}
      labelledBy="publish-drawer-title"
      backdropClassName="kp-compose-drawer-backdrop"
      className="kp-compose-drawer"
      closeOnBackdrop={!saving}
    >
      <div className="kp-compose-drawer-header">
        <h2 id="publish-drawer-title">Publish</h2>
        <button type="button" className="kp-compose-drawer-close" onClick={onClose} aria-label="Close publish drawer" disabled={saving}>
          ×
        </button>
      </div>

      <div className="kp-compose-drawer-body">
        <fieldset className="kp-compose-group">
          <legend>Where</legend>
          <div className="kp-compose-field">
            <label htmlFor="publish-topic">Topic</label>
            <select id="publish-topic" value={values.topic} onChange={(event) => update('topic', event.target.value)}>
              <option value="">No topic</option>
              {topicOptions.map((topic) => (
                <option key={topic} value={topic}>{topic}</option>
              ))}
              {values.topic && !topicOptions.includes(values.topic) ? <option value={values.topic}>{values.topic}</option> : null}
            </select>
            <p className="kp-compose-field-hint">The topic this item belongs to — where you would expect to browse for it later.</p>
          </div>
          <div className="kp-compose-field">
            <label htmlFor="publish-section">Section</label>
            <select
              id="publish-section"
              value={currentSection}
              onChange={(event) => {
                const section = sections.find((s) => s.slug === event.target.value);
                if (!section) return;
                const sectionType = section.type ? findType(section.type, contentTypes) : undefined;
                setValues((current) => ({
                  ...current,
                  ...(section.space ? { topic: section.space } : {}),
                  ...(sectionType ? { type: sectionType.label } : {}),
                }));
              }}
            >
              <option value="">No section</option>
              {sections.map((section) => (
                <option key={section.slug} value={section.slug}>{section.name}</option>
              ))}
            </select>
            <p className="kp-compose-field-hint">A section is a curated topic × type view; choosing one sets both.</p>
          </div>
          {location ? (
            <div className="kp-compose-field kp-compose-location" data-operator-location="true">
              {/*
                Where the file actually is (plan B1). Not editable here — a file
                moves by moving the item, not by retyping its path — so this is
                the one place in Compose that simply states it.
              */}
              <span className="kp-compose-location-label">Where this lives</span>
              <dl>
                <dt>Repository</dt>
                <dd><code>{location.id}</code></dd>
                {location.path ? (
                  <>
                    <dt>File</dt>
                    <dd><code>{location.path}</code></dd>
                  </>
                ) : null}
                {location.url ? (
                  <>
                    <dt>Upstream</dt>
                    <dd>
                      <a href={location.url} target="_blank" rel="noreferrer noopener">
                        Open the file on its host
                      </a>
                    </dd>
                  </>
                ) : null}
              </dl>
            </div>
          ) : null}
        </fieldset>

        <fieldset className="kp-compose-group">
          <legend>What</legend>
          <div className="kp-compose-field">
            <label htmlFor="publish-type">
              Content type <span className="kp-compose-required" aria-hidden="true">*</span>
            </label>
            <select
              id="publish-type"
              value={typeDef?.key ?? ''}
              aria-describedby={errors.type ? 'publish-type-error' : undefined}
              onChange={(event) => {
                const next = contentTypes.find((t) => t.key === event.target.value);
                update('type', next?.label ?? '');
              }}
            >
              <option value="">Choose type…</option>
              {contentTypes.map((t) => (
                <option key={t.key} value={t.key}>{t.label}</option>
              ))}
            </select>
            {errorFor('type')}
            <p className="kp-compose-field-hint">
              The kind of content (an OKF concept type). It picks a starter template and domain fields — a
              Troubleshooting Guide scaffolds symptom → checks → fix → verify.
            </p>
            {typeDef && bodyIsEmpty ? (
              <button type="button" className="kp-compose-inline-action" onClick={() => onApplyTemplate(typeDef)}>
                Apply {typeDef.label} template
              </button>
            ) : null}
          </div>
          <div className="kp-compose-field">
            <label htmlFor="publish-category">
              Primary category <span className="kp-compose-required" aria-hidden="true">*</span>
            </label>
            <select
              id="publish-category"
              value={slugFor(values.category, categories)}
              required
              aria-required="true"
              aria-describedby={errors.category ? 'publish-category-error' : 'publish-category-hint'}
              onChange={(event) => update('category', event.target.value)}
            >
              <option value="">Choose category…</option>
              {/*
                The picker offers the CURATED catalog only, and writes the slug —
                primary categories are curated, not emergent (Eric, 2026-09-11),
                so an author picks one rather than inventing one, and the slug is
                what the publish gate lints against.
              */}
              {categories.map((category) => {
                const value = category.slug || category.name;
                return <option key={value} value={value}>{category.name || category.slug}</option>;
              })}
              {/*
                An existing item may already carry a term that is not (or is no
                longer) in the catalog. Keep it selectable so opening the drawer
                never silently rewrites it — but say what it is, because publish
                will refuse it until the author picks a curated term or an admin
                curates this one.
              */}
              {values.category && !isCurated(values.category, categories) ? (
                <option value={values.category}>{values.category} — not in the catalog</option>
              ) : null}
            </select>
            {errorFor('category')}
            <p className="kp-compose-field-hint" id="publish-category-hint">
              Required to publish, and exactly one: the item's single primary purpose, such as Research
              notes, Decision record, How-to, Reference, Runbook, Experiment, or Meeting notes. The list is
              curated by an admin — if nothing fits, ask for the category rather than inventing one, and use
              tags or groups for looser cross-cutting labels.
            </p>
          </div>
          <TokenField
            id="publish-tags"
            label="Tags"
            values={values.tags}
            suggestions={tagSuggestions.map((tag) => tag.slug || tag.name)}
            placeholder="add tags…"
            onChange={(tags) => update('tags', tags)}
            onQuery={setTagQuery}
            hint="Short searchable labels: technologies, people, concepts, or recurring details that span topics."
          />
          <TokenField
            id="publish-groups"
            label="Groups"
            values={values.groups}
            suggestions={groups.map((group) => group.slug || group.name)}
            placeholder="add groups…"
            onChange={(next) => update('groups', next)}
            hint="Temporary or cross-cutting workstreams such as roadmap, onboarding, or ops-review."
          />
        </fieldset>

        <fieldset className="kp-compose-group">
          <legend>Blog</legend>
          <div className="kp-compose-field">
            <label htmlFor="publish-description">
              Description <span className="kp-compose-required" aria-hidden="true">*</span>
            </label>
            <textarea
              id="publish-description"
              rows={3}
              value={values.description}
              aria-describedby={errors.description ? 'publish-description-error' : undefined}
              onChange={(event) => update('description', event.target.value)}
              placeholder="One or two sentences shown on cards and feeds."
            />
            {errorFor('description')}
            <p className="kp-compose-field-hint">Also the card preview in browse — lead with the most useful takeaway.</p>
          </div>
          <TokenField
            id="publish-authors"
            label="Authors"
            values={values.authors}
            placeholder="add an author…"
            onChange={(authors) => update('authors', authors)}
          />
          {errorFor('authors')}
          <div className="kp-compose-field-row">
            <div className="kp-compose-field">
              <label htmlFor="publish-series">Series</label>
              <input id="publish-series" value={values.series} onChange={(event) => update('series', event.target.value)} placeholder="series slug" />
            </div>
            <div className="kp-compose-field">
              <label htmlFor="publish-series-order">Series position</label>
              <input id="publish-series-order" type="number" min={1} value={values.seriesOrder} onChange={(event) => update('seriesOrder', event.target.value)} />
            </div>
          </div>
          <div className="kp-compose-field">
            <label htmlFor="publish-published-at">Published at</label>
            <input
              id="publish-published-at"
              type="date"
              value={values.publishedAt}
              aria-describedby={errors.publishedAt ? 'publish-publishedAt-error' : undefined}
              onChange={(event) => update('publishedAt', event.target.value)}
            />
            {errorFor('publishedAt')}
          </div>
          <div className="kp-compose-field">
            <label htmlFor="publish-cover">Cover</label>
            <input id="publish-cover" value={values.cover} onChange={(event) => update('cover', event.target.value)} placeholder="/assets/… or https://…" />
            <input
              type="file"
              accept="image/*"
              aria-label="Upload cover image"
              onChange={async (event) => {
                const file = event.target.files?.[0];
                event.target.value = '';
                if (!file) return;
                setCoverError(null);
                try {
                  update('cover', await onUploadCover(file));
                } catch (error) {
                  setCoverError(error instanceof Error ? error.message : 'Cover upload failed.');
                }
              }}
            />
            {coverError ? <p className="kp-compose-field-error" role="alert">{coverError}</p> : null}
          </div>
        </fieldset>

        <fieldset className="kp-compose-group">
          <legend>Lifecycle</legend>
          <div className="kp-compose-field">
            <label htmlFor="publish-status">Status</label>
            <select id="publish-status" value={values.status} onChange={(event) => update('status', event.target.value === 'published' ? 'published' : 'draft')}>
              <option value="draft">Draft</option>
              <option value="published">Published</option>
            </select>
            <p className="kp-compose-field-hint">
              Draft is work-in-progress. Published means it is ready to rely on in search, links, and reviews.
            </p>
          </div>
          <div className="kp-compose-field">
            <label htmlFor="publish-stale-after">Review by</label>
            <input id="publish-stale-after" type="date" value={values.staleAfter} onChange={(event) => update('staleAfter', event.target.value)} />
            <p className="kp-compose-field-hint">After this date the item shows “Needs review”.</p>
          </div>
          <label className="kp-compose-check">
            <input type="checkbox" checked={reviewed} onChange={(event) => setReviewed(event.target.checked)} />
            <span>I reviewed this content</span>
          </label>
        </fieldset>

        <details className="kp-compose-group kp-compose-advanced">
          <summary>Advanced</summary>
          <FrontmatterPanel
            frontmatter={mergedFrontmatter}
            onFrontmatterChange={(next) => {
              onFrontmatterChange(next);
              setValues(drawerValuesFrom(next));
            }}
          />
        </details>

        {errorList.length > 0 ? (
          <div className="kp-compose-validation" aria-label="Publish requirements">
            <p>Before publishing:</p>
            <ul>
              {errorList.map(([field, message]) => (
                <li key={field}>{message}</li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>

      <div className="kp-compose-drawer-footer">
        <button type="button" className="kp-compose-secondary" onClick={() => void onSave(values, { publish: false, reviewed })} disabled={saving}>
          Save changes
        </button>
        <button type="button" className="kp-compose-primary" onClick={() => void onSave(values, { publish: true, reviewed })} disabled={!canPublish}>
          {saving ? 'Saving…' : 'Publish'}
        </button>
      </div>
    </Modal>
  );
}
