/**
 * Pure helpers for Admin → Users (the admin UX review §4.3): the
 * URL state of the list, the password checklist and generator for New user,
 * relative "last seen" times, and the role/disable rules the user sheet states
 * before the admin tries. Kept out of the components so they can be unit-tested
 * without a router or a DOM.
 */
import type { AdminUser, PasswordPolicy } from '../../queries.js';

// ---------------------------------------------------------------- URL state

export const USERS_PAGE_SIZE = 50;

export type UserRoleFilter = 'admin' | 'user';
export type UserStatusFilter = 'active' | 'disabled';
export type UsersSortColumn = 'username' | 'role' | 'status' | 'last_seen' | 'created';

/**
 * Everything the Users page keeps in the query string, so a filtered list, a
 * page of it, or one open user is a link an admin can share or come Back to.
 * Defaults are absent rather than spelled out (`?page=1` is noise).
 */
export interface UsersSearch {
  q: string;
  role?: UserRoleFilter;
  status?: UserStatusFilter;
  /** 1-based. */
  page: number;
  sort?: UsersSortColumn;
  dir?: 'asc' | 'desc';
  /** Open user sheet. */
  user?: string;
  /** The New user sheet is open. */
  create: boolean;
}

const SORT_COLUMNS: readonly UsersSortColumn[] = ['username', 'role', 'status', 'last_seen', 'created'];

function str(value: unknown): string | undefined {
  if (typeof value === 'number') return String(value);
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/** Read the page's state from the router's (untyped) search object. Anything malformed falls back to the default. */
export function readUsersSearch(search: Record<string, unknown> | undefined): UsersSearch {
  const s = search ?? {};
  const role = str(s['role']);
  const status = str(s['status']);
  const sort = str(s['sort']);
  const dir = str(s['dir']);
  const pageRaw = Number(str(s['page']) ?? '1');
  const create = s['new'];
  return {
    q: typeof s['q'] === 'string' ? s['q'] : typeof s['q'] === 'number' ? String(s['q']) : '',
    ...(role === 'admin' || role === 'user' ? { role } : {}),
    ...(status === 'active' || status === 'disabled' ? { status } : {}),
    page: Number.isInteger(pageRaw) && pageRaw >= 1 ? pageRaw : 1,
    ...(sort && (SORT_COLUMNS as readonly string[]).includes(sort) ? { sort: sort as UsersSortColumn } : {}),
    ...(dir === 'asc' || dir === 'desc' ? { dir } : {}),
    ...(str(s['user']) ? { user: str(s['user']) } : {}),
    // `?new=1`; the router may parse the 1 as a number or `true` as a boolean.
    create: create === 1 || create === '1' || create === true || create === 'true',
  };
}

/**
 * The query-string object for a state: defaults dropped, so the URL says only what differs.
 * `page` and `new` are NUMBERS: TanStack Router's default serializer JSON-quotes a string
 * that parses as JSON, so `'2'` became `?page=%222%22` in the address bar.
 */
export function usersSearchToParams(state: UsersSearch): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  if (state.q.trim()) out['q'] = state.q.trim();
  if (state.role) out['role'] = state.role;
  if (state.status) out['status'] = state.status;
  if (state.page > 1) out['page'] = state.page;
  if (state.sort) out['sort'] = state.sort;
  if (state.sort && state.dir) out['dir'] = state.dir;
  if (state.user) out['user'] = state.user;
  if (state.create) out['new'] = 1;
  return out;
}

/**
 * A filter or search change starts again at page 1: page 7 of the old result set
 * is usually past the end of the new one.
 */
export function withFilters(state: UsersSearch, patch: Partial<Pick<UsersSearch, 'q' | 'role' | 'status' | 'sort' | 'dir'>>): UsersSearch {
  return { ...state, ...patch, page: 1 };
}

export interface UsersListParams {
  q?: string;
  role?: UserRoleFilter;
  status?: UserStatusFilter;
  limit: number;
  offset: number;
  sort?: UsersSortColumn;
  direction?: 'asc' | 'desc';
}

/** What the list request sends for a page state. */
export function usersListParams(state: UsersSearch, pageSize = USERS_PAGE_SIZE): UsersListParams {
  return {
    ...(state.q.trim() ? { q: state.q.trim() } : {}),
    ...(state.role ? { role: state.role } : {}),
    ...(state.status ? { status: state.status } : {}),
    limit: pageSize,
    offset: (state.page - 1) * pageSize,
    ...(state.sort ? { sort: state.sort, direction: state.dir ?? 'asc' } : {}),
  };
}

