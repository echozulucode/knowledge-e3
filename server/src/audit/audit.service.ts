import { Inject, Injectable } from '@nestjs/common';
import { Kysely } from 'kysely';
import type { Database } from '../db/schema.js';
import { KYSELY } from '../db/db.module.js';
import { nowIso } from '../common/ids.js';
import { redact } from './redact.js';

export interface AuditEntry {
  actor_id: string | null;
  action: string;
  page_id?: string | null;
  version_id?: string | null;
  payload?: unknown;
}

@Injectable()
export class AuditService {
  constructor(@Inject(KYSELY) private readonly db: Kysely<Database>) {}

  async record(entry: AuditEntry): Promise<void> {
    // Redact sensitive data before serializing.
    const redactedPayload = entry.payload === undefined ? undefined : redact(entry.payload);
    await this.db
      .insertInto('audit_log')
      .values({
        occurred_at: nowIso(),
        actor_id: entry.actor_id,
        action: entry.action,
        page_id: entry.page_id ?? null,
        version_id: entry.version_id ?? null,
        payload_json: redactedPayload === undefined ? null : JSON.stringify(redactedPayload),
      })
      .execute();
  }

  /**
   * Test/admin helper.
   * WARNING: This method should NOT be exposed via a controller endpoint without
   * explicit @AdminOnly() authorization. It returns the entire audit log.
   */
  async list(limit = 50): Promise<unknown[]> {
    return this.db
      .selectFrom('audit_log')
      .selectAll()
      .orderBy('occurred_at', 'desc')
      .limit(limit)
      .execute();
  }
}
