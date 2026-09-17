import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import { AdminOnly } from '../auth/auth.decorators.js';
import {
  AUDIT_LIST_DEFAULT_LIMIT,
  AUDIT_LIST_MAX_LIMIT,
  AuditService,
  type AuditQuery,
} from './audit.service.js';

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * `2026-09-11` as an instant. A bare date in `until` means "through that day",
 * so it resolves to the START of the next day — the exclusive upper bound that
 * actually includes the day the administrator typed.
 */
function instant(raw: string | undefined, param: string, endExclusive = false): string | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  const dateOnly = DATE_ONLY.test(value);
  const parsed = new Date(dateOnly ? `${value}T00:00:00.000Z` : value);
  if (Number.isNaN(parsed.getTime())) {
    throw new BadRequestException(`${param} must be a date (2026-09-11) or an ISO instant`);
  }
  if (dateOnly && endExclusive) parsed.setUTCDate(parsed.getUTCDate() + 1);
  return parsed.toISOString();
}

function limitOf(raw: string | undefined): number | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n < 1) throw new BadRequestException('limit must be a positive integer');
  return Math.min(n, AUDIT_LIST_MAX_LIMIT);
}

/** `?entry=` is a row id. Anything else is a 400, not "no filter": a link that
 * names one entry must never quietly open the whole log. */
function entryOf(raw: string | undefined): number | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  if (!/^\d+$/.test(value)) throw new BadRequestException('entry must be an audit entry id');
  return Number.parseInt(value, 10);
}

/**
 * Admin → Audit (plan §6 D1): the read surface over `audit_log`.
 *
 * `@AdminOnly()` sits on the CLASS, so a route added here cannot forget it. The
 * log names every account on the instance and every change each one made —
 * leaking it to a non-admin is a worse outcome than any single endpoint it
 * describes, which is why there is no `@PublicRead` variant and no per-user
 * "my own activity" relaxation.
 *
 * Read-only by construction: there is no write verb on this controller, so the
 * retention job (`AuditService.trim`) has no HTTP path to it. The log is
 * append-only; the only thing that may remove a row is retention, on boot.
 */
@AdminOnly()
@Controller('admin/audit')
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  async list(
    @Query('actor') actor?: string,
    @Query('action') action?: string,
    @Query('page_id') pageId?: string,
    @Query('since') since?: string,
    @Query('until') until?: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
    // The account or thing acted ON (a user id or username, a source id):
    // "what was done TO bob", where `actor` is "what did bob do".
    @Query('subject') subject?: string,
    @Query('entry') entry?: string,
  ) {
    const from = instant(since, 'since');
    const to = instant(until, 'until', true);
    const id = entryOf(entry);
    const query: AuditQuery = {
      ...(actor?.trim() ? { actor: actor.trim() } : {}),
      ...(action?.trim() ? { action: action.trim() } : {}),
      ...(pageId?.trim() ? { page_id: pageId.trim() } : {}),
      ...(subject?.trim() ? { subject: subject.trim() } : {}),
      ...(id !== undefined ? { id } : {}),
      ...(from ? { since: from } : {}),
      ...(to ? { until: to } : {}),
      limit: limitOf(limit) ?? AUDIT_LIST_DEFAULT_LIMIT,
      ...(cursor?.trim() ? { cursor: cursor.trim() } : {}),
    };
    const [page, actions] = await Promise.all([this.audit.list(query), this.audit.actions()]);
    // `actions` is what the log actually contains, not a hard-coded enum: a row
    // written by code this page has never heard of still gets a filter.
    return { ...page, actions, limit: query.limit };
  }
}
