import { BadRequestException, Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { Kysely } from 'kysely';
import type { SectionSlot } from '@echozedlabs/knowledge-types';
import type { Database } from '../db/schema.js';
import { KYSELY } from '../db/db.module.js';
import { nowIso } from '../common/ids.js';
import {
  assetUrl,
  declareSiteAssets,
  loginThrottleOrigin,
  loginThrottleSettings,
  readAccessDefaultOrigin,
  type DeploySettingOrigin,
} from './server-config.js';

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

/** Exported so the first-run admin bootstrap can read the same row without a Nest context (auth/seed-admin.ts). */
export const PASSWORD_POLICY_KEY = 'auth.password_policy';

/**
 * Whether unauthenticated visitors can read published content.
 *  - `public`: anyone may view published pages/items (drafts + writes still need login).
 *  - `authenticated`: a login is required even to view.
 */
export type ReadAccessMode = 'public' | 'authenticated';

const READ_ACCESS_KEY = 'access.read_mode';
const READ_ACCESS_CACHE_MS = 15_000;

/** Longest lifetime (days) a personal access token may be created with; null = unlimited. */
const TOKEN_MAX_DAYS_KEY = 'auth.token_max_days';

/** Exported so the seed writes the tenant's first Section under the same key this service reads. */
export const SECTIONS_KEY = 'sections.defs';

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
  /**
   * Tags to filter by. An item matches if it carries ANY of them (OR); the tag
   * filter then ANDs with `type` and `space`. Plural because a curator naming a
   * section "News" means `news` OR `release` OR `announcement`, not one of them.
   * Tags are emergent here, so a tag nobody has used yet simply resolves to no
   * items — `topic()` drops the empty section rather than erroring.
   */
  tags?: string[];
  /** Landing-page slot this section fills on a `portal` topic (plan §3.2). */
  slot?: SectionSlot;
  /** Display order (ascending); unordered sections sort after ordered ones, by name. */
  order?: number;
  /** Max items resolved into the slot (1–50). */
  limit?: number;
}

export const SECTION_SLOTS: SectionSlot[] = ['start-here', 'essential', 'examples', 'limitations', 'advanced', 'latest', 'none'];
const SECTION_LIMIT_MAX = 50;

/** Exported for the seed, for the same reason as SECTIONS_KEY. */
export const PINNED_TOPICS_KEY = 'home.pinned_topics';

/**
 * One featured topic on the home page (home-prototype plan §3.3/§4): the topic,
 * an optional colour and an optional cover image.
 *
 * **Colour is a token name, never a hex.** `PIN_COLORS` are the six entries in
 * `packages/ui/src/tokens.css`, each with a light and a dark value, so a tenant
 * cannot pick something unreadable in one theme — and the renderer only ever
 * uses it for a rule and an icon tint, never as a background behind text. The
 * topic's NAME carries the category; the colour is recognition on the fifth
 * visit, which is why a colourblind reader and a greyscale screenshot lose
 * nothing.
 *
 * The cover is an asset URL on the same terms as `site.logo` — uploaded through
 * the content-addressed path so the bytes live in the repository — and
 * `cover_dark` exists because a light tenant image on a dark card is a problem
 * this codebase has already hit once with the logo.
 */
export interface PinnedTopicDef {
  /** Topic slug (or id). Resolved per viewer when the home page asks. */
  topic: string;
  color?: PinColor;
  icon?: PinIcon;
  cover?: string;
  cover_dark?: string;
}

export const PIN_COLORS = ['teal', 'ochre', 'green', 'violet', 'slate', 'plum'] as const;
export type PinColor = (typeof PIN_COLORS)[number];

/** Topic icon tokens (home plan R2.5): a closed list, like colour. Mirrors `PIN_ICONS` in packages/ui. */
export const PIN_ICONS = ['book', 'bookOpen', 'compass', 'diagramProject', 'circleNodes', 'layerGroup', 'gear', 'wrench', 'shieldHalved', 'key', 'users', 'boltLightning', 'gaugeHigh', 'desktop', 'scaleBalanced', 'listCheck', 'star', 'tag'] as const;
export type PinIcon = (typeof PIN_ICONS)[number];