/** `1–50 of 1,204`; `0 of 0` when empty. Uses an en dash like DataTable's own pager. */
export function pageRangeText(offset: number, count: number, total: number): string {
  const fmt = (n: number) => n.toLocaleString('en-US');
  if (total === 0 || count === 0) return `0 of ${fmt(total)}`;
  return `${fmt(offset + 1)}–${fmt(offset + count)} of ${fmt(total)}`;
}

export function pageCount(total: number, pageSize = USERS_PAGE_SIZE): number {
  return Math.max(1, Math.ceil(total / pageSize));
}

// ---------------------------------------------------------------- time

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * "Last seen" as an admin scans it: `just now`, `5 minutes ago`, `2 hours ago`,
 * `yesterday`, `3 days ago`, then a short local date (`Aug 30`, with the year
 * once it is not this year). `Never` for an account with no session. The exact
 * instant goes in a `title` via {@link absoluteTime}.
 */
export function relativeTime(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return 'Never';
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '—';
  const diff = now.getTime() - at.getTime();
  // A clock a little ahead of ours is still "just now", not "in 3 seconds".
  if (diff < 45_000) return 'just now';
  if (diff < HOUR) {
    const m = Math.max(1, Math.round(diff / MINUTE));
    return m === 1 ? '1 minute ago' : `${m} minutes ago`;
  }
  if (diff < DAY) {
    const h = Math.round(diff / HOUR);
    return h === 1 ? '1 hour ago' : `${h} hours ago`;
  }
  const days = Math.floor(diff / DAY);
  if (days < 2) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  return shortDate(iso, now);
}

/** `Jun 01` style short local date; the year is added when it is not `now`'s year. */
export function shortDate(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return '—';
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '—';
  const base = `${MONTHS[at.getMonth()]} ${String(at.getDate()).padStart(2, '0')}`;
  return at.getFullYear() === now.getFullYear() ? base : `${base}, ${at.getFullYear()}`;
}

