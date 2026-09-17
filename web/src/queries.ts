/**
 * TanStack Query hooks for knowledge-e3 API.
 */

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ItemSourceRef, ReviewRef, SectionSlot } from '@echozedlabs/knowledge-types';
import { apiClient } from './api.js';
import { createLimiter, sameSection, upsertSection } from './pages/sectionsAdminModel.js';

export interface User {
  id: string;
  username: string;
  email: string;
  role: 'user' | 'admin';
}

export interface Page {
  id: string;
  title: string;
  slug: string;
  // Server returns body_markdown (the body without frontmatter) and raw_markdown
  // (the full document including frontmatter). UI generally consumes body_markdown.
  body_markdown: string;
  raw_markdown?: string;
  status: 'draft' | 'published';
  type?: string | null;
  version_token: number;
  created_at: string;
  updated_at: string;
  /** First-published timestamp (null while a draft). Stable across edits. */
  published_at?: string | null;
  deleted_at?: string | null;
  authors?: string[];
  tags?: string[];
  categories?: string[];
  groups?: string[];
  space_id?: string;
  frontmatter?: Record<string, unknown>;
  /** The change request this item's edits are staged on (plan §8.2), or null. */
  review?: ReviewRef | null;
  /**
   * The registered source holding the canonical file (plan §8.3), or null when
   * the row records none. `role: 'reference'` means the content is another
   * team's, `mode: 'read-only'` that nothing here writes back; `url` is derived
   * from the remote and is null whenever we cannot address the host, which is
   * the normal case rather than an error.
   */
  source?: ItemSourceRef | null;
}

export interface SearchResult {
  id: string;
  title: string;
  slug: string;
  updated_at: string;
  score?: number;
  snippet?: string;
  matched_fields?: string[];
  reasons?: string[];
  status?: 'draft' | 'published';
  type?: string | null;
  topic?: string;
  tags?: string[];
  categories?: string[];
  groups?: string[];
  /** Derived OKF v0.2 trust tier (§5.3). */
  trust_tier?: 'unverified' | 'machine-confirmed' | 'human-reviewed';
  /** Derived OKF v0.2 freshness (§5.5): true when past `stale_after`. */
  stale?: boolean;
  /** The change request this item's edits are staged on (plan §8.2), or null. */
  review?: ReviewRef | null;
}

export interface TaxonomyScope {
  type: 'global' | 'space';
  space_id: string | null;
  space_slug: string | null;
}

export interface TaxonomyCategory {
  id?: string;
  name: string;
  slug: string;
  count: number;
  color?: string | null;
  icon?: string | null;
  scope?: TaxonomyScope;
  /** Set only on `GET /taxonomy/categories/archived` rows. */
  archived_at?: string | null;
}

export interface TaxonomyTag extends TaxonomyCategory {
  id: string;
  scope: TaxonomyScope;
}

export interface TaxonomyGroup extends TaxonomyCategory {
  id: string;
  scope: TaxonomyScope;
  description?: string | null;
}

export interface Topic {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
  counts?: {
    items: number;
    published: number;
    draft: number;
  };
  color?: string | null;
  icon?: string | null;
}

// Auth

export function useMe() {
  return useQuery({
    queryKey: ['me'],
    queryFn: async () => {
      const res = await apiClient.get<{ user: User }>('/me');
      return res.user;
    },
    retry: false,
  });
}

export type ReadAccessMode = 'public' | 'authenticated';

/** Instance read-access mode. Public endpoint — works for anonymous visitors. */
export function useAccess() {
  return useQuery({
    queryKey: ['access'],
    queryFn: async () => {
      const res = await apiClient.get<{ read_mode: ReadAccessMode }>('/access');
      return res.read_mode;
    },
    staleTime: 60_000,
  });
}

export function useSetAccess() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (read_mode: ReadAccessMode) => {
      const res = await apiClient.put<{ read_mode: ReadAccessMode }>('/admin/access', { read_mode });
      return res.read_mode;
    },
    onSuccess: (mode) => {
      queryClient.setQueryData(['access'], mode);
      // The provenance line now says who set it and when.
      queryClient.invalidateQueries({ queryKey: AUTH_SETTINGS_KEY });
    },
  });
}

export function useLogin() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (credentials: { username: string; password: string }) => {
      const res = await apiClient.post<{ user: User }>('/auth/login', credentials);
      return res.user;
    },
    onSuccess: (user) => {
      queryClient.setQueryData(['me'], user);
    },
  });
}

