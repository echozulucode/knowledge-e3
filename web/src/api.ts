/**
 * Typed fetch client for knowledge-e3 API.
 * Includes credentials, JSON serialization, and error handling.
 */

export interface ApiError {
  statusCode: number;
  status?: number; // alias for statusCode
  message: string;
  /** Populated on 429 from the server's TooManyRequestsException body. */
  retry_after_seconds?: number;
  /** The opaque request id from the server, when available. Used to correlate
   *  client errors with server logs and to pre-fill the bug-report context. */
  request_id?: string;
  /** True when the network failed (no HTTP response — connection refused, DNS, offline). */
  network_error?: boolean;
}

/**
 * Most-recent-request id surface for cross-component diagnostics.
 * The ErrorBoundary reads this when rendering the "Something went wrong" page.
 */
let lastRequestId: string | undefined;
export function getLastRequestId(): string | undefined {
  return lastRequestId;
}

export class ApiClient {
  private baseUrl: string;

  constructor(baseUrl = '/api/v1') {
    this.baseUrl = baseUrl;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const opts: RequestInit = {
      method,
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        ...headers,
      },
    };

    if (body !== undefined) {
      opts.body = JSON.stringify(body);
    }

    let res: Response;
    try {
      res = await fetch(url, opts);
    } catch (e) {
      // Network-level failure: no response, no status. Distinct from a 5xx.
      throw {
        statusCode: 0,
        message: 'Network error — could not reach the server.',
        network_error: true,
      } as ApiError;
    }

    // Capture request id (if the server's request-context middleware attached one).
    const requestId = res.headers.get('x-request-id') ?? undefined;
    if (requestId) lastRequestId = requestId;

    if (!res.ok) {
      let message = res.statusText;
      let retryAfter: number | undefined;
      try {
        const error = await res.json();
        message = error.message || message;
        if (typeof error.retry_after_seconds === 'number') {
          retryAfter = error.retry_after_seconds;
        }
      } catch {
        // ignored
      }
      throw {
        statusCode: res.status,
        status: res.status,
        message,
        ...(retryAfter !== undefined ? { retry_after_seconds: retryAfter } : {}),
        ...(requestId !== undefined ? { request_id: requestId } : {}),
      } as ApiError;
    }

    // 204 No Content returns no body
    if (res.status === 204) {
      return undefined as any;
    }

    return res.json();
  }

  get<T>(path: string): Promise<T> {
    return this.request<T>('GET', path);
  }

  post<T>(path: string, body?: unknown, headers?: Record<string, string>): Promise<T> {
    return this.request<T>('POST', path, body, headers);
  }

  put<T>(
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<T> {
    return this.request<T>('PUT', path, body, headers);
  }

  patch<T>(
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<T> {
    return this.request<T>('PATCH', path, body, headers);
  }

  delete<T>(path: string, headers?: Record<string, string>): Promise<T> {
    return this.request<T>('DELETE', path, undefined, headers);
  }
}

export const apiClient = new ApiClient();
