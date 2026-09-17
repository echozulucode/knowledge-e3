import { describe, expect, it } from 'vitest';
import { fieldForSourceMessage, mapSourceSaveError } from './saveError.js';

describe('fieldForSourceMessage', () => {
  // The messages below are the registry's own (source-registry.service.ts) and class-validator's.
  it.each([
    ['include_globs: "/etc/*.md" must be a repository-relative glob (no leading "/" and no "..")', 'include_globs'],
    ['exclude_globs must be a list of glob strings', 'exclude_globs'],
    ['unknown content type "Nope" for default_type', 'default_type'],
    ['default_status must be draft or published', 'default_status'],
    ['sync_every_seconds must not be less than 5', 'sync_every_seconds'],
    ['local_dir "topics/a" is already used by source "main"; two sources cannot share one working tree', 'local_dir'],
    ['source id must be `main` or `topic:<slug>`', 'id'],
    ['remote URL must be an https://, ssh://, git@host:path, or file path', 'remote_url'],
    ['invalid remote URL', 'remote_url'],
    [
      'source "topic:a" cannot use mode "review" without a remote_url: there would be nowhere to push the item branch',
      'remote_url',
    ],
    ['source "topic:a" cannot use mode "review" without a host_kind: there would be no change-request host', 'host_kind'],
    ['branch must be a string', 'branch'],
  ])('%s → %s', (message, field) => {
    expect(fieldForSourceMessage(message)).toBe(field);
  });

  it('names no field for a dual-writer collision or a generic failure', () => {
    expect(
      fieldForSourceMessage('source "main" already writes git@h:o/r.git on branch main; same-branch dual writers are unsupported'),
    ).toBeNull();
    expect(fieldForSourceMessage('Internal server error')).toBeNull();
  });
});

describe('mapSourceSaveError', () => {
  it('puts a field message beside its field and leaves the footer empty', () => {
    expect(mapSourceSaveError({ statusCode: 400, message: 'unknown content type "Nope" for default_type' })).toEqual({
      fields: { default_type: 'unknown content type "Nope" for default_type' },
      summary: null,
    });
  });

  it('splits a class-validator array between fields and the footer', () => {
    expect(
      mapSourceSaveError({ statusCode: 400, message: ['sync_every_seconds must not be less than 5', 'something else went wrong'] }),
    ).toEqual({ fields: { sync_every_seconds: 'sync_every_seconds must not be less than 5' }, summary: 'something else went wrong' });
  });

  it('sends anything unplaceable to the footer, with a fallback when there is no message at all', () => {
    expect(mapSourceSaveError({ statusCode: 0, message: 'Network error — could not reach the server.' })).toEqual({
      fields: {},
      summary: 'Network error — could not reach the server.',
    });
    expect(mapSourceSaveError(null)).toEqual({ fields: {}, summary: 'The source was not saved.' });
    expect(mapSourceSaveError({ message: '' })).toEqual({ fields: {}, summary: 'The source was not saved.' });
  });
});