/**
 * "A small number of key topics" — six, capped the way `bundleLinks` caps
 * `MAX_LINKS`. Past about six the right-hand column stops being a masthead and
 * becomes the topic index, which already exists at `/topics`. Mirrored for the
 * admin editor in web/src/pages/pinnedTopicsModel.ts — change both.
 */
export const MAX_PINNED_TOPICS = 6;

/**
 * Normalize one pin, or drop it. Malformed fields are dropped rather than
 * refused, following `siteConfig()`'s rule for branding: a typo in a colour
 * name must cost the tenant that colour, never the site its front page. A pin
 * with no topic is the one thing that cannot be salvaged.
 */
function normalizePin(raw: unknown): PinnedTopicDef | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const value = raw as Record<string, unknown>;
  const topic = typeof value['topic'] === 'string' ? value['topic'].trim() : '';
  if (!topic) return null;
  const color = typeof value['color'] === 'string' ? value['color'].trim().toLowerCase() : '';
  // Case-sensitive, unlike colour: the tokens are `appIcons` keys (`bookOpen`),
  // and a folded `bookopen` names nothing the web app can draw.
  const icon = typeof value['icon'] === 'string' ? value['icon'].trim() : '';
  const cover = assetUrl(value['cover']);
  const coverDark = assetUrl(value['cover_dark']);
  return {
    topic,
    ...(PIN_COLORS.includes(color as PinColor) ? { color: color as PinColor } : {}),
    ...(PIN_ICONS.includes(icon as PinIcon) ? { icon: icon as PinIcon } : {}),
    ...(cover ? { cover } : {}),
    // A dark cover without a light one is not a fallback pair, it is a mistake;
    // the resolver falls `cover_dark` back to `cover`, never the other way.
    ...(cover && coverDark ? { cover_dark: coverDark } : {}),
  };
}

function isSectionDef(value: unknown): value is SectionDef {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as SectionDef).name === 'string' &&
    (value as SectionDef).name.trim() !== ''
  );
}

/** The optional fields; when present they must be well-formed (400 otherwise). */
function assertSlotFields(s: SectionDef): void {
  if (s.slot !== undefined && !SECTION_SLOTS.includes(s.slot)) {
    throw new BadRequestException(`section "${s.name}": invalid slot "${String(s.slot)}"`);
  }
  if (s.tags !== undefined && (!Array.isArray(s.tags) || s.tags.some((t) => typeof t !== 'string'))) {
    throw new BadRequestException(`section "${s.name}": tags must be a list of strings`);
  }
  if (s.order !== undefined && !Number.isFinite(s.order)) {
    throw new BadRequestException(`section "${s.name}": order must be a number`);
  }
  if (s.limit !== undefined && !(Number.isInteger(s.limit) && s.limit >= 1 && s.limit <= SECTION_LIMIT_MAX)) {
    throw new BadRequestException(`section "${s.name}": limit must be an integer between 1 and ${SECTION_LIMIT_MAX}`);
  }
}

/**
 * Trim, drop blanks, de-dupe, sort — the same shape `page_tags` rows are stored
 * in, so a section's tag matches verbatim. Deliberately NOT lower-cased: stored
 * tags keep their case, and folding here would silently stop matching them.
 * An empty list normalizes away, so "no tags" means "no tag filter" rather than
 * "match nothing" — the same way a blank `type` means "any type".
 */
function normalizeSectionTags(tags: string[] | undefined): string[] {
  if (!Array.isArray(tags)) return [];
  return Array.from(new Set(tags.map((t) => t.trim()).filter(Boolean))).sort();
}

function bySectionOrder(a: SectionDef, b: SectionDef): number {
  const ao = a.order ?? Number.POSITIVE_INFINITY;
  const bo = b.order ?? Number.POSITIVE_INFINITY;
  return ao - bo || a.name.localeCompare(b.name);
}