export function useLogout() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => apiClient.post('/auth/logout'),
    onSuccess: () => {
      queryClient.clear();
    },
  });
}

export function useChangePassword() {
  return useMutation({
    mutationFn: (input: { old_password: string; new_password: string }) =>
      apiClient.post('/me/password', input),
  });
}

// Admin user management

export interface AdminUser {
  id: string;
  username: string;
  email: string;
  role: 'user' | 'admin';
  status: 'active' | 'disabled';
  created_at: string;
  last_seen_at: string | null;
}

export function useUsers(filters?: { q?: string; role?: string; status?: string }) {
  const params = new URLSearchParams();
  if (filters?.q) params.set('q', filters.q);
  if (filters?.role) params.set('role', filters.role);
  if (filters?.status) params.set('status', filters.status);
  const qs = params.size ? `?${params.toString()}` : '';
  return useQuery({
    queryKey: ['admin', 'users', filters?.q ?? '', filters?.role ?? '', filters?.status ?? ''],
    queryFn: async () => {
      const res = await apiClient.get<{ users: AdminUser[] }>(`/admin/users${qs}`);
      return res.users;
    },
  });
}

/** One page of `GET /admin/users`; `total` counts every account matching the filters. */
export interface AdminUsersPage {
  users: AdminUser[];
  total: number;
  limit: number;
  offset: number;
}

export interface AdminUsersPageParams {
  q?: string;
  role?: 'user' | 'admin';
  status?: 'active' | 'disabled';
  limit?: number;
  offset?: number;
  sort?: 'username' | 'role' | 'status' | 'last_seen' | 'created';
  direction?: 'asc' | 'desc';
}

/**
 * Server-paged users list (the admin UX review §4.3). Keeps the
 * previous page on screen while the next one loads (`keepPreviousData`), so
 * typing in the search box or paging never flashes an empty table. Keyed under
 * `['admin', 'users']` so every user mutation's invalidation refreshes it.
 */
export function useUsersPage(params: AdminUsersPageParams) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(key, String(value));
  }
  const qs = search.toString();
  return useQuery({
    queryKey: ['admin', 'users', 'page', qs],
    queryFn: () => apiClient.get<AdminUsersPage>(`/admin/users${qs ? `?${qs}` : ''}`),
    placeholderData: keepPreviousData,
  });
}

/**
 * The header's "N accounts · M active admins", and the "only active admin" rule
 * in the user sheet. Two `limit=1` requests: only `total` is read.
 */
export function useUserCounts() {
  const all = useUsersPage({ limit: 1 });
  const admins = useUsersPage({ role: 'admin', status: 'active', limit: 1 });
  return { accounts: all.data?.total, activeAdmins: admins.data?.total };
}

/** One account for the user sheet, so `?user=<id>` opens even when that user is not on the current page. */
export function useAdminUser(id: string | undefined) {
  return useQuery({
    queryKey: ['admin', 'users', 'one', id],
    queryFn: async () => (await apiClient.get<{ user: AdminUser }>(`/admin/users/${encodeURIComponent(id!)}`)).user,
    enabled: Boolean(id),
  });
}

export function useCreateUser() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { email: string; username: string; password: string; role: 'user' | 'admin' }) => {
      const res = await apiClient.post<{ user: User }>('/admin/users', input);
      return res.user;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'users'] });
    },
  });
}

export function useUpdateUser() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string; role?: 'user' | 'admin'; disabled?: boolean }) => {
      const { id, ...patch } = input;
      const res = await apiClient.patch<{ user: AdminUser }>(`/admin/users/${id}`, patch);
      return res.user;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'users'] });
    },
  });
}

export function useResetUserPassword() {
  return useMutation({
    mutationFn: async (id: string) => {
      const res = await apiClient.post<{ temporary_password: string }>(`/admin/users/${id}/reset-password`);
      return res.temporary_password;
    },
  });
}

// Authentication config (admin)

export interface PasswordPolicy {
  min_length: number;
  require_number: boolean;
  require_symbol: boolean;
  require_uppercase: boolean;
}

export function usePasswordPolicy() {
  return useQuery({
    queryKey: ['admin', 'password-policy'],
    queryFn: async () => {
      const res = await apiClient.get<{ policy: PasswordPolicy }>('/admin/auth/password-policy');
      return res.policy;
    },
  });
}

