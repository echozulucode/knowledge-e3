/**
 * Maps to features/04-wikilinks-and-rename.feature
 *
 * API-driven verification. The autocomplete-in-editor scenarios are tagged
 * @pending @wave-e in the .feature file and will get a UI-driven test once
 * Wave E1 wires WikiLinkAutocomplete into Tiptap.
 */
import { test, expect, createPageViaApi } from './fixtures.js';

test.describe('wiki-links and backlinks — API', () => {
  test('backlinks endpoint returns inbound links with snippets', async ({ apiAsAdmin }) => {
    const hub = await createPageViaApi(apiAsAdmin, { title: 'Hub Page', status: 'published' });
    await createPageViaApi(apiAsAdmin, {
      title: 'Source A',
      body: 'See [[Hub Page]] for details.',
      status: 'published',
    });
    await createPageViaApi(apiAsAdmin, {
      title: 'Source B',
      body: 'Also reference [[Hub Page]] here.',
      status: 'published',
    });

    const res = await apiAsAdmin.get(`/api/v1/pages/${hub.id}/backlinks`);
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    const titles = body.backlinks.map((b: { source_title: string }) => b.source_title).sort();
    expect(titles).toEqual(['Source A', 'Source B']);
    // Snippets should reference the link
    for (const b of body.backlinks as { snippet: string }[]) {
      expect(b.snippet).toContain('[[Hub Page]]');
    }
  });

  test('rename with link_action=update_all atomically rewrites inbound links', async ({ apiAsAdmin }) => {
    const target = await createPageViaApi(apiAsAdmin, { title: 'OldName', status: 'published' });
    const linker = await createPageViaApi(apiAsAdmin, {
      title: 'Linker',
      body: 'See [[OldName]] now.',
      status: 'published',
    });

    const res = await apiAsAdmin.post(`/api/v1/pages/${target.id}/rename`, {
      headers: { 'If-Match': String(target.version_token) },
      data: { new_title: 'NewName', link_action: 'update_all' },
    });
    expect(res.ok()).toBeTruthy();

    const refetched = await apiAsAdmin.get(`/api/v1/pages/${linker.id}`);
    const linkerBody = await refetched.json();
    expect(linkerBody.page.body_markdown).toContain('[[NewName]]');
    expect(linkerBody.page.body_markdown).not.toContain('[[OldName]]');
  });

  test('rename leaves code-block content untouched', async ({ apiAsAdmin }) => {
    const target = await createPageViaApi(apiAsAdmin, { title: 'CodeName', status: 'published' });
    const linker = await createPageViaApi(apiAsAdmin, {
      title: 'CodeLinker',
      body: 'real: [[CodeName]]\n\n```ts\nconst s = "[[CodeName]]";\n```\n',
      status: 'published',
    });
    await apiAsAdmin.post(`/api/v1/pages/${target.id}/rename`, {
      headers: { 'If-Match': String(target.version_token) },
      data: { new_title: 'CodeRenamed', link_action: 'update_all' },
    });
    const linkerRes = await apiAsAdmin.get(`/api/v1/pages/${linker.id}`);
    const body = (await linkerRes.json()).page.body_markdown as string;
    expect(body).toContain('[[CodeRenamed]]');
    // The string inside the code block must not have been rewritten.
    expect(body).toContain('"[[CodeName]]"');
  });

  test('rename with link_action=skip leaves inbound links broken', async ({ apiAsAdmin }) => {
    const target = await createPageViaApi(apiAsAdmin, { title: 'WillRename', status: 'published' });
    const linker = await createPageViaApi(apiAsAdmin, {
      title: 'WillStay',
      body: 'a [[WillRename]] reference',
      status: 'published',
    });
    await apiAsAdmin.post(`/api/v1/pages/${target.id}/rename`, {
      headers: { 'If-Match': String(target.version_token) },
      data: { new_title: 'Renamed', link_action: 'skip' },
    });
    const refetched = await apiAsAdmin.get(`/api/v1/pages/${linker.id}`);
    const body = (await refetched.json()).page.body_markdown as string;
    expect(body).toContain('[[WillRename]]'); // still broken — confirms skip path
  });

  test('rename with stale expected_affected_versions returns 409 and rolls back', async ({ apiAsAdmin }) => {
    const target = await createPageViaApi(apiAsAdmin, { title: 'OldX', status: 'published' });
    const linker = await createPageViaApi(apiAsAdmin, {
      title: 'LinkerX',
      body: '[[OldX]] inbound',
      status: 'published',
    });
    // Bump linker so its version_token is no longer 1.
    await apiAsAdmin.put(`/api/v1/pages/${linker.id}`, {
      headers: { 'If-Match': String(linker.version_token) },
      data: { body: '[[OldX]] inbound — edited' },
    });

    const res = await apiAsAdmin.post(`/api/v1/pages/${target.id}/rename`, {
      headers: { 'If-Match': String(target.version_token) },
      data: {
        new_title: 'NewX',
        link_action: 'update_all',
        expected_affected_versions: { [linker.id]: linker.version_token }, // stale
      },
    });
    expect(res.status()).toBe(409);

    // Target was NOT renamed.
    const targetRefetch = await apiAsAdmin.get(`/api/v1/pages/${target.id}`);
    const targetBody = await targetRefetch.json();
    expect(targetBody.page.title).toBe('OldX');
  });
});
