import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiClient } from './api.js';

function stubFetch(status: number, body: unknown): void {
  vi.stubGlobal('fetch', async () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));
}

describe('ApiClient error bodies', () => {
  afterEach(() => vi.unstubAllGlobals());

  // the admin UX plan A2: the OKF import gate's 422 names every file at
  // fault in `validation`, and the client used to drop it before any page saw it.
  it('carries a refused bundle’s validation report through alongside the reason', async () => {
    const validation = { conformance: [{ path: 'concepts/a.md', severity: 'critical', message: 'x' }], summary: { conformant: false } };
    stubFetch(422, { message: 'Nothing was imported.', reason: 'bundle_not_conformant', validation });

    await expect(new ApiClient().post('/okf/import', { files: [] })).rejects.toMatchObject({
      statusCode: 422,
      message: 'Nothing was imported.',
      reason: 'bundle_not_conformant',
      validation,
    });
  });

  it('leaves validation off an error that has none, and keeps diagnostics as before', async () => {
    const diagnostics = [{ code: 'type.missing', severity: 'error', message: 'x' }];
    stubFetch(422, { message: 'lint', reason: 'lint_failed', diagnostics, validation: 'not an object' });

    const error = await new ApiClient().post('/items', {}).catch((e: unknown) => e);
    expect(error).toMatchObject({ statusCode: 422, reason: 'lint_failed', diagnostics });
    expect(error).not.toHaveProperty('validation');
  });
});