export function useUpdatePasswordPolicy() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (policy: PasswordPolicy) => {
      const res = await apiClient.put<{ policy: PasswordPolicy }>('/admin/auth/password-policy', policy);
      return res.policy;
    },
    onSuccess: (policy) => {
      queryClient.setQueryData(['admin', 'password-policy'], policy);
      queryClient.invalidateQueries({ queryKey: AUTH_SETTINGS_KEY });
    },
  });
}

/**
 * Where an auth setting's value comes from (`GET /admin/auth/settings`):
 * saved in admin, a deploy-time layer, or the built-in default. `env_vars` are
 * variable NAMES only.
 */
export type AuthSettingSource = 'admin' | 'env' | 'config' | 'default';

export interface SettingProvenance {
  source: AuthSettingSource;
  updated_at: string | null;
  updated_by_username: string | null;
  env_vars: string[];
}

export interface AuthSettings {
  read_access: {
    read_mode: ReadAccessMode;
    provenance: SettingProvenance;
    /** What applies when no admin has chosen; an admin choice overrides it. */
    deploy_default: SettingProvenance & { read_mode: ReadAccessMode };
    editable: boolean;
  };
  password_policy: { policy: PasswordPolicy; provenance: SettingProvenance; editable: boolean };
  token_policy: { max_days: number | null; provenance: SettingProvenance; editable: boolean };
  /** Deploy-time only (config file / env); shown read-only. */
  login_throttle: {
    window_ms: number;
    per_username: number | null;
    per_ip: number | null;
    provenance: SettingProvenance;
    editable: false;
  };
}

/** Exported so the token-policy mutation (features/tokens) refreshes provenance too. */
export const AUTH_SETTINGS_KEY = ['admin', 'auth-settings'] as const;

/** Every setting on Admin → Authentication, with provenance. Admin only. */
export function useAuthSettings() {
  return useQuery({
    queryKey: AUTH_SETTINGS_KEY,
    queryFn: () => apiClient.get<AuthSettings>('/admin/auth/settings'),
  });
}

// Per-user preferences (self-service)

export function useUserPrefs() {
  return useQuery({
    queryKey: ['me', 'prefs'],
    queryFn: async () => {
      const res = await apiClient.get<{ prefs: Record<string, unknown> }>('/me/prefs');
      return res.prefs;
    },
    retry: false,
  });
}

export function useSetUserPref() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { key: string; value: unknown }) => {
      const res = await apiClient.put<{ prefs: Record<string, unknown> }>('/me/prefs', input);
      return res.prefs;
    },
    onSuccess: (prefs) => {
      queryClient.setQueryData(['me', 'prefs'], prefs);
    },
  });
}

// Pages

/** The `GET /pages` query. */
export interface PageFilters {
  status?: string;
  tag?: string;
  /** Any-of tag filter (a Section's tags); ANDs with `type`/`space`. */
  tags?: string[];
  since?: string;
  limit?: number;
  type?: string;
  space?: string;
  sort?: 'updated' | 'published' | 'created' | 'title';
}

function pagesPath(filters?: PageFilters): string {
  const params = new URLSearchParams();
  if (filters?.status) params.set('status', filters.status);
  if (filters?.tag) params.set('tag', filters.tag);
  for (const tag of filters?.tags ?? []) params.append('tags', tag);
  if (filters?.since) params.set('since', filters.since);
  if (filters?.limit) params.set('limit', String(filters.limit));
  if (filters?.type) params.set('type', filters.type);
  if (filters?.space) params.set('space', filters.space);
  if (filters?.sort) params.set('sort', filters.sort);
  return `/pages${params.size ? '?' + params.toString() : ''}`;
}

export function usePages(filters?: PageFilters) {
  return useQuery({
    queryKey: ['pages', filters],
    queryFn: async () => {
      const res = await apiClient.get<{ items: Page[]; total: number }>(pagesPath(filters));
      return res.items;
    },
  });
}

/**
 * `usePages` plus `total` — every match, not the page length (the server
 * counts it separately since the Sections redesign). A sibling hook rather
 * than a changed return type, so existing `usePages` callers keep their array.
 * Keyed under `['pages', …]` so a page write's `invalidateQueries(['pages'])`
 * refreshes it too.
 */
export function usePagesWithTotal(filters: PageFilters, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ['pages', 'with-total', filters],
    queryFn: () => apiClient.get<{ items: Page[]; total: number }>(pagesPath(filters)),
    enabled: options?.enabled ?? true,
    // Keep the last preview while the next filter's answer arrives, so the
    // aside does not collapse to "Loading" on every keystroke.
    placeholderData: (previous) => previous,
  });
}