/** The full local date and time, for a `title` beside a relative time. */
export function absoluteTime(iso: string | null | undefined): string | undefined {
  if (!iso) return undefined;
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return undefined;
  return at.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

// ---------------------------------------------------------------- passwords

/**
 * The shortest password the create endpoint accepts. The policy's own minimum
 * can be set as low as 1 in Authentication, but `POST /admin/users` validates
 * `@MinLength(8)` before the policy is consulted, so a checklist that said "at
 * least 4 characters" would pass a password the server then refuses.
 */
export const CREATE_USER_MIN_PASSWORD = 8;

export interface PasswordCheck {
  id: 'length' | 'number' | 'uppercase' | 'symbol';
  label: string;
  met: boolean;
}

/**
 * The live checklist under the password field: one line per rule the policy
 * turns on, with the same tests as the server's `validatePassword`
 * (server/src/config/config.service.ts), so a fully ticked list is a password
 * the server accepts.
 */
export function passwordChecklist(policy: PasswordPolicy | undefined, password: string): PasswordCheck[] {
  const min = Math.max(policy?.min_length ?? CREATE_USER_MIN_PASSWORD, CREATE_USER_MIN_PASSWORD);
  const checks: PasswordCheck[] = [{ id: 'length', label: `At least ${min} characters`, met: password.length >= min }];
  if (policy?.require_number) checks.push({ id: 'number', label: 'A number', met: /[0-9]/.test(password) });
  if (policy?.require_uppercase) checks.push({ id: 'uppercase', label: 'An uppercase letter', met: /[A-Z]/.test(password) });
  if (policy?.require_symbol) checks.push({ id: 'symbol', label: 'A symbol', met: /[^A-Za-z0-9]/.test(password) });
  return checks;
}

export function passwordMeetsPolicy(policy: PasswordPolicy | undefined, password: string): boolean {
  return passwordChecklist(policy, password).every((c) => c.met);
}

/** Letters and digits without the look-alikes (0/O, 1/l/I), since this password is read off a screen and retyped. */
const LOWER = 'abcdefghijkmnopqrstuvwxyz';
const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const DIGITS = '23456789';
const SYMBOLS = '!#$%*+-=?@^_~';

/** `n` uniform random integers in [0, max). Injected in tests. */
export type RandomInts = (count: number, max: number) => number[];

/**
 * Uniform integers from `crypto.getRandomValues`, with rejection sampling so a
 * small alphabet is not biased toward its first characters (`x % max` is not
 * uniform unless max divides 2^32).
 */
export const cryptoRandomInts: RandomInts = (count, max) => {
  const out: number[] = [];
  const limit = Math.floor(0x1_0000_0000 / max) * max;
  const buf = new Uint32Array(Math.max(count, 8));
  while (out.length < count) {
    crypto.getRandomValues(buf);
    for (const v of buf) {
      if (v < limit) out.push(v % max);
      if (out.length === count) break;
    }
  }
  return out;
};

export const GENERATED_PASSWORD_LENGTH = 20;

/**
 * A password that satisfies `policy`: at least {@link GENERATED_PASSWORD_LENGTH}
 * characters (more if the policy asks), drawn from every class, with one
 * character from each class the policy REQUIRES placed at a random position, so
 * "require a symbol" can never be missed by chance. Symbols are always included
 * in the pool; they only cost the reader a little, and add strength.
 */
export function generatePassword(policy: PasswordPolicy | undefined, random: RandomInts = cryptoRandomInts): string {
  const length = Math.max(GENERATED_PASSWORD_LENGTH, policy?.min_length ?? 0, CREATE_USER_MIN_PASSWORD);
  const pool = LOWER + UPPER + DIGITS + SYMBOLS;
  const chars = random(length, pool.length).map((i) => pool[i]!);

  const required: string[] = [];
  if (policy?.require_number) required.push(DIGITS);
  if (policy?.require_uppercase) required.push(UPPER);
  if (policy?.require_symbol) required.push(SYMBOLS);
  if (required.length > 0) {
    // Distinct positions: a partial Fisher-Yates over the indexes.
    const positions = Array.from({ length }, (_, i) => i);
    const swaps = random(required.length, length);
    required.forEach((_set, k) => {
      const j = k + (swaps[k]! % (length - k));
      [positions[k], positions[j]] = [positions[j]!, positions[k]!];
    });
    const picks = required.map((set) => random(1, set.length)[0]!);
    required.forEach((set, k) => {
      chars[positions[k]!] = set[picks[k]!]!;
    });
  }
  return chars.join('');
}

// ---------------------------------------------------------------- rules

export interface AccountRules {
  /** Null when the role may be changed; otherwise the sentence saying why not. */
  roleLockedReason: string | null;
  /** Null when the account may be disabled; otherwise why not. Never set for an already-disabled account. */
  disableLockedReason: string | null;
}

/**
 * The server's lockout guardrails (AuthService.updateUser), stated in the sheet
 * BEFORE the admin tries: you cannot demote or disable yourself, and the last
 * active admin cannot be demoted or disabled. `activeAdmins` is the count of
 * active admins (`role=admin&status=active`); undefined while it loads, in
 * which case nothing is claimed and the server remains the backstop.
 */
export function accountRules(user: Pick<AdminUser, 'id' | 'username' | 'role' | 'status'>, meId: string | undefined, activeAdmins: number | undefined): AccountRules {
  const isSelf = meId !== undefined && meId === user.id;
  const onlyActiveAdmin = user.role === 'admin' && user.status === 'active' && activeAdmins !== undefined && activeAdmins <= 1;
  const roleLockedReason = isSelf
    ? 'You cannot change your own role. Another admin can.'
    : onlyActiveAdmin
      ? `${user.username} is the only active admin, so their role cannot change until another account is an admin.`
      : null;
  const disableLockedReason =
    user.status !== 'active'
      ? null
      : isSelf
        ? 'You cannot disable your own account.'
        : onlyActiveAdmin
          ? `${user.username} is the only active admin and cannot be disabled.`
          : null;
  return { roleLockedReason, disableLockedReason };
}

// ---------------------------------------------------------------- create errors

export type NewUserField = 'username' | 'email' | 'password';

/**
 * Where a failed create's message belongs. The server names a duplicate with a
 * `reason` (`username_taken` / `email_taken`); a policy refusal is a 400 whose
 * message starts "Password must"; a class-validator 400 names the field in its
 * message. Anything else stays a form-level error.
 */
export function newUserErrorField(err: { statusCode?: number; reason?: string; message?: unknown } | null | undefined): NewUserField | null {
  if (!err) return null;
  if (err.reason === 'username_taken') return 'username';
  if (err.reason === 'email_taken') return 'email';
  const message = errorText(err).toLowerCase();
  if (err.statusCode === 400) {
    if (message.startsWith('password') || message.includes('password must')) return 'password';
    if (message.includes('email')) return 'email';
    if (message.includes('username')) return 'username';
  }
  return null;
}

/**
 * A server error as one sentence. Nest's validation 400 carries `message` as an
 * ARRAY of constraint messages, which the API client passes through untouched.
 */
export function errorText(err: { message?: unknown } | null | undefined, fallback = ''): string {
  const message = err?.message;
  if (Array.isArray(message)) return message.filter((m) => typeof m === 'string').join('. ') || fallback;
  return typeof message === 'string' && message ? message : fallback;
}
