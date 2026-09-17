/**
 * Pure helpers for Admin → Authentication (the admin UX review §4.7): the
 * provenance line under each setting, the password-policy draft and its
 * validation, and the token-lifetime choices. Kept out of the page so the rules
 * that decide what an admin is told are unit-tested without a DOM.
 */
import type { AuthSettings, PasswordPolicy, ReadAccessMode, SettingProvenance } from '../queries.js';

// ---------------------------------------------------------------- provenance

/** `Sep 2, 2026`: month name, so a US and a European admin read the same date. */
export function provenanceDate(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  return at.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/**
 * Where a setting's value came from, in the words the page shows under it:
 * "Set in admin by eric · Sep 2, 2026", "From environment (LOGIN_THROTTLE_PER_IP)",
 * "From knowledge-e3.config", or "Default". Only what the server can actually
 * tell: no username when the row names none, no date when it has none.
 */
export function provenanceText(p: SettingProvenance): string {
  switch (p.source) {
    case 'admin': {
      const by = p.updated_by_username ? ` by ${p.updated_by_username}` : '';
      const when = p.updated_at ? provenanceDate(p.updated_at) : '';
      return `Set in admin${by}${when ? ` · ${when}` : ''}`;
    }
    case 'env':
      return p.env_vars.length > 0 ? `From environment (${p.env_vars.join(', ')})` : 'From environment';
    case 'config':
      return 'From knowledge-e3.config';
    default:
      return 'Default';
  }
}

export const READ_MODE_LABELS: Record<ReadAccessMode, string> = {
  public: 'Public',
  authenticated: 'Login required',
};

/**
 * For read access set in admin: the deploy default it overrides, so an operator
 * who set `KNOWLEDGE_E3_DEFAULT_READ_ACCESS` learns why that has no effect.
 * Null when there is no admin choice, so nothing is overridden.
 */
export function readAccessOverrideNote(read: AuthSettings['read_access']): string | null {
  if (read.provenance.source !== 'admin') return null;
  const d = read.deploy_default;
  const where = d.source === 'default' ? 'built-in default' : provenanceText(d).replace(/^From /, 'from ');
  return `Overrides the deploy default (${READ_MODE_LABELS[d.read_mode]}, ${where}).`;
}

// ---------------------------------------------------------------- password policy

export const MIN_LENGTH_MIN = 1;
export const MIN_LENGTH_MAX = 128;

/**
 * The form's copy of the policy. `min_length` is the TEXT in the box: the old
 * form stored `Number(value) || 1`, so clearing the field to type "12" snapped
 * it to 1 mid-edit. The text is only turned into a number when it is valid.
 */
export interface PolicyDraft {
  min_length: string;
  require_uppercase: boolean;
  require_number: boolean;
  require_symbol: boolean;
}

export function policyToDraft(policy: PasswordPolicy): PolicyDraft {
  return {
    min_length: String(policy.min_length),
    require_uppercase: policy.require_uppercase,
    require_number: policy.require_number,
    require_symbol: policy.require_symbol,
  };
}

/** The parsed minimum length, or null when the text is not a whole number in range. */
export function parseMinLength(text: string): number | null {
  const value = text.trim();
  if (!/^\d+$/.test(value)) return null;
  const n = Number(value);
  return n >= MIN_LENGTH_MIN && n <= MIN_LENGTH_MAX ? n : null;
}

/** The error under Minimum length, or null. Shown on blur and on Save, not on every keystroke. */
export function minLengthError(text: string): string | null {
  return parseMinLength(text) === null ? `Enter a whole number from ${MIN_LENGTH_MIN} to ${MIN_LENGTH_MAX}.` : null;
}

/** The policy a valid draft saves as; null while the draft is invalid. */
export function draftToPolicy(draft: PolicyDraft): PasswordPolicy | null {
  const min_length = parseMinLength(draft.min_length);
  if (min_length === null) return null;
  return {
    min_length,
    require_uppercase: draft.require_uppercase,
    require_number: draft.require_number,
    require_symbol: draft.require_symbol,
  };
}

/**
 * Whether the draft differs from what is saved. "12 " and "012" are the saved
 * 12 once parsed, so they are not dirty; text that does not parse ("", "abc")
 * is always dirty — it is an edit, and Discard should be offered.
 */
export function isPolicyDirty(draft: PolicyDraft, saved: PasswordPolicy): boolean {
  const min = parseMinLength(draft.min_length);
  return (
    min !== saved.min_length ||
    draft.require_uppercase !== saved.require_uppercase ||
    draft.require_number !== saved.require_number ||
    draft.require_symbol !== saved.require_symbol
  );
}

// ---------------------------------------------------------------- token lifetime

export interface LifetimeOption {
  /** Days, or null for no maximum. */
  value: number | null;
  label: string;
}

const LIFETIME_OPTIONS: LifetimeOption[] = [
  { value: null, label: 'No maximum (tokens may never expire)' },
  { value: 365, label: '365 days' },
  { value: 90, label: '90 days' },
  { value: 30, label: '30 days' },
];

/**
 * The choices for Maximum token lifetime. The API accepts any 1–3650 days, so
 * a value set outside this page (e.g. 180) is added rather than shown as a
 * different choice the admin might then save by accident.
 */
export function lifetimeOptions(current: number | null): LifetimeOption[] {
  if (current === null || LIFETIME_OPTIONS.some((o) => o.value === current)) return LIFETIME_OPTIONS;
  return [...LIFETIME_OPTIONS, { value: current, label: `${current} days` }].sort(
    (a, b) => (a.value === null ? -1 : b.value === null ? 1 : b.value - a.value),
  );
}

/** `<select>` values are strings; "none" stands for null. */
export function lifetimeToValue(days: number | null): string {
  return days === null ? 'none' : String(days);
}

export function valueToLifetime(value: string): number | null {
  return value === 'none' ? null : Number(value);
}

// ---------------------------------------------------------------- login throttle

/** `15 minutes`, `1 hour`, `90 seconds`: the sliding window as a person says it. */
export function durationText(ms: number): string {
  const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'}`;
  if (ms % 3_600_000 === 0) return plural(ms / 3_600_000, 'hour');
  if (ms % 60_000 === 0) return plural(ms / 60_000, 'minute');
  if (ms % 1_000 === 0) return plural(ms / 1_000, 'second');
  return `${ms} ms`;
}

/** A bucket limit: `5 failed attempts`, or `Off` when the bucket is disabled. */
export function attemptLimitText(limit: number | null): string {
  if (limit === null) return 'Off';
  return `${limit} failed attempt${limit === 1 ? '' : 's'}`;
}
