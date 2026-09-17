import type { ItemView, SectionView } from '@echozedlabs/knowledge-types';
import type {
  ContentType,
  CreateItemInput,
  ListItemsParams,
  SearchParams,
  SearchResultSet,
  TaxonomyEntry,
  Topic,
  UpdateItemInput,
  User,
} from './types.js';

/** Thrown for every non-2xx response. `body` is the decoded JSON, or the raw text when not JSON. */
export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, message: string, body: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

export interface ClientOptions {
  /** API root the paths are joined onto. Default `/api/v1`. */
  baseUrl?: string;
  /** Fetch implementation; defaults to the global. */
  fetch?: typeof fetch;
  /** Sent as `Authorization: Bearer <token>` (personal access tokens). */
  token?: string;
  /** Default `include`, so the session cookie travels cross-origin in dev. */
  credentials?: NonNullable<RequestInit['credentials']>;
}

type QueryValue = string | number | boolean | undefined;

export interface ApiClient {
  me(): Promise<User>;
  items: {
    /** Resolves `null` when the item does not exist or is not visible (the server answers 200 `{ item: null }`). */
    get(id: string): Promise<ItemView | null>;
    list(params?: ListItemsParams): Promise<ItemView[]>;
    create(input: CreateItemInput): Promise<ItemView>;
    /** `ifMatch` is the item's current `version_token`; a mismatch surfaces as a 409 `ApiError`. */
    update(id: string, input: UpdateItemInput, ifMatch: number | string): Promise<ItemView>;
  };
  pages: {
    bySlug(slug: string): Promise<ItemView>;
  };
  search(params?: SearchParams): Promise<SearchResultSet>;
  topics(): Promise<Topic[]>;
  sections(): Promise<SectionView[]>;
  contentTypes(): Promise<ContentType[]>;
  taxonomy: {
    tags(q?: string): Promise<TaxonomyEntry[]>;
    categories(q?: string): Promise<TaxonomyEntry[]>;
    groups(q?: string): Promise<TaxonomyEntry[]>;
  };
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

function withQuery(path: string, params: Record<string, QueryValue> | undefined): string {
  if (!params) return path;
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === '') continue;
    search.set(key, String(value));
  }
  const qs = search.toString();
  return qs ? `${path}?${qs}` : path;
}

async function decodeErrorBody(res: Response): Promise<unknown> {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function errorMessage(body: unknown, fallback: string): string {
  if (body && typeof body === 'object' && 'message' in body) {
    const m = (body as { message?: unknown }).message;
    if (typeof m === 'string') return m;
    if (Array.isArray(m)) return m.join('; ');
  }
  return fallback;
}

export function createClient(opts: ClientOptions = {}): ApiClient {
  const baseUrl = opts.baseUrl ?? '/api/v1';
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const credentials = opts.credentials ?? 'include';
  const token = opts.token;

  async function request<T>(
    method: string,
    path: string,
    init: { body?: unknown; headers?: Record<string, string> } = {},
  ): Promise<T> {
    const headers: Record<string, string> = { Accept: 'application/json', ...init.headers };
    if (init.body !== undefined) headers['Content-Type'] = 'application/json';
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const res = await fetchImpl(joinUrl(baseUrl, path), {
      method,
      credentials,
      headers,
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });

    if (!res.ok) {
      const body = await decodeErrorBody(res);
      throw new ApiError(res.status, errorMessage(body, res.statusText || `HTTP ${res.status}`), body);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  const get = <T>(path: string, params?: Record<string, QueryValue>) => request<T>('GET', withQuery(path, params));

  return {
    me: async () => (await get<{ user: User }>('/me')).user,
    items: {
      get: async (id) => (await get<{ item: ItemView | null }>(`/items/${encodeURIComponent(id)}`)).item,
      list: async (params) => (await get<{ items: ItemView[] }>('/items', { ...params })).items,
      create: async (input) => (await request<{ item: ItemView }>('POST', '/items', { body: input })).item,
      update: async (id, input, ifMatch) =>
        (
          await request<{ item: ItemView }>('PUT', `/items/${encodeURIComponent(id)}`, {
            body: input,
            headers: { 'If-Match': String(ifMatch) },
          })
        ).item,
    },
    pages: {
      bySlug: async (slug) => (await get<{ page: ItemView }>(`/pages/by-slug/${encodeURIComponent(slug)}`)).page,
    },
    search: (params) => get<SearchResultSet>('/search', { ...params }),
    topics: async () => (await get<{ topics: Topic[] }>('/topics')).topics,
    sections: async () => (await get<{ sections: SectionView[] }>('/sections')).sections,
    contentTypes: async () => (await get<{ content_types: ContentType[] }>('/content-types')).content_types,
    taxonomy: {
      tags: async (q) => (await get<{ tags: TaxonomyEntry[] }>('/taxonomy/tags', { q })).tags,
      categories: async (q) => (await get<{ categories: TaxonomyEntry[] }>('/taxonomy/categories', { q })).categories,
      groups: async (q) => (await get<{ groups: TaxonomyEntry[] }>('/taxonomy/groups', { q })).groups,
    },
  };
}
