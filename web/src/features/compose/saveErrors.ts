/**
 * How a failed write from Compose is classified (plan §8.2/§8.3). Pure — no
 * React, no fetch — and unit-tested in saveErrors.test.ts.
 *
 * The write path returns several different 409s and they mean different things
 * to the author. Only the one with no `reason` is an optimistic-concurrency
 * mismatch, which is what `ConflictDialog` is for: it diffs your document
 * against the stored version. The reasoned failures are about the FILE, not the
 * version, so showing that diff would be misleading.
 */

/** The shape `ApiClient` throws. Everything is optional: a thrown non-error is a plain failure. */
export interface SaveErrorLike {
  statusCode?: number;
  message?: string;
  /** Machine-readable discriminator from the server's error body, when it sent one. */
  reason?: string;
  /** Carried on `lint_failed`: the content-model errors that refused the publish. */
  diagnostics?: unknown;
}

/** One fixable content-model error, as the refusal body carries it. */
export interface SaveDiagnostic {
  code: string;
  message: string;
  /** Frontmatter key the error points at (`type`, `categories`, `description`, ...), when known. */
  path?: string;
}

export type SaveOutcome =
  /** No `reason`: the stored version moved under us. ConflictDialog, unchanged. */
  | { kind: 'version-conflict' }
  /** `changed_on_disk`: the file was edited in VS Code or the host's web UI. */
  | { kind: 'changed-upstream'; message: string }
  /** `source_read_only`: this item's source publishes nothing from here. */
  | { kind: 'read-only-source'; message: string }
  /** `review_unsupported_operation`: the change cannot be staged onto an item branch yet. */
  | { kind: 'review-unsupported'; message: string }
  /**
   * `lint_failed` (422): the publish transition was refused because the document
   * has error-severity content-model diagnostics. Each one names the frontmatter
   * key to fix, so this renders as a fixable list rather than a dead end.
   *
   * In practice a backstop for this door — `validateForPublish` already refuses
   * the same rule set in the Publish drawer before the request is made — and the
   * real gate for the REST and MCP doors. It still reaches us when an author
   * publishes by editing `status` in frontmatter, which bypasses the drawer.
   */
  | { kind: 'lint-failed'; message: string; diagnostics: SaveDiagnostic[] }
  /**
   * The other bare 409: the title collides with an existing item in the same
   * topic. Nothing is stale and nothing is diffable — the author has to choose
   * another title — so it is neither a version conflict nor an anonymous
   * failure.
   */
  | { kind: 'duplicate-title'; message: string }
  /** Everything else, including network failures. */
  | { kind: 'failed'; message: string };

const CHANGED_UPSTREAM =
  'The file behind this item was changed outside the app, so the index has not caught up yet. Reload to pick up the newer file before saving again.';

/**
 * Reader sentences, not registry ids (reader UX plan §6, R4.3). The server's own
 * message names the source — "Source topic:gamedev is read-only; edits belong
 * upstream" — which is the right thing for a log and for Admin → Sources, where
 * an operator can act on it, and the wrong thing in front of an author: it puts
 * the instance's plumbing and Git vocabulary on screen and makes one corpus read
 * as several. So these two refusals are stated here and the server's sentence is
 * deliberately NOT used.
 */
const READ_ONLY = 'This page is maintained by another team, so it cannot be edited here.';

const REVIEW_UNSUPPORTED = 'This kind of change cannot be made to this page yet.';

const LINT_FAILED = 'This item cannot be published until its content-model errors are fixed.';

const DUPLICATE_TITLE = 'An item with this title already exists in this topic.';

/** Keep only well-formed diagnostics; the list is rendered, so a malformed entry is dropped. */
function diagnosticsOf(value: unknown): SaveDiagnostic[] {
  if (!Array.isArray(value)) return [];
  const out: SaveDiagnostic[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const { code, message, path } = entry as { code?: unknown; message?: unknown; path?: unknown };
    if (typeof code !== 'string' || typeof message !== 'string') continue;
    out.push({ code, message, ...(typeof path === 'string' && path ? { path } : {}) });
  }
  return out;
}

function asError(error: unknown): SaveErrorLike {
  return error && typeof error === 'object' ? (error as SaveErrorLike) : {};
}

/** The server's sentences are not punctuated; this one is read as prose next to another. */
function sentence(value: string): string {
  const trimmed = value.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

/** The server's own sentence when it sent one — it names the file, source, or operation. */
function detail(error: SaveErrorLike, fallback: string): string {
  const message = typeof error.message === 'string' ? error.message.trim() : '';
  return message.length > 0 ? message : fallback;
}

/**
 * `hasItem` is false while composing a brand-new item: a 409 from POST /pages
 * is a title collision, never a version conflict.
 */
export function saveOutcome(error: unknown, context: { hasItem: boolean }): SaveOutcome {
  const err = asError(error);
  switch (err.reason) {
    case 'changed_on_disk':
      return { kind: 'changed-upstream', message: CHANGED_UPSTREAM };
    case 'source_read_only':
      return { kind: 'read-only-source', message: READ_ONLY };
    case 'review_unsupported_operation':
      return { kind: 'review-unsupported', message: REVIEW_UNSUPPORTED };
    case 'lint_failed':
      return { kind: 'lint-failed', message: detail(err, LINT_FAILED), diagnostics: diagnosticsOf(err.diagnostics) };
    default:
      break;
  }
  // The server names the item and the topic, so its sentence leads and the
  // instruction follows it. Checked before the version conflict because both
  // arrive as a bare 409 on an existing item.
  if (err.statusCode === 409 && /already exists/i.test(err.message ?? '')) {
    return { kind: 'duplicate-title', message: `${sentence(detail(err, DUPLICATE_TITLE))} Choose a unique title before saving.` };
  }
  // Unchanged from before the reasons existed: a bare 409 on an existing item
  // is a version conflict.
  if (err.statusCode === 409 && context.hasItem) {
    return { kind: 'version-conflict' };
  }
  return { kind: 'failed', message: err.message ? `Save failed: ${err.message}` : 'Save failed. Please try again.' };
}

/**
 * The Publish-drawer field a diagnostic's frontmatter key belongs to, so the
 * `lint_failed` refusal can name the control the author has to touch rather
 * than a YAML key they may never have seen. Unmapped keys fall back to the raw
 * path — the Advanced (raw frontmatter) section still reaches them.
 *
 * `categories` is the one that matters most now that primary categories are
 * curated (Eric, 2026-09-11): `category.missing` and `category.unknown` are both
 * fixed at the same picker, and neither can be fixed by inventing a term.
 */
export function drawerFieldLabel(path?: string): string | undefined {
  switch (path) {
    case 'categories':
    case 'e3_categories':
      return 'Primary category';
    case 'type':
      return 'Content type';
    case 'description':
      return 'Description';
    case 'published_at':
      return 'Published at';
    case 'authors':
    case 'author':
      return 'Authors';
    case 'stale_after':
      return 'Review by';
    case 'title':
      return 'Title';
    case 'topic':
    case 'space':
      return 'Topic';
    case 'groups':
      return 'Groups';
    case 'tags':
      return 'Tags';
    default:
      return undefined;
  }
}