/**
 * Match counts for the Sections list share one queue of at most this many
 * requests. A list of 50 sections would otherwise fire 50 `/pages` reads at
 * once on every visit; queued, cached for a minute, and asking for one row
 * each (`limit=1` — the count ignores it), they cost little.
 */
const MATCH_COUNT_CONCURRENCY = 4;
const matchCountQueue = createLimiter(MATCH_COUNT_CONCURRENCY);

/** Query options for one match count — for `useQueries` over a whole list, or `useMatchCount` for one. */
export function matchCountQueryOptions(filters: PageFilters) {
  return {
    queryKey: ['pages', 'match-count', filters] as const,
    queryFn: () => matchCountQueue(async () => (await apiClient.get<{ total: number }>(pagesPath({ ...filters, limit: 1 }))).total),
    staleTime: 60_000,
  };
}

/** How many items a section's filters match, for the signed-in admin. */
export function useMatchCount(filters: PageFilters, options?: { enabled?: boolean }) {
  return useQuery({ ...matchCountQueryOptions(filters), enabled: options?.enabled ?? true });
}

/**
 * The same count as an anonymous visitor gets it: the request goes WITHOUT the
 * session cookie, so the server applies exactly the gates a visitor meets
 * (private topics dropped, published only) — no new endpoint, and no copy of
 * the visibility rules in the browser. Null when anonymous reading is closed
 * or the request fails; ask only when `useAccess()` says `public`.
 */
export function useAnonymousMatchCount(filters: PageFilters, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ['pages', 'anonymous-match-count', filters],
    queryFn: async (): Promise<number | null> => {
      const res = await fetch(`/api/v1${pagesPath({ ...filters, limit: 1 })}`, { credentials: 'omit' });
      if (!res.ok) return null;
      return ((await res.json()) as { total?: number }).total ?? null;
    },
    enabled: options?.enabled ?? true,
    staleTime: 60_000,
  });
}

// Sections (curated type × space views)

export interface Section {
  slug: string;
  name: string;
  description?: string;
  type?: string;
  space?: string;
  /** Any-of tag filter; empty or absent means the section does not filter by tag. */
  tags?: string[];
  /** Landing-page slot (portal topics and the front page). */
  slot?: SectionSlot;
  /** Display order within its placement, ascending; unordered sort last. */
  order?: number;
  /** Max items shown (1–50); the site shows 10 when absent. */
  limit?: number;
}

export function useSections() {
  return useQuery({
    queryKey: ['sections'],
    queryFn: async () => {
      const res = await apiClient.get<{ sections: Section[] }>('/sections');
      return res.sections;
    },
    staleTime: 60_000,
  });
}

export function useSaveSections() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (sections: Section[]) => {
      const res = await apiClient.put<{ sections: Section[] }>('/sections', { sections });
      return res.sections;
    },
    onSuccess: (sections) => {
      queryClient.setQueryData(['sections'], sections);
    },
  });
}

/** The list as stored right now, bypassing the cache — every one-entry write starts here. */
async function fetchSectionsNow(): Promise<Section[]> {
  return (await apiClient.get<{ sections: Section[] }>('/sections')).sections;
}

/**
 * Why a section save was not written. `changed`/`deleted`: someone else saved
 * this section after the editor loaded it (the caller offers Reload or
 * Overwrite). `duplicate`: the slug was taken meanwhile — never overwritable,
 * because "overwriting" would replace a different section.
 */
export class SectionSaveConflict extends Error {
  constructor(
    readonly kind: 'changed' | 'deleted' | 'duplicate',
    readonly current: Section | undefined,
  ) {
    super(kind === 'duplicate' ? 'Another section already uses that URL.' : 'This section changed since you opened it.');
  }
}

/**
 * Save ONE section over the whole-list `PUT /sections` (review §4.1 save
 * model): re-fetch the list, check the entry is still what the editor loaded,
 * replace or insert it, write the list. This config has no version token, so
 * "still what was loaded" compares the stored entry with `loaded`; `force`
 * skips that check (Overwrite) but never the duplicate-slug one.
 */
