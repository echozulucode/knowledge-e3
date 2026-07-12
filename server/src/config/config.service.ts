import { Inject, Injectable } from '@nestjs/common';
import { Kysely } from 'kysely';
import type { Database } from '../db/schema.js';
import { KYSELY } from '../db/db.module.js';
import { nowIso } from '../common/ids.js';
import { loadServerConfig } from './server-config.js';

/** Admin-configurable local-password rules. Defaults keep the historical
 * behaviour (8+ chars, no class requirements) so nothing breaks until an admin
 * tightens them. */
export interface PasswordPolicy {
  min_length: number;
  require_number: boolean;
  require_symbol: boolean;
  require_uppercase: boolean;
}

export const DEFAULT_PASSWORD_POLICY: PasswordPolicy = {
  min_length: 8,
  require_number: false,
  require_symbol: false,
  require_uppercase: false,
};

const PASSWORD_POLICY_KEY = 'auth.password_policy';

/**
 * Whether unauthenticated visitors can read published content.
 *  - `public`: anyone may view published pages/items (drafts + writes still need login).
 *  - `authenticated`: a login is required even to view.
 */
export type ReadAccessMode = 'public' | 'authenticated';

const READ_ACCESS_KEY = 'access.read_mode';
const READ_ACCESS_CACHE_MS = 15_000;

const SECTIONS_KEY = 'sections.defs';

/**
 * A curated "section" — a named view over a concept kind (`type`) and/or a space.
 * Sections give purpose-specific landing pages (blogs, FAQs, best practices)
 * while staying OKF-aligned: `type` is the OKF concept kind, `space` the topic.
 */
export interface SectionDef {
  slug: string;
  name: string;
  description?: string;
  /** OKF concept kind to filter by, if any. */
  type?: string;
  /** Space (topic) slug/id to filter by, if any. */
  space?: string;
}

function isSectionDef(value: unknown): value is SectionDef {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as SectionDef).name === 'string' &&
    (value as SectionDef).name.trim() !== ''
  );
}

