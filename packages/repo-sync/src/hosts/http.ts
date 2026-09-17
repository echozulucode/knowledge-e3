/**
 * Shared HTTP plumbing for the `ChangeRequestHost` adapters: bearer-token JSON
 * requests over the global `fetch`, with an injectable `fetchImpl` for tests.
 */
export type FetchImpl = (input: string, init?: RequestInit) => Promise<Response>;

export class HostError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    readonly method: string,
    readonly url: string,
  ) {
    super(`${method} ${url} → ${status}: ${body.slice(0, 500)}`);
    this.name = 'HostError';
  }
}

export interface JsonRequest {
  method: 'GET' | 'POST' | 'PUT';
  url: string;
  token: string;
  body?: unknown;
  headers?: Record<string, string>;
}

/** Perform a JSON request; throws `HostError` on non-2xx. Returns `null` for an empty body. */
export async function requestJson<T = unknown>(fetchImpl: FetchImpl, req: JsonRequest): Promise<T | null> {
  const res = await fetchImpl(req.url, {
    method: req.method,
    headers: {
      Authorization: `Bearer ${req.token}`,
      Accept: 'application/json',
      ...(req.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...req.headers,
    },
    body: req.body !== undefined ? JSON.stringify(req.body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new HostError(res.status, text, req.method, req.url);
  return text ? (JSON.parse(text) as T) : null;
}

/** The change-request id encodes the repository so `status`/`merge`/`comment` need only the `ChangeRef`. */
export function encodeChangeId(repoKey: string, number: number | string): string {
  return `${repoKey}#${number}`;
}

export function decodeChangeId(id: string): { repoKey: string; number: string } {
  const hash = id.lastIndexOf('#');
  if (hash <= 0 || hash === id.length - 1) throw new Error(`malformed change id: ${id}`);
  return { repoKey: id.slice(0, hash), number: id.slice(hash + 1) };
}