export function useSaveSection() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { originalSlug: string | null; loaded: Section | null; next: Section; force?: boolean }) => {
      const current = await fetchSectionsNow();
      const stored = input.originalSlug ? current.find((s) => s.slug === input.originalSlug) : undefined;
      if (!input.force && input.originalSlug) {
        if (!stored) throw new SectionSaveConflict('deleted', undefined);
        if (!sameSection(stored, input.loaded ?? undefined)) throw new SectionSaveConflict('changed', stored);
      }
      if (input.next.slug !== input.originalSlug && current.some((s) => s.slug === input.next.slug)) {
        throw new SectionSaveConflict('duplicate', current.find((s) => s.slug === input.next.slug));
      }
      const list = upsertSection(current, stored ? input.originalSlug : null, input.next);
      const res = await apiClient.put<{ sections: Section[] }>('/sections', { sections: list });
      return { sections: res.sections, saved: res.sections.find((s) => s.slug === input.next.slug) ?? input.next };
    },
    onSuccess: ({ sections }) => {
      queryClient.setQueryData(['sections'], sections);
    },
  });
}

/**
 * Apply a change to the list AS STORED NOW and write it: delete, undo, reorder.
 * Re-fetching first means an immediate-save action never writes a list this tab
 * loaded minutes ago over another admin's edit. Returns the stored list before
 * and after, which is what Undo needs.
 */
export function useUpdateSections() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (change: (current: Section[]) => Section[]) => {
      const before = await fetchSectionsNow();
      const res = await apiClient.put<{ sections: Section[] }>('/sections', { sections: change(before) });
      return { before, after: res.sections };
    },
    onSuccess: ({ after }) => {
      queryClient.setQueryData(['sections'], after);
    },
  });
}

/**
 * One featured topic on the home page, as an administrator curates it
 * (home-prototype plan §4). `color` is a palette token name, never a hex.
 */
export interface PinnedTopicInput {
  topic: string;
  color?: string;
  icon?: string;
  cover?: string;
  cover_dark?: string;
}

/**
 * Replace the pin list. Admin-only on the server, which is the constraint this
 * feature is really about: featuring a topic on the front page is a statement
 * the company makes, not a personal bookmark. A whole-list PUT because the
 * ORDER is the curation — the same reason `PUT /sections` replaces the catalog.
 */
export function useSavePinnedTopics() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (pinned: PinnedTopicInput[]) => {
      const res = await apiClient.put<{ pinned: unknown[] }>('/site/pinned', { pinned });
      return res.pinned;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['site-pinned'] });
    },
  });
}

/** A pin as `GET /site/pinned` answers (the fields the editor round-trips). */
export interface PinnedTopicViewFields {
  topic: string;
  name?: string | null;
  color?: string | null;
  icon?: string | null;
  cover?: string | null;
  cover_dark?: string | null;
}

/**
 * A resolved pin turned back into what `PUT /site/pinned` takes. The server
 * fills `cover_dark` from `cover` on the way out (the dark cover falls back to
 * the light one), so a dark cover equal to the cover means "none set" — writing
 * it back would store a dark cover the curator never chose.
 */
export function pinInputFromView(pin: PinnedTopicViewFields): PinnedTopicInput {
  return {
    topic: pin.topic,
    ...(pin.color ? { color: pin.color } : {}),
    ...(pin.icon ? { icon: pin.icon } : {}),
    ...(pin.cover ? { cover: pin.cover } : {}),
    ...(pin.cover && pin.cover_dark && pin.cover_dark !== pin.cover ? { cover_dark: pin.cover_dark } : {}),
  };
}

/**
 * Apply a change to the pin list as stored now and write it (pin, edit,
 * reorder, unpin — each saves immediately). Same reasoning as
 * `useUpdateSections`: re-fetch first, so an immediate save never writes an
 * old list over another admin's. Returns the list before and after, for Undo.
 */
export function useUpdatePinnedTopics() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (change: (current: PinnedTopicInput[]) => PinnedTopicInput[]) => {
      const fresh = await apiClient.get<{ pinned: PinnedTopicViewFields[] }>('/site/pinned');
      const before = fresh.pinned.map(pinInputFromView);
      const res = await apiClient.put<{ pinned: PinnedTopicViewFields[] }>('/site/pinned', { pinned: change(before) });
      return { before, after: res.pinned.map(pinInputFromView), view: res.pinned };
    },
    onSuccess: ({ view }) => {
      queryClient.setQueryData(['site-pinned'], view);
    },
  });
}

// Content types (first-class OKF concept kinds with templates + domain frontmatter)