function slugifySection(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Deploy-time default; the DB value (admin toggle) overrides it. Defaults to
 * `authenticated` so a fresh instance is closed until an admin opts in. Env wins,
 * then the config file (`readAccess.default`), then the safe default. */
function defaultReadAccessMode(): ReadAccessMode {
  const env = process.env['KNOWLEDGE_E3_DEFAULT_READ_ACCESS'];
  if (env === 'public') return 'public';
  if (env === 'authenticated') return 'authenticated';
  return loadServerConfig().readAccess.default;
}

@Injectable()
export class ConfigService {
  private readModeCache?: { value: ReadAccessMode; at: number };

  constructor(@Inject(KYSELY) private readonly db: Kysely<Database>) {}

  // --- system config (admin) ---

  async getAppConfig<T>(key: string, fallback: T): Promise<T> {
    const row = await this.db
      .selectFrom('app_config')
      .select(['value_json'])
      .where('key', '=', key)
      .executeTakeFirst();
    if (!row) return fallback;
    try {
      return JSON.parse(row.value_json) as T;
    } catch {
      return fallback;
    }
  }

  async setAppConfig(key: string, value: unknown, updatedBy: string | null): Promise<void> {
    const value_json = JSON.stringify(value);
    const updated_at = nowIso();
    await this.db
      .insertInto('app_config')
      .values({ key, value_json, updated_at, updated_by: updatedBy })
      .onConflict((oc) => oc.column('key').doUpdateSet({ value_json, updated_at, updated_by: updatedBy }))
      .execute();
  }

  async getPasswordPolicy(): Promise<PasswordPolicy> {
    const stored = await this.getAppConfig<Partial<PasswordPolicy>>(PASSWORD_POLICY_KEY, {});
    return { ...DEFAULT_PASSWORD_POLICY, ...stored };
  }

  async setPasswordPolicy(policy: PasswordPolicy, updatedBy: string | null): Promise<PasswordPolicy> {
    const normalized: PasswordPolicy = {
      min_length: Math.max(1, Math.min(128, Math.floor(policy.min_length))),
      require_number: !!policy.require_number,
      require_symbol: !!policy.require_symbol,
      require_uppercase: !!policy.require_uppercase,
    };
    await this.setAppConfig(PASSWORD_POLICY_KEY, normalized, updatedBy);
    return normalized;
  }

  /** Read on (potentially) every anonymous request, so it's cached briefly. */
  async getReadAccessMode(): Promise<ReadAccessMode> {
    const now = Date.now();
    if (this.readModeCache && now - this.readModeCache.at < READ_ACCESS_CACHE_MS) {
      return this.readModeCache.value;
    }
    const stored = await this.getAppConfig<ReadAccessMode | null>(READ_ACCESS_KEY, null);
    const value: ReadAccessMode =
      stored === 'public' || stored === 'authenticated' ? stored : defaultReadAccessMode();
    this.readModeCache = { value, at: now };
    return value;
  }

  async setReadAccessMode(mode: ReadAccessMode, updatedBy: string | null): Promise<ReadAccessMode> {
    const value: ReadAccessMode = mode === 'public' ? 'public' : 'authenticated';
    await this.setAppConfig(READ_ACCESS_KEY, value, updatedBy);
    this.readModeCache = { value, at: Date.now() };
    return value;
  }

  // --- sections (curated views over type × space) ---

  async getSections(): Promise<SectionDef[]> {
    const stored = await this.getAppConfig<SectionDef[]>(SECTIONS_KEY, []);
    return Array.isArray(stored) ? stored.filter(isSectionDef) : [];
  }

  async setSections(sections: SectionDef[], updatedBy: string | null): Promise<SectionDef[]> {
    const normalized = sections.filter(isSectionDef).map((s) => ({
      slug: slugifySection(s.slug || s.name),
      name: s.name.trim(),
      ...(s.description?.trim() ? { description: s.description.trim() } : {}),
      ...(s.type?.trim() ? { type: s.type.trim() } : {}),
      ...(s.space?.trim() ? { space: s.space.trim() } : {}),
    }));
    await this.setAppConfig(SECTIONS_KEY, normalized, updatedBy);
    return normalized;
  }

  // --- per-user preferences (self-service) ---

  async getUserPrefs(userId: string): Promise<Record<string, unknown>> {
    const rows = await this.db
      .selectFrom('user_prefs')
      .select(['key', 'value_json'])
      .where('user_id', '=', userId)
      .execute();
    const out: Record<string, unknown> = {};
    for (const r of rows) {
      try {
        out[r.key] = JSON.parse(r.value_json);
      } catch {
        /* skip corrupt row */
      }
    }
    return out;
  }

  async setUserPref(userId: string, key: string, value: unknown): Promise<void> {
    const value_json = JSON.stringify(value);
    const updated_at = nowIso();
    await this.db
      .insertInto('user_prefs')
      .values({ user_id: userId, key, value_json, updated_at })
      .onConflict((oc) => oc.columns(['user_id', 'key']).doUpdateSet({ value_json, updated_at }))
      .execute();
  }
}

/**
 * Validate a candidate password against the policy. Returns a list of
 * human-readable failure reasons (empty == valid).
 */
export function validatePassword(policy: PasswordPolicy, password: string): string[] {
  const failures: string[] = [];
  if (password.length < policy.min_length) {
    failures.push(`be at least ${policy.min_length} characters`);
  }
  if (policy.require_number && !/[0-9]/.test(password)) {
    failures.push('include a number');
  }
  if (policy.require_uppercase && !/[A-Z]/.test(password)) {
    failures.push('include an uppercase letter');
  }
  if (policy.require_symbol && !/[^A-Za-z0-9]/.test(password)) {
    failures.push('include a symbol');
  }
  return failures;
}
