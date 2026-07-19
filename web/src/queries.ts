/**
 * TanStack Query hooks for knowledge-e3 API.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from './api.js';

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
}

export interface TaxonomyTag extends TaxonomyCategory {
  id: string;
  scope: TaxonomyScope;
}

export interface TaxonomyGroup extends TaxonomyCategory {
  id: string;
  scope: TaxonomyScope;
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
    },
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

export function usePages(filters?: {
  status?: string;
  tag?: string;
  since?: string;
  limit?: number;
  type?: string;
  space?: string;
  sort?: 'updated' | 'published' | 'created' | 'title';
}) {
  return useQuery({
    queryKey: ['pages', filters],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (filters?.status) params.set('status', filters.status);
      if (filters?.tag) params.set('tag', filters.tag);
      if (filters?.since) params.set('since', filters.since);
      if (filters?.limit) params.set('limit', String(filters.limit));
      if (filters?.type) params.set('type', filters.type);
      if (filters?.space) params.set('space', filters.space);
      if (filters?.sort) params.set('sort', filters.sort);

      const path = `/pages${params.size ? '?' + params.toString() : ''}`;
      const res = await apiClient.get<{ items: Page[]; total: number }>(path);
      return res.items;
    },
  });
}

// Sections (curated type × space views)

export interface Section {
  slug: string;
  name: string;
  description?: string;
  type?: string;
  space?: string;
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

export function useTags(query?: string) {
  return useQuery({
    queryKey: ['taxonomy', 'tags', query ?? ''],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (query?.trim()) params.set('q', query.trim());
      const res = await apiClient.get<{ tags: TaxonomyTag[]; total: number }>(`/taxonomy/tags${params.size ? '?' + params.toString() : ''}`);
      return res.tags;
    },
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
  used_by: number;
  orphan: boolean;
}

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