export interface ContentTypeField {
  key: string;
  label: string;
  type: 'text' | 'tags' | 'textarea';
  description?: string;
}

export interface ContentType {
  key: string;
  label: string;
  description: string;
  icon: string;
  group: string;
  fields: ContentTypeField[];
  defaultFrontmatter: Record<string, unknown>;
  template: string;
}

export function useContentTypes() {
  return useQuery({
    queryKey: ['content-types'],
    queryFn: async () => {
      const res = await apiClient.get<{ content_types: ContentType[] }>('/content-types');
      return res.content_types;
    },
    staleTime: 5 * 60_000,
  });
}

export function usePage(id: string) {
  return useQuery({
    queryKey: ['pages', id],
    queryFn: async () => {
      const res = await apiClient.get<{ page: Page; version_token: number }>(`/pages/${id}`);
      return res.page;
    },
    enabled: !!id,
  });
}

export function usePageByTitle(title: string) {
  return useQuery({
    queryKey: ['pages-by-title', title],
    queryFn: async () => {
      const res = await apiClient.get<{ page: Page }>(`/pages/by-title/${encodeURIComponent(title)}`);
      return res.page;
    },
    enabled: !!title,
  });
}

/** Set of existing page slugs, for render-time wiki-link resolution (red-links). */
export function useLinkIndex() {
  return useQuery({
    queryKey: ['link-index'],
    queryFn: async () => {
      const res = await apiClient.get<{ slugs: string[] }>('/pages/link-index');
      return new Set(res.slugs);
    },
    staleTime: 30_000,
  });
}

export function usePageBySlug(slug: string) {
  return useQuery({
    queryKey: ['pages-by-slug', slug],
    queryFn: async () => {
      const res = await apiClient.get<{ page: Page }>(`/pages/by-slug/${encodeURIComponent(slug)}`);
      return res.page;
    },
    enabled: !!slug,
  });
}

export function useCreatePage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      title: string;
      body?: string;
      status?: 'draft' | 'published';
      tags?: string[];
      frontmatter?: Record<string, unknown>;
    }) => {
      const res = await apiClient.post<{ page: Page; version_token: number }>('/pages', {
        title: input.title,
        body: input.body ?? '',
        status: input.status ?? 'draft',
        tags: input.tags ?? [],
        frontmatter: input.frontmatter ?? {},
      });
      return res.page;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['pages'] });
    },
  });
}

// Taxonomy

/**
 * @param opts.keepPrevious keep the last result on screen while a new query
 * loads — Admin → Tags & groups searches as you type, and a table that blanks
 * to a skeleton on every pause reads as flicker. Pickers leave it off.
 */
export function useTags(query?: string, opts: { keepPrevious?: boolean } = {}) {
  return useQuery({
    queryKey: ['taxonomy', 'tags', query ?? ''],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (query?.trim()) params.set('q', query.trim());
      const res = await apiClient.get<{ tags: TaxonomyTag[]; total: number }>(`/taxonomy/tags${params.size ? '?' + params.toString() : ''}`);
      return res.tags;
    },
    ...(opts.keepPrevious ? { placeholderData: keepPreviousData } : {}),
  });
}

export function usePrimaryCategories(query?: string) {
  return useQuery({
    queryKey: ['taxonomy', 'categories', query ?? ''],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (query?.trim()) params.set('q', query.trim());
      const res = await apiClient.get<{ categories: TaxonomyCategory[]; total: number }>(`/taxonomy/categories${params.size ? '?' + params.toString() : ''}`);
      return res.categories;
    },
  });
}

export function useCreatePrimaryCategory() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { name: string; slug?: string }) => {
      const res = await apiClient.post<{ category: TaxonomyCategory }>('/taxonomy/categories', input);
      return res.category;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['taxonomy', 'categories'] });
    },
  });
}

export function useUpdatePrimaryCategory() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { slug: string; name: string }) => {
      const res = await apiClient.put<{ category: TaxonomyCategory }>(`/taxonomy/categories/${encodeURIComponent(input.slug)}`, {
        name: input.name,
      });
      return res.category;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['taxonomy', 'categories'] });
    },
  });
}

export function useArchivePrimaryCategory() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (slug: string) => {
      const res = await apiClient.delete<{ category: TaxonomyCategory }>(`/taxonomy/categories/${encodeURIComponent(slug)}`);
      return res.category;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['taxonomy', 'categories'] });
    },
  });
}

