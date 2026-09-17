/**
 * `server` source: a Knowledge E3 server over its REST API, read-only.
 *
 * Only GET requests are made (search, item, topics, taxonomy). The server
 * enforces everything that matters — the token's scope, topic visibility,
 * draft visibility — so this source adds nothing but an optional `topics`
 * narrowing on top.
 *
 * The token is read from the environment variable named by `token_env`, once,
 * at construction. It is sent only as `Authorization: Bearer …` to the
 * configured URL, registered with the log redactor, and never included in a
 * tool result, an error message or a log line — not even its length.
 */
import { ApiError, createClient, type ApiClient, type Topic } from '@echozedlabs/api-client';
import type { ItemView } from '@echozedlabs/knowledge-types';
import { KnowledgeToolError, toMcpItem, type ItemRefInput, type SearchToolInput } from '@echozedlabs/mcp-tools';
import type { ServerSourceConfig } from '../config.js';
import { redactor as defaultRedactor, type Logger, type Redactor } from '../log.js';
import type { KnowledgeSource, SourceInfo, SourceItem, SourceVocabulary } from './types.js';

export interface RemoteSourceOptions {
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  redactor?: Redactor;
}

export class RemoteSource implements KnowledgeSource {
  readonly type = 'server' as const;
  private readonly client: ApiClient;
  /** GET with repeatable query parameters (the typed client collapses repeats), same auth and bounds. */
  private readonly getJson: (path: string, params: URLSearchParams) => Promise<Record<string, unknown>>;
  private readonly tokenPresent: boolean;
  private readonly redactor: Redactor;
  private topicCache: { at: number; topics: Topic[] } | null = null;

