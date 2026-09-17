/**
 * A refused source save, mapped back onto the form (the admin UX review §2 #6).
 *
 * `PUT /admin/sources/:id` answers a bad row with a plain 400 whose message
 * names the column at fault — `SourceRegistryService.upsert` writes
 * `include_globs: "…" must be a repository-relative glob`, `unknown content
 * type "…" for default_type`, `local_dir "…" is already used by source …`, and
 * class-validator writes `sync_every_seconds must not be less than 5` (as an
 * array). There is no structured field on the body, so the column name in the
 * message is the contract: a message that names one of the form's fields is
 * shown beside it, anything else in the form's footer. Never in the list below
 * the form — the admin is looking at the form they just submitted.
 */
import type { SourceForm } from './sourceModel.js';

export interface SourceSaveError {
  /** Messages the server tied to one field, keyed by that field. */
  fields: Partial<Record<keyof SourceForm, string>>;
  /** Everything that names no field (a dual-writer collision, a 500, the network). */
  summary: string | null;
}

/**
 * Most specific first: the review-mode refusals mention `mode "review"` but
 * are fixed by setting the remote or the host, and a `default_status` message
 * must not be read as `default_type`.
 */
const FIELD_PATTERNS: [RegExp, keyof SourceForm][] = [
  [/without a remote_url/, 'remote_url'],
  [/without a host_kind/, 'host_kind'],
  [/\binclude_globs\b/, 'include_globs'],
  [/\bexclude_globs\b/, 'exclude_globs'],
  [/\bdefault_type\b/, 'default_type'],
  [/\bdefault_status\b/, 'default_status'],
  [/\bsync_every_seconds\b/, 'sync_every_seconds'],
  [/\blocal_dir\b/, 'local_dir'],
  [/^source id must be\b/, 'id'],
  [/\bremote URL\b|\bremote_url\b/, 'remote_url'],
  [/\bhost_kind\b/, 'host_kind'],
  [/\bhost_base_url\b/, 'host_base_url'],
  [/\bhost_token_env\b/, 'host_token_env'],
  [/\bwebhook_secret_env\b/, 'webhook_secret_env'],
  [/\bbranch_prefix\b/, 'branch_prefix'],
  [/^branch\b/, 'branch'],
];

/** The field a single server message is about, or null. */
export function fieldForSourceMessage(message: string): keyof SourceForm | null {
  for (const [pattern, field] of FIELD_PATTERNS) if (pattern.test(message)) return field;
  return null;
}

export function mapSourceSaveError(error: unknown): SourceSaveError {
  const raw = error && typeof error === 'object' && 'message' in error ? (error as { message?: unknown }).message : null;
  const messages = (Array.isArray(raw) ? raw : [raw])
    .filter((m): m is string => typeof m === 'string' && m.trim() !== '')
    .map((m) => m.trim());
  if (messages.length === 0) return { fields: {}, summary: 'The source was not saved.' };

  const fields: SourceSaveError['fields'] = {};
  const unplaced: string[] = [];
  for (const message of messages) {
    const field = fieldForSourceMessage(message);
    if (field && !fields[field]) fields[field] = message;
    else unplaced.push(message);
  }
  return { fields, summary: unplaced.length > 0 ? unplaced.join(' ') : null };
}
