/**
 * POST a raw `.tar.gz` bundle to an OKF archive route (`/okf/import/archive`,
 * `/okf/validate/archive`).
 *
 * `ApiClient.request` always JSON-encodes its body, so the archive doors cannot
 * go through it. What they must not lose by going around it is the error body:
 * the archive import used to throw `Import failed (422).` and nothing else, which
 * is the one-liner a refused bundle's per-file report exists to replace. So a
 * failure here throws the same `ApiError` shape the client does — message,
 * reason, validation, request id — and the page handles both doors with one
 * catch.
 */
import type { ApiError } from '../../api.js';

export async function postArchive<T>(path: string, archive: Blob, fetchImpl: typeof fetch = fetch): Promise<T> {
  let res: Response;
  try {
    res = await fetchImpl(`/api/v1${path}`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/gzip' },
      body: await archive.arrayBuffer(),
    });
  } catch {
    throw { statusCode: 0, message: 'Network error — could not reach the server.', network_error: true } as ApiError;
  }
  if (res.ok) return (await res.json()) as T;
  throw await archiveError(res);
}

/** The `ApiError` for a failed archive response, reading whatever JSON body it has. */
export async function archiveError(res: Response): Promise<ApiError> {
  const requestId = res.headers.get('x-request-id') ?? undefined;
  const error: ApiError = { statusCode: res.status, status: res.status, message: res.statusText || `HTTP ${res.status}` };
  try {
    const body = (await res.json()) as Record<string, unknown>;
    if (typeof body['message'] === 'string' && body['message']) error.message = body['message'];
    if (typeof body['reason'] === 'string') error.reason = body['reason'];
    if (body['validation'] && typeof body['validation'] === 'object') error.validation = body['validation'];
  } catch {
    // Not JSON (a proxy's HTML error page): the status line is all there is.
  }
  if (requestId) error.request_id = requestId;
  return error;
}