/** Archived catalog entries (admin-only), for Admin → Primary categories' Archived view. */
export function useArchivedPrimaryCategories(enabled = true) {
  return useQuery({
    queryKey: ['taxonomy', 'categories', 'archived'],
    queryFn: async () => {
      const res = await apiClient.get<{ categories: TaxonomyCategory[]; total: number }>('/taxonomy/categories/archived');
      return res.categories;
    },
    enabled,
  });
}

/** Un-archive a category — the Restore action and the archive toast's Undo. */
export function useRestorePrimaryCategory() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (slug: string) => {
      const res = await apiClient.post<{ category: TaxonomyCategory }>(`/taxonomy/categories/${encodeURIComponent(slug)}/restore`, {});
      return res.category;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['taxonomy', 'categories'] });
    },
  });
}

export function useGroups(query?: string) {
  return useQuery({
    queryKey: ['taxonomy', 'groups', query ?? ''],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (query?.trim()) params.set('q', query.trim());
      const res = await apiClient.get<{ groups: TaxonomyGroup[]; total: number }>(`/taxonomy/groups${params.size ? '?' + params.toString() : ''}`);
      return res.groups;
    },
  });
}

export function useCreateGroup() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { name: string; slug?: string; description?: string; scope?: 'global' | 'space'; space_id?: string; space_slug?: string }) => {
      const res = await apiClient.post<{ group: TaxonomyGroup }>('/taxonomy/groups', input);
      return res.group;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['taxonomy', 'groups'] });
    },
  });
}

/** Edit a group's name, description and "Available in"; the slug is fixed at creation. */
export function useUpdateGroup() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string; name: string; description: string | null; scope: 'global' | 'space'; space_id?: string }) => {
      const { id, ...body } = input;
      const res = await apiClient.put<{ group: TaxonomyGroup }>(`/taxonomy/groups/${encodeURIComponent(id)}`, body);
      return res.group;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['taxonomy', 'groups'] });
    },
  });
}

/** Soft-archive a group; the server refuses (409) while items are in it. */
export function useArchiveGroup() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const res = await apiClient.delete<{ group: TaxonomyGroup }>(`/taxonomy/groups/${encodeURIComponent(id)}`);
      return res.group;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['taxonomy', 'groups'] });
    },
  });
}

export function useTopics() {
  return useQuery({
    queryKey: ['topics'],
    queryFn: async () => {
      const res = await apiClient.get<{ topics: Topic[]; total: number }>('/topics');
      return res.topics;
    },
  });
}

export function useCreateTopic() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      name: string;
      slug?: string;
      description?: string;
      /** Settable at creation so a repo-bound topic can start private (review §2 #7). */
      visibility?: 'public' | 'private';
      repo?: { remote_url: string; branch?: string; pull?: boolean };
    }) => {
      const res = await apiClient.post<{ topic: Topic }>('/topics', input);
      return res.topic;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['topics'] });
    },
  });
}

export function useUpdateTopic() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string; name: string; description?: string }) => {
      const res = await apiClient.put<{ topic: Topic }>(`/topics/${encodeURIComponent(input.id)}`, {
        name: input.name,
        description: input.description,
      });
      return res.topic;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['topics'] });
    },
  });
}

export function useArchiveTopic() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const res = await apiClient.delete<{ topic: Topic }>(`/topics/${encodeURIComponent(id)}`);
      return res.topic;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['topics'] });
    },
  });
}

// Backend repo mappings (Admin → Repos)

export interface SpaceRepo {
  space_id: string;
  space_slug: string | null;
  space_name: string | null;
  remote_url: string;
  branch: string | null;
  enabled: boolean;
  updated_at: string;
}

export interface MainRemote {
  remote_url: string;
  branch: string | null;
  enabled: boolean;
}

export function useRepos() {
  return useQuery({
    queryKey: ['admin', 'repos'],
    queryFn: async () => {
      return apiClient.get<{ repos: SpaceRepo[]; main: MainRemote | null }>('/admin/repos');
    },
  });
}

export function useSetMainRemote() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { remote_url: string; branch?: string; enabled?: boolean }) => {
      return apiClient.put<{ main: MainRemote }>('/admin/repos/main', input);
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin', 'repos'] }),
  });
}

export function useSyncRepo() {
  return useMutation({
    mutationFn: async (spaceId: string) => {
      return apiClient.post<{ items: number }>(`/admin/repos/${encodeURIComponent(spaceId)}/sync`);
    },
  });
}