function slugifySection(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Deploy-time default; the DB value (admin toggle) overrides it. Defaults to
 * `public` so published knowledge in public Spaces is openly readable. Drafts,
 * private Spaces, and writes remain protected. Env wins, then the config file
 * (`readAccess.default`), then the built-in default — see `readAccessDefaultOrigin`. */
function defaultReadAccessMode(): ReadAccessMode {
  return readAccessDefaultOrigin().value;
}

/**
 * Where an auth setting's effective value comes from (Admin → Authentication's
 * provenance line): set by an admin (a row in `app_config`), a deploy-time
 * layer (`env` / `config`), or the built-in `default`.
 */
export type AuthSettingSource = 'admin' | 'env' | 'config' | 'default';

export interface SettingProvenance {
  source: AuthSettingSource;
  /** When an admin last saved it; null unless `source` is `admin`. */
  updated_at: string | null;
  /** Who saved it; null unless `source` is `admin`, or when the row names no (or an unknown) account. */
  updated_by_username: string | null;
  /** Env variable NAMES in effect when `source` is `env`; empty otherwise. */
  env_vars: string[];
}

function deployProvenance(origin: DeploySettingOrigin): SettingProvenance {
  return { source: origin.source, updated_at: null, updated_by_username: null, env_vars: origin.env_vars };
}

@Injectable()
export class ConfigService implements OnModuleInit {
  private readModeCache?: { value: ReadAccessMode; at: number };

  constructor(@Inject(KYSELY) private readonly db: Kysely<Database>) {}

  /**
   * Tell `server-config` which asset files the pin list has declared as chrome,
   * before the first request arrives. Without this priming a cover would 404
   * for an anonymous visitor until something had already read the pin list —
   * which is exactly the request that needs it.
   */
  async onModuleInit(): Promise<void> {
    await this.getPinnedTopics();
  }

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

  /**
   * Who last wrote an `app_config` key and when, or null when no row exists (the
   * setting is on its default). `updated_by` is kept on every write; the join
   * resolves it to a username for the page, and a soft-deleted (disabled)
   * account still resolves, so the line keeps saying who did it.
   */
  private async adminWrite(key: string): Promise<{ updated_at: string; updated_by_username: string | null } | null> {
    const row = await this.db
      .selectFrom('app_config')
      .leftJoin('users', 'users.id', 'app_config.updated_by')
      .select(['app_config.updated_at as updated_at', 'users.username as username'])
      .where('app_config.key', '=', key)
      .executeTakeFirst();
    return row ? { updated_at: row.updated_at, updated_by_username: row.username ?? null } : null;
  }

  private async keyProvenance(key: string, otherwise: SettingProvenance): Promise<SettingProvenance> {
    const write = await this.adminWrite(key);
    return write ? { source: 'admin', ...write, env_vars: [] } : otherwise;
  }

  /**
   * Every auth setting Admin → Authentication shows, with where each value came
   * from. Read access is the one with both layers: an admin choice overrides
   * the deploy default, so the default is reported too ("overrides …"). The
   * login throttle has no admin layer at all and is marked `editable: false`.
   */
  async getAuthSettings() {
    const readOrigin = readAccessDefaultOrigin();
    const throttle = loginThrottleSettings();
    const [read_mode, readProv, policy, policyProv, max_days, tokenProv] = await Promise.all([
      this.getReadAccessMode(),
      this.keyProvenance(READ_ACCESS_KEY, deployProvenance(readOrigin)),
      this.getPasswordPolicy(),
      this.keyProvenance(PASSWORD_POLICY_KEY, deployProvenance({ source: 'default', env_vars: [] })),
      this.getTokenMaxDays(),
      this.keyProvenance(TOKEN_MAX_DAYS_KEY, deployProvenance({ source: 'default', env_vars: [] })),
    ]);
    return {
      read_access: {
        read_mode,
        provenance: readProv,
        deploy_default: { read_mode: readOrigin.value, ...deployProvenance(readOrigin) },
        editable: true,
      },
      password_policy: { policy, provenance: policyProv, editable: true },
      token_policy: { max_days, provenance: tokenProv, editable: true },
      login_throttle: {
        window_ms: throttle.windowMs,
        per_username: throttle.perUsername,
        per_ip: throttle.perIp,
        provenance: deployProvenance(loginThrottleOrigin()),
        editable: false,
      },
    };
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
  // --- personal access token policy (admin) ---

  async getTokenMaxDays(): Promise<number | null> {
    const stored = await this.getAppConfig<number | null>(TOKEN_MAX_DAYS_KEY, null);
    return typeof stored === 'number' && Number.isFinite(stored) && stored > 0 ? Math.floor(stored) : null;
  }

  async setTokenMaxDays(days: number | null, updatedBy: string | null): Promise<number | null> {
    const value = days === null ? null : Math.max(1, Math.min(3650, Math.floor(days)));
    await this.setAppConfig(TOKEN_MAX_DAYS_KEY, value, updatedBy);
    return value;
  }

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
    return Array.isArray(stored) ? stored.filter(isSectionDef).sort(bySectionOrder) : [];
  }

  async setSections(sections: SectionDef[], updatedBy: string | null): Promise<SectionDef[]> {
    const valid = sections.filter(isSectionDef);
    for (const s of valid) assertSlotFields(s);
    const normalized = valid.map((s) => ({
      slug: slugifySection(s.slug || s.name),
      name: s.name.trim(),
      ...(s.description?.trim() ? { description: s.description.trim() } : {}),
      ...(s.type?.trim() ? { type: s.type.trim() } : {}),
      ...(s.space?.trim() ? { space: s.space.trim() } : {}),
      ...(normalizeSectionTags(s.tags).length ? { tags: normalizeSectionTags(s.tags) } : {}),
      ...(s.slot !== undefined ? { slot: s.slot } : {}),
      ...(s.order !== undefined ? { order: s.order } : {}),
      ...(s.limit !== undefined ? { limit: s.limit } : {}),
    })).sort(bySectionOrder);
    await this.setAppConfig(SECTIONS_KEY, normalized, updatedBy);
    return normalized;
  }

  // --- pinned topics (the home page's featured topics) ---

  /**
   * The curated pin list, newest write wins, in the tenant's order.
   *
   * **Stored in `app_config`, deliberately and provisionally.** The durable
   * home for this is the home topic's bundle `index.md` beside `links:` — that
   * is where every other piece of topic presentation is authored, it travels
   * with the content, and a rebuild-from-git restores it (see
   * `SiteController.getSiteLinks` for the argument in full). `links:`, though,
   * is hand-authored in git and has no admin write path at all, and Eric's
   * constraint here is precisely about the WRITE path: an administrator sets
   * these, an individual cannot. `app_config` through an admin-only route is
   * the pattern Sections already use, is admin-gated by construction, and is
   * captured by `scripts/backup.ts`. Migrating later is additive: teach
   * `parseBundleIndex` a `pinned_topics:` block, read it here first and treat
   * this key as the fallback, then write a one-shot that emits the stored list
   * into the bundle. Nothing below assumes the storage.
   */
  async getPinnedTopics(): Promise<PinnedTopicDef[]> {
    const stored = await this.getAppConfig<unknown[]>(PINNED_TOPICS_KEY, []);
    const pins = (Array.isArray(stored) ? stored : [])
      .map(normalizePin)
      .filter((p): p is PinnedTopicDef => p !== null)
      .slice(0, MAX_PINNED_TOPICS);
    declareSiteAssets(pins.flatMap((p) => [p.cover, p.cover_dark]));
    return pins;
  }

  async setPinnedTopics(pins: unknown[], updatedBy: string | null): Promise<PinnedTopicDef[]> {
    const normalized = (Array.isArray(pins) ? pins : [])
      .map(normalizePin)
      .filter((p): p is PinnedTopicDef => p !== null)
      .slice(0, MAX_PINNED_TOPICS);
    await this.setAppConfig(PINNED_TOPICS_KEY, normalized, updatedBy);
    // Refresh before returning, so the cover an admin has just pinned is
    // publicly fetchable by the time their browser asks for it.
    declareSiteAssets(normalized.flatMap((p) => [p.cover, p.cover_dark]));
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
