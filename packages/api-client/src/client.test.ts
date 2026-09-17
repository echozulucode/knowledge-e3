import { describe, expect, it, vi } from 'vitest';
import { ApiError, createClient } from './client.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** A fetch stub that records its calls and answers with the given response. */
function stubFetch(res: Response | (() => Response)) {
  return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
    typeof res === 'function' ? res() : res,
  ) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}

function lastCall(fetchStub: ReturnType<typeof stubFetch>): { url: string; init: RequestInit } {
  const call = fetchStub.mock.calls.at(-1) as [string, RequestInit];
  return { url: call[0], init: call[1] };
}

describe('createClient — request shaping', () => {
  it('joins the default baseUrl onto paths', async () => {
    const fetch = stubFetch(jsonResponse({ user: { id: 'u1' } }));
    await createClient({ fetch }).me();
    expect(lastCall(fetch).url).toBe('/api/v1/me');
  });

  it('joins a custom baseUrl without doubling slashes', async () => {
    const fetch = stubFetch(jsonResponse({ topics: [] }));
    await createClient({ fetch, baseUrl: 'http://localhost:3000/api/v1/' }).topics();
    expect(lastCall(fetch).url).toBe('http://localhost:3000/api/v1/topics');
  });

  it('sends credentials: include by default and honors an override', async () => {
    const fetch = stubFetch(() => jsonResponse({ sections: [] }));
    await createClient({ fetch }).sections();
    expect(lastCall(fetch).init.credentials).toBe('include');
    await createClient({ fetch, credentials: 'same-origin' }).sections();
    expect(lastCall(fetch).init.credentials).toBe('same-origin');
  });

  it('adds a bearer Authorization header only when a token is given', async () => {
    const fetch = stubFetch(() => jsonResponse({ user: { id: 'u1' } }));
    await createClient({ fetch }).me();
    expect((lastCall(fetch).init.headers as Record<string, string>)['Authorization']).toBeUndefined();
    await createClient({ fetch, token: 'pat-123' }).me();
    expect((lastCall(fetch).init.headers as Record<string, string>)['Authorization']).toBe('Bearer pat-123');
  });

  it('sends If-Match and a JSON body on items.update', async () => {
    const item = { id: 'i1', version_token: 4 };
    const fetch = stubFetch(jsonResponse({ item, version_token: 4 }));
    const out = await createClient({ fetch }).items.update('i1', { title: 'New' }, 3);
    const { url, init } = lastCall(fetch);
    expect(url).toBe('/api/v1/items/i1');
    expect(init.method).toBe('PUT');
    const headers = init.headers as Record<string, string>;
    expect(headers['If-Match']).toBe('3');
    expect(headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body as string)).toEqual({ title: 'New' });
    expect(out).toEqual(item);
  });

  it('encodes query params and drops undefined ones', async () => {
    const fetch = stubFetch(jsonResponse({ items: [] }));
    await createClient({ fetch }).items.list({ q: 'a b', status: 'published', limit: 10, tag: undefined });
    expect(lastCall(fetch).url).toBe('/api/v1/items?q=a+b&status=published&limit=10');
  });
});

describe('createClient — responses', () => {
  it('throws ApiError on non-2xx with the JSON body preserved', async () => {
    const body = { statusCode: 409, message: 'version mismatch', error: 'Conflict', version_token: 5 };
    const fetch = stubFetch(jsonResponse(body, 409));
    const err = await createClient({ fetch })
      .items.update('i1', { title: 'x' }, 4)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    const apiErr = err as ApiError;
    expect(apiErr.status).toBe(409);
    expect(apiErr.message).toBe('version mismatch');
    expect(apiErr.body).toEqual(body);
  });

  it('keeps a non-JSON error body as text', async () => {
    const fetch = stubFetch(new Response('gateway down', { status: 502, statusText: 'Bad Gateway' }));
    const err = (await createClient({ fetch }).topics().catch((e: unknown) => e)) as ApiError;
    expect(err.status).toBe(502);
    expect(err.body).toBe('gateway down');
    expect(err.message).toBe('Bad Gateway');
  });

  it('decodes items.get and unwraps the envelope', async () => {
    const item = { id: 'i1', slug: 'hello', title: 'Hello', status: 'published', version_token: 2, tags: ['a'] };
    const fetch = stubFetch(jsonResponse({ item, version_token: 2 }));
    const out = await createClient({ fetch }).items.get('i1');
    expect(lastCall(fetch).url).toBe('/api/v1/items/i1');
    expect(out).toEqual(item);
  });

  it('resolves null for a missing item', async () => {
    const fetch = stubFetch(jsonResponse({ item: null }));
    expect(await createClient({ fetch }).items.get('nope')).toBeNull();
  });

  it('decodes a search result set', async () => {
    const set = {
      results: [{ id: 'i1', slug: 'hello', title: 'Hello', status: 'published', updated_at: 't', score: 1.5 }],
      total: 1,
      facets: { topics: [], statuses: [], tags: [], trust_tiers: [] },
      warnings: [],
    };
    const fetch = stubFetch(jsonResponse(set));
    const out = await createClient({ fetch }).search({ q: 'hello', include_drafts: true, sort: 'newest' });
    expect(lastCall(fetch).url).toBe('/api/v1/search?q=hello&include_drafts=true&sort=newest');
    expect(out).toEqual(set);
    expect(out.results[0]?.score).toBe(1.5);
  });
});
