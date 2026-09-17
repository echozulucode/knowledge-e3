/**
 * One line per audit row that says what happened, derived from the payload
 * (the admin UX review §4.8): `user.role_change` → "bob: user →
 * admin" instead of `user_id=… username=bob from=user to=admin`.
 *
 * Action codes stay verbatim in their own column; this is the sentence beside
 * them. Every case reads the payload defensively (it is stored JSON, and older
 * rows predate fields newer code writes - `user.password_reset` gained
 * `username`, `token.revoke` gained `token_name` / `owner_username`), and falls
 * back to what the row does carry rather than to nothing.
 *
 * Only fields the API returned are shown, and only the ones named here: the
 * server already redacts secrets when it writes a row, and the fallback for an
 * unknown code additionally skips any key that looks secret-shaped, so a
 * payload shape nobody has reviewed cannot put a credential in a table cell.
 */
import { REFUSAL_SOURCE_LABELS, type RefusalSource } from '../health/refusals.js';
import type { AuditRecord } from './queries.js';

type Entry = Pick<AuditRecord, 'action' | 'payload' | 'page_id' | 'page_slug' | 'page_title'>;

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function text(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

const MAX_TEXT = 60;

function clip(value: string): string {
  return value.length > MAX_TEXT ? `${value.slice(0, MAX_TEXT - 1)}…` : value;
}

function quoted(value: string): string {
  return `"${clip(value)}"`;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
}

function join(...parts: (string | undefined | false)[]): string {
  return parts.filter((p): p is string => typeof p === 'string' && p !== '').join(' · ');
}

/** Content visibility in the words the Authentication page uses. */
const READ_MODE_LABELS: Record<string, string> = { authenticated: 'login required', public: 'public' };

function readMode(value: unknown): string {
  const v = text(value);
  return v ? (READ_MODE_LABELS[v] ?? v) : '?';
}

/** "bob", else "account 1a2b…" for a row that names the account only by id. */
function accountName(payload: Record<string, unknown>): string {
  const name = text(payload['username']);
  if (name) return name;
  const id = text(payload['user_id']);
  return id ? `account ${clip(id)}` : 'an account';
}

function itemName(entry: Entry, payload: Record<string, unknown>): string {
  const title = entry.page_title ?? text(payload['title']);
  if (title) return quoted(title);
  const slug = entry.page_slug ?? text(payload['slug']);
  if (slug) return clip(slug);
  return entry.page_id ? `item ${clip(entry.page_id)}` : 'an item';
}

function days(value: unknown): string {
  const n = num(value);
  return n === undefined ? 'no limit' : plural(n, 'day');
}

function shortDate(iso: unknown): string | undefined {
  const v = text(iso);
  if (!v) return undefined;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? v : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/** `min_length 8 → 12, require_symbol false → true` for the keys that changed. */
function objectDiff(from: unknown, to: unknown, limit = 3): string {
  const a = record(from);
  const b = record(to);
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(
    (k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]),
  );
  if (keys.length === 0) return 'no change';
  const shown = keys.slice(0, limit).map((k) => `${k} ${String(a[k] ?? '—')} → ${String(b[k] ?? '—')}`);
  return keys.length > limit ? `${shown.join(', ')}, +${keys.length - limit} more` : shown.join(', ');
}

/** Keys the fallback never renders, as a second line of defence behind server-side redaction. */
const UNSAFE_KEY = /password|token|secret|authorization|cookie|hash|key/i;

/** Up to three primitive `key: value` pairs, for an action code this file has no case for. */
export function compactPayload(payload: unknown, limit = 3): string {
  if (payload === null || payload === undefined) return '';
  if (typeof payload !== 'object') return clip(String(payload));
  const pairs = Object.entries(record(payload))
    .filter(([key, value]) => !UNSAFE_KEY.test(key) && value !== null && value !== '' && ['string', 'number', 'boolean'].includes(typeof value))
    .slice(0, limit)
    .map(([key, value]) => `${key}: ${clip(String(value))}`);
  return pairs.join(', ');
}

function fromIp(payload: Record<string, unknown>): string | undefined {
  const ip = text(payload['ip']);
  return ip ? `from ${ip}` : undefined;
}

/**
 * The summary for one row. A case per action code the server writes (grep
 * `action:` under server/src); anything else gets `compactPayload`.
 */
export function summarizeAuditEntry(entry: Entry): string {
  const p = record(entry.payload);
  switch (entry.action) {
    // ---- sign-in
    case 'auth.login':
    case 'auth.logout':
      return fromIp(p) ?? '';
    case 'auth.login_failed': {
      const attempted = text(p['username_attempted']);
      return [attempted ? `as ${quoted(attempted)}` : undefined, fromIp(p), p['throttled'] === true ? '(started a lockout)' : undefined]
        .filter(Boolean)
        .join(' ');
    }
    case 'auth.login_throttled': {
      const attempted = text(p['username_attempted']);
      const wait = num(p['retry_after_seconds']);
      return join(
        [attempted ? `as ${quoted(attempted)}` : undefined, fromIp(p)].filter(Boolean).join(' '),
        wait !== undefined ? `locked for ${plural(Math.max(1, Math.ceil(wait / 60)), 'min', 'min')}` : undefined,
      );
    }

    // ---- accounts
    case 'user.create': {
      const role = text(p['role']);
      return `${accountName(p)}${role ? ` (${role})` : ''}`;
    }
    case 'user.role_change':
      return `${accountName(p)}: ${text(p['from']) ?? '?'} → ${text(p['to']) ?? '?'}`;
    case 'user.disable':
      return `${accountName(p)} ${p['disabled'] === false ? 'enabled' : 'disabled'}`;
    case 'user.password_reset':
      return `temporary password for ${accountName(p)}`;
    case 'user.password_change':
      return p['sessions_rotated'] === true ? 'own password · other sessions signed out' : 'own password';

    // ---- tokens (never the value, a prefix or a length - the payload has none)
    case 'token.create': {
      const name = text(p['name']);
      const expires = p['expires_at'] === null ? 'no expiry' : shortDate(p['expires_at']) ? `expires ${shortDate(p['expires_at'])}` : undefined;
      return join(name ? quoted(name) : 'a token', text(p['scope']), expires);
    }
    case 'token.revoke': {
      const name = text(p['token_name']) ?? text(p['name']);
      const owner = text(p['owner_username']);
      const which = name ? quoted(name) : text(p['id']) ? `token ${clip(text(p['id'])!)}` : 'a token';
      if (p['self'] === true) return `${which} (own token)`;
      return owner ? `${which} owned by ${owner}` : which;
    }

    // ---- configuration
    case 'config.read_access_change':
      return `${readMode(p['from'])} → ${readMode(p['to'])}`;
    case 'config.password_policy':
      return objectDiff(p['from'], p['to']);
    case 'config.token_policy':
      return `max token lifetime ${days(p['from_max_days'])} → ${days(p['to_max_days'])}`;
    case 'space.visibility_change':
      return `${text(p['slug']) ?? text(p['space_id']) ?? 'topic'}: ${text(p['from']) ?? '?'} → ${text(p['to']) ?? '?'}`;

    // ---- content
    case 'page.create':
      return join(itemName(entry, p), text(p['status']));
    case 'page.update':
    case 'page.delete':
    case 'page.restore':
      return itemName(entry, p);
    case 'page.rename': {
      const affected = num(p['affected_count']);
      return join(
        `${entry.page_title && text(p['new_title']) !== entry.page_title ? `${quoted(entry.page_title)} → ` : '→ '}${quoted(text(p['new_title']) ?? '?')}`,
        affected !== undefined && affected > 1 ? `${plural(affected, 'item')} updated` : undefined,
      );
    }
    case 'content.refused': {
      const rules = Array.isArray(p['rules'])
        ? p['rules'].map((r) => text(record(r)['code'])).filter((c): c is string => Boolean(c))
        : [];
      const source = text(p['source']);
      const shownRules = rules.length > 3 ? `${rules.slice(0, 3).join(', ')}, +${rules.length - 3} more` : rules.join(', ');
      return join(
        itemName(entry, p),
        text(p['reason']),
        shownRules ? `rules: ${shownRules}` : undefined,
        source ? `via ${REFUSAL_SOURCE_LABELS[source as RefusalSource] ?? source}` : undefined,
      );
    }
    case 'content.publish_lint_override': {
      const n = Array.isArray(p['diagnostics']) ? p['diagnostics'].length : undefined;
      return join(itemName(entry, p), n !== undefined ? `published over ${plural(n, 'error')}` : 'published over errors');
    }
    case 'mcp.create_item': {
      const client = text(p['client']);
      return join(itemName(entry, p), client ? `via ${client}` : 'via MCP');
    }

    // ---- data
    case 'okf.export': {
      const items = num(p['item_count']);
      const assets = num(p['assets']);
      return join(
        text(p['format']),
        items !== undefined ? plural(items, 'item') : undefined,
        assets !== undefined ? plural(assets, 'asset') : undefined,
        text(p['space']) ? `topic ${text(p['space'])}` : undefined,
        text(p['type']) ? `type ${text(p['type'])}` : undefined,
      );
    }
    case 'okf.import': {
      const created = num(p['created']) ?? 0;
      const updated = num(p['updated']) ?? 0;
      return join(text(p['format']), `${created.toLocaleString('en-US')} created, ${updated.toLocaleString('en-US')} updated`);
    }
    case 'okf.import_rejected':
      return join(text(p['format']), text(p['reason']));

    // ---- sources
    case 'source.upsert': {
      const id = text(p['id']) ?? 'source';
      const from = text(p['mode_from']);
      const to = text(p['mode_to']);
      const fields = Array.isArray(p['fields']) ? p['fields'].map(text).filter(Boolean).join(', ') : '';
      return join(
        `${p['created'] === true ? 'created' : 'updated'} ${id}`,
        from && to && from !== to ? `mode ${from} → ${to}` : undefined,
        p['created'] !== true && fields ? `fields: ${clip(fields)}` : undefined,
      );
    }
    case 'source.remove':
      return join(`removed ${text(p['id']) ?? 'source'}`, text(p['mode']));
    case 'source.conflict_resolve':
      return join(text(p['source_id']), text(p['path']) ? clip(text(p['path'])!) : undefined, text(p['resolution']));

    // ---- written by the server itself
    case 'audit.retention_trim': {
      const removed = num(p['removed']);
      return join(
        removed !== undefined ? `removed ${plural(removed, 'entry', 'entries')}` : 'trimmed',
        shortDate(p['cutoff']) ? `older than ${shortDate(p['cutoff'])}` : undefined,
        num(p['retention_days']) !== undefined ? `retention ${days(p['retention_days'])}` : undefined,
      );
    }
    case 'backup.drill_run': {
      const outcome = text(p['outcome']);
      if (outcome === 'failed') return join('failed', text(p['failure']) ? clip(text(p['failure'])!) : undefined);
      const rpo = num(p['rpo_seconds']);
      const rto = num(p['rto_seconds']);
      return join(outcome ?? 'ran', rpo !== undefined ? `RPO ${rpo}s` : undefined, rto !== undefined ? `RTO ${rto}s` : undefined);
    }

    default:
      return compactPayload(entry.payload);
  }
}

export interface AuditSubject {
  /** What `?subject=` is set to: a username where the row has one, else an id. */
  value: string;
  /** How the detail names it. */
  label: string;
}

/**
 * The account or thing a row acted on, for the detail's "Filter by subject".
 * Mirrors the payload keys the server's subject filter matches
 * (audit.service.ts SUBJECT_ID_KEYS / SUBJECT_NAME_KEYS), so the link always
 * finds at least the row it came from.
 */
export function auditSubject(entry: Pick<AuditRecord, 'action' | 'payload'>): AuditSubject | null {
  const p = record(entry.payload);
  const username = text(p['username']);
  const userId = text(p['user_id']);
  if (entry.action.startsWith('user.') && (username || userId)) {
    return { value: username ?? userId!, label: username ?? `account ${userId}` };
  }
  const attempted = text(p['username_attempted']);
  if (attempted) return { value: attempted, label: `${quoted(attempted)} (name tried)` };
  if (entry.action.startsWith('token.')) {
    const owner = text(p['owner_username']);
    if (owner) return { value: owner, label: owner };
    const id = text(p['id']);
    const name = text(p['token_name']) ?? text(p['name']);
    return id ? { value: id, label: name ? `token ${quoted(name)}` : `token ${id}` } : null;
  }
  if (entry.action.startsWith('source.')) {
    const id = text(p['source_id']) ?? text(p['id']);
    return id ? { value: id, label: `source ${id}` } : null;
  }
  const spaceId = text(p['space_id']);
  if (spaceId) return { value: spaceId, label: `topic ${text(p['slug']) ?? spaceId}` };
  return null;
}