export function usePullRepo() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (spaceId: string) => {
      return apiClient.post<{ created: number; updated: number; ids: string[] }>(
        `/admin/repos/${encodeURIComponent(spaceId)}/pull`,
      );
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['pages'] }),
  });
}

export function useUpsertRepo() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { space_id: string; remote_url: string; branch?: string; enabled?: boolean }) => {
      const { space_id, ...body } = input;
      await apiClient.put(`/admin/repos/${encodeURIComponent(space_id)}`, body);
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin', 'repos'] }),
  });
}

export function useRemoveRepo() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (spaceId: string) => {
      await apiClient.delete(`/admin/repos/${encodeURIComponent(spaceId)}`);
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin', 'repos'] }),
  });
}

export function useTestRepoConnection() {
  return useMutation({
    mutationFn: async (remote_url: string) => {
      return apiClient.post<{ ok: boolean; message: string }>('/admin/repos/test', { remote_url });
    },
  });
}

// Images

export interface ImageAsset {
  id: string;
  file: string;
  url: string;
  mime: string;
  byte_size: number;
  alt: string | null;
  /** Human-facing download name; null for legacy image rows. */
  original_filename: string | null;
  created_at: string;
  /** Items that reference it (trashed ones included). */
  used_by: number;
  /** The site's chrome uses it (logo, favicon, a pinned-topic cover), so it is not deletable. */
  site_asset: boolean;
  /** Used by nothing: no item and not the site. */
  orphan: boolean;
}

/** The whole library, largest first. Admin → Files pages its own list (`features/files/queries.ts`). */
export function useImages() {
  return useQuery({
    queryKey: ['admin', 'images'],
    queryFn: async () => {
      const res = await apiClient.get<{ images: ImageAsset[] }>('/admin/images');
      return res.images;
    },
  });
}

export function useUploadImage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (file: File) => {
      // Pass the real filename so it becomes the download name (Content-Disposition);
      // the stored name stays the opaque content-addressed one (ADR-0003).
      const query = file.name ? `?filename=${encodeURIComponent(file.name)}` : '';
      const res = await fetch(`/api/v1/images${query}`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': file.type || 'application/octet-stream' },
        body: file,
      });
      if (!res.ok) {
        // Surface the server's reason (allowlist / signature / size) to the user.
        let detail = '';
        try {
          detail = ((await res.json()) as { message?: string }).message ?? '';
        } catch {
          /* non-JSON error body */
        }
        throw new Error(detail || `Upload failed (${res.status}).`);
      }
      return (await res.json()) as ImageAsset;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin', 'images'] }),
  });
}

export function useDeleteImage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      await apiClient.delete(`/admin/images/${encodeURIComponent(id)}`);
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin', 'images'] }),
  });
}

// Search

export function useSearch(
  query?: string,
  filters?: { tag?: string; since?: string; sort?: string; limit?: number; includeDrafts?: boolean },
) {
  return useQuery({
    queryKey: ['search', query, filters],
    queryFn: async () => {
      if (!query || query.trim().length === 0) {
        return [];
      }

      const params = new URLSearchParams();
      params.set('q', query);
      if (filters?.tag) params.set('tag', filters.tag);
      if (filters?.since) params.set('since', filters.since);
      if (filters?.sort) params.set('sort', filters.sort);
      // Include drafts (admins see all; the server still scopes non-admins to
      // their own). Lets browse's server-backed query match the dump's visibility.
      if (filters?.includeDrafts) params.set('include_drafts', '1');
      // Ask for an explicit page size rather than inheriting the server default
      // (25). Callers that report a total need to know what they asked for.
      if (filters?.limit) params.set('limit', String(filters.limit));

      const res = await apiClient.get<{ results: SearchResult[] }>(`/search?${params.toString()}`);
      return res.results;
    },
    enabled: !!query && query.trim().length > 0,
  });
}

// Backlinks

export interface Backlink {
  source_item_id: string;
  source_item_slug: string;
  source_item_title: string;
  source_page_id: string;
  source_slug: string;
  source_title: string;
  snippet: string;
}

export function useBacklinks(pageId: string) {
  return useQuery({
    queryKey: ['backlinks', pageId],
    queryFn: async () => {
      const res = await apiClient.get<{ backlinks: Backlink[] }>(`/pages/${pageId}/backlinks`);
      return res.backlinks;
    },
    enabled: !!pageId,
  });
}
