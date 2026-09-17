import { describe, expect, it } from 'vitest';
import { postArchive } from './archiveRequest.js';

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

const archive = new Blob([new Uint8Array([0x1f, 0x8b])]);

describe('postArchive', () => {
  it('returns the parsed body on success and sends the raw bytes as gzip', async () => {
    let seen: RequestInit | undefined;
    const result = await postArchive<{ created: number }>('/okf/import/archive', archive, async (_url, init) => {
      seen = init;
      return jsonResponse(201, { created: 2 });
    });
    expect(result).toEqual({ created: 2 });
    expect((seen?.headers as Record<string, string>)['Content-Type']).toBe('application/gzip');
    expect(seen?.body).toBeInstanceOf(ArrayBuffer);
  });

  it('keeps the refused bundle’s report, reason and request id on the thrown error', async () => {
    const validation = { conformance: [], policy: [], advisory: [], summary: { conformant: false } };
    await expect(
      postArchive('/okf/import/archive', archive, async () =>
        jsonResponse(422, { message: 'Nothing was imported.', reason: 'bundle_not_conformant', validation }, { 'x-request-id': 'req-1' }),
      ),
    ).rejects.toEqual({
      statusCode: 422,
      status: 422,
      message: 'Nothing was imported.',
      reason: 'bundle_not_conformant',
      validation,
      request_id: 'req-1',
    });
  });

  it('falls back to the status line for a non-JSON error body', async () => {
    await expect(
      postArchive('/okf/validate/archive', archive, async () => new Response('<html>bad gateway</html>', { status: 502, statusText: 'Bad Gateway' })),
    ).rejects.toMatchObject({ statusCode: 502, message: 'Bad Gateway' });
  });

  it('reports a network failure as such', async () => {
    await expect(
      postArchive('/okf/validate/archive', archive, async () => {
        throw new TypeError('Failed to fetch');
      }),
    ).rejects.toMatchObject({ statusCode: 0, network_error: true });
  });
});