  constructor(
    private readonly config: ServerSourceConfig,
    private readonly logger: Logger,
    opts: RemoteSourceOptions = {},
  ) {
    const env = opts.env ?? process.env;
    const token = config.token_env ? env[config.token_env]?.trim() || undefined : undefined;
    this.tokenPresent = Boolean(token);
    this.redactor = opts.redactor ?? defaultRedactor;
    this.redactor.add(token);
    const baseFetch = opts.fetch ?? globalThis.fetch;
    const timeoutMs = config.timeout_ms;
    // Bounded, GET only, and no redirects: a redirect must not carry the Authorization header anywhere else.
    const boundedFetch = ((input: string | URL | Request, init?: RequestInit) => {
      if (init?.method && init.method !== 'GET') throw new KnowledgeToolError(405, `Source "${config.id}" is read-only`);
      return baseFetch(input, { ...init, signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
    }) as typeof fetch;
    this.client = createClient({ baseUrl: config.url, credentials: 'omit', fetch: boundedFetch, ...(token ? { token } : {}) });
    this.getJson = async (path, params) => {
      const qs = params.toString();
      const res = await boundedFetch(`${config.url.replace(/\/+$/, '')}${path}${qs ? `?${qs}` : ''}`, {
        method: 'GET',
        headers: { Accept: 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      });
      const text = await res.text();
      let body: unknown = text;
      try {
        body = JSON.parse(text);
      } catch {
        // not JSON
      }
      if (!res.ok) {
        const m = body && typeof body === 'object' ? (body as { message?: unknown }).message : undefined;
        throw new ApiError(res.status, typeof m === 'string' ? m : res.statusText || `HTTP ${res.status}`, body);
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ApiError(502, 'unexpected response body', null);
      return body as Record<string, unknown>;
    };
  }

  get id(): string {
    return this.config.id;
  }

  async load(): Promise<void> {
    if (this.config.token_env && !this.tokenPresent) {
      this.logger.warn(`[${this.id}] environment variable ${this.config.token_env} is not set; requests go unauthenticated`);
    }
  }

  async search(input: SearchToolInput): Promise<Record<string, unknown>> {
    const scoped = await this.scopedSpace(input.space);
    if (scoped.empty) {
      return {
        results: [],
        total: 0,
        offset: 0,
        limit: input.limit ?? 25,
        facets: {},
        warnings: [`Topic ${input.space} is outside the topics configured for source ${this.id}`],
      };
    }
    const params = new URLSearchParams();
    const set = (key: string, value: string | number | boolean | undefined) => {
      if (value !== undefined && value !== '') params.append(key, String(value));
    };
    set('q', input.q);
    for (const space of scoped.spaces) set('space', space);
    set('tag', input.tag);
    set('category', input.category);
    set('group', input.group);
    set('type', input.type);
    set('status', input.status);
    set('sort', input.sort);
    if (input.include_drafts) set('include_drafts', 'true');
    set('limit', input.limit);
    const body = await this.call(() => this.getJson('/search', params), 'search');
    const results = Array.isArray(body['results']) ? (body['results'] as Record<string, unknown>[]) : [];
    const tagged: Record<string, unknown>[] = results.map((hit) => ({ ...hit, source: this.id, ref: `${this.id}:${String(hit['id'])}` }));
    // `groups` hold the same hit objects as `results`; re-point them at the tagged copies.
    const byId = new Map(tagged.map((hit) => [String(hit['id']), hit]));
    const groups = Array.isArray(body['groups'])
      ? (body['groups'] as Record<string, unknown>[]).map((g) => ({
          ...g,
          hits: Array.isArray(g['hits']) ? (g['hits'] as Record<string, unknown>[]).map((h) => byId.get(String(h['id'])) ?? { ...h, source: this.id }) : [],
        }))
      : undefined;
    const { query: _query, ...rest } = body;
    return { ...rest, results: tagged, ...(groups ? { groups } : {}) };
  }

  async getItem(ref: ItemRefInput): Promise<SourceItem | null> {
    let key = ref.id ?? ref.slug;
    if (!key && ref.title) {
      const found = (await this.search({ q: `"${ref.title}"`, sort: 'relevance', include_drafts: false, limit: 25 }))['results'] as Record<string, unknown>[];
      key = found.find((hit) => hit['title'] === ref.title)?.['id'] as string | undefined;
    }
    if (!key) return null;
    const item = await this.call(() => this.client.items.get(key), 'item');
    if (!item || !(await this.inScope(item))) return null;
    return this.toSourceItem(item);
  }

  async listSpaces(): Promise<object[]> {
    const topics = await this.topics();
    return topics.filter((t) => this.topicAllowed(t)).map((t) => ({ source: this.id, ...t }));
  }

  async listTaxonomy() {
    const [tags, categories, groups] = await Promise.all([
      this.call(() => this.client.taxonomy.tags(), 'taxonomy'),
      this.call(() => this.client.taxonomy.categories(), 'taxonomy'),
      this.call(() => this.client.taxonomy.groups(), 'taxonomy'),
    ]);
    const tag = (list: object[]): Record<string, unknown>[] => list.map((e) => ({ source: this.id, ...e }));
    return { tags: tag(tags), categories: tag(categories), groups: tag(groups) };
  }

  async vocabulary(): Promise<SourceVocabulary> {
    const t = await this.listTaxonomy();
    const slugs = (list: Record<string, unknown>[]) => list.map((e) => String(e['slug'] ?? '')).filter(Boolean);
    return { tags: slugs(t.tags), categories: slugs(t.categories), groups: slugs(t.groups) };
  }

  info(): SourceInfo {
    return {
      id: this.id,
      type: 'server',
      status: 'ready',
      url: this.config.url,
      ...(this.config.topics ? { topics: this.config.topics } : {}),
      ...(this.config.token_env ? { token_env: this.config.token_env } : {}),
      token_present: this.tokenPresent,
    };
  }

  private toSourceItem(item: ItemView): SourceItem {
    const mcp = toMcpItem(item);
    const origin = new URL(this.config.url).origin;
    return { source: this.id, ref: `${this.id}:${item.id}`, ...mcp, url: new URL(mcp.url, origin).href };
  }

  /** `topics` narrowing: the configured topics, or just the caller's when it is one of them. */
  private async scopedSpace(space: string | undefined): Promise<{ spaces: string[]; empty: boolean }> {
    const allowed = this.config.topics;
    if (!allowed?.length) return { spaces: space ? [space] : [], empty: false };
    if (!space) return { spaces: allowed, empty: false };
    const wanted = space.toLowerCase();
    const topics = await this.topics();
    const match = topics.find((t) => [t.id, t.slug, t.name].some((v) => v?.toLowerCase() === wanted));
    const ok = match ? this.topicAllowed(match) : allowed.some((a) => a.toLowerCase() === wanted);
    return ok ? { spaces: [space], empty: false } : { spaces: [], empty: true };
  }

  private topicAllowed(topic: Pick<Topic, 'id' | 'slug' | 'name'>): boolean {
    const allowed = this.config.topics;
    if (!allowed?.length) return true;
    const names = [topic.id, topic.slug, topic.name].map((v) => v?.toLowerCase());
    return allowed.some((a) => names.includes(a.toLowerCase()));
  }

  private async inScope(item: ItemView): Promise<boolean> {
    if (!this.config.topics?.length) return true;
    if (!item.space_id) return false;
    const topic = (await this.topics()).find((t) => t.id === item.space_id);
    return topic ? this.topicAllowed(topic) : false;
  }

  private async topics(): Promise<Topic[]> {
    if (this.topicCache && Date.now() - this.topicCache.at < 60_000) return this.topicCache.topics;
    const topics = await this.call(() => this.client.topics(), 'topics');
    this.topicCache = { at: Date.now(), topics };
    return topics;
  }

  /** Run one request, turning every failure into a public tool error that names the source and never the token. */
  private async call<T>(run: () => Promise<T>, what: string): Promise<T> {
    try {
      return await run();
    } catch (err) {
      throw this.toToolError(err, what);
    }
  }

  private toToolError(err: unknown, what: string): KnowledgeToolError {
    const label = `Source "${this.id}"`;
    const data = { source: this.id, source_type: 'server' };
    if (err instanceof KnowledgeToolError) return err;
    if (err instanceof ApiError) {
      if (err.status === 401) {
        const hint = this.config.token_env
          ? this.tokenPresent
            ? `the token in ${this.config.token_env} was not accepted (expired, revoked or for another server)`
            : `${this.config.token_env} is not set`
          : 'no token is configured; set token_env to the name of an environment variable holding a personal access token';
        return new KnowledgeToolError(401, `${label} refused the ${what} request: not authenticated — ${hint}.`, { ...data, http_status: 401 });
      }
      if (err.status === 403) {
        return new KnowledgeToolError(
          403,
          `${label} refused the ${what} request: forbidden — the token's scope or the topic's visibility does not allow it.`,
          { ...data, http_status: 403 },
        );
      }
      const detail = this.redactor.redact(err.message).slice(0, 300);
      const status = err.status >= 400 && err.status < 500 ? err.status : 502;
      return new KnowledgeToolError(status, `${label} answered HTTP ${err.status} to the ${what} request: ${detail}`, { ...data, http_status: err.status });
    }
    const name = err instanceof Error ? err.name : '';
    if (name === 'TimeoutError' || name === 'AbortError') {
      return new KnowledgeToolError(504, `${label} did not answer the ${what} request within ${this.config.timeout_ms} ms.`, data);
    }
    const cause = err instanceof Error && err.cause && typeof err.cause === 'object' ? (err.cause as { code?: unknown }).code : undefined;
    this.logger.debug(`[${this.id}] ${what} request failed: ${err instanceof Error ? err.message : String(err)}`);
    return new KnowledgeToolError(
      502,
      `${label} is unreachable for the ${what} request${typeof cause === 'string' ? ` (${cause})` : ''}.`,
      data,
    );
  }
}
