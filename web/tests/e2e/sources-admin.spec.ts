import { test, expect, type Page } from './fixtures.js';

/**
 * Admin → Sources (features/13-sources-and-review.feature;
 * the admin UX review §4.4).
 *
 * Sources are registered through the admin API with `remote_url: null` and
 * `mode: 'direct'` so nothing here ever starts a sync engine, touches a remote,
 * or needs credentials: the server only spins an engine up for an enabled row
 * that has a remote. States a browser cannot produce that way — a parked
 * conflict, a HEAD — are grafted onto the real response at the boundary the
 * page consumes, the technique content-health.spec.ts uses.
 *
 * The page is a list (DataTable) with a detail sheet (`?source=`) and an
 * editor sheet (`?edit=` / `?new=1`); both sheets are dialogs named by their
 * title.
 */

const enc = encodeURIComponent;

/** A registry id unique to this worker; ids must be `main` or `topic:<slug>`. */
function sourceId(prefix: string, workerIndex: number): string {
  return `topic:${prefix}-${workerIndex}-${Date.now()}`;
}

/** The source's row in the list (the table in wide layouts, a card in narrow ones — same element). */
function rowFor(page: Page, id: string) {
  return page.locator(`tr[data-row-key="${id}"]`);
}

/** The detail sheet of one source. */
function detailSheet(page: Page, id: string) {
  return page.getByRole('dialog', { name: id, exact: true });
}

/** Choose an item from a row's `⋯` menu. */
async function rowMenu(page: Page, id: string, item: string) {
  await rowFor(page, id).getByRole('button', { name: `Actions for ${id}` }).click();
  await page.getByRole('menuitem', { name: item }).click();
}

/**
 * Graft live-state fields onto chosen rows of the real `GET /admin/sources`
 * response. Returns the route matcher so the test can unroute it.
 */
async function graftSources(page: Page, patches: Record<string, Record<string, unknown>>) {
  const sourcesRoute = (url: URL) => url.pathname === '/api/v1/admin/sources';
  await page.route(sourcesRoute, async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    const response = await route.fetch();
    const body = (await response.json()) as { sources: Record<string, unknown>[] };
    for (const source of body.sources) {
      const patch = patches[source['id'] as string];
      if (patch) Object.assign(source, patch);
    }
    await route.fulfill({ status: response.status(), contentType: 'application/json', body: JSON.stringify(body) });
  });
  return sourcesRoute;
}

const CONFLICT_STATUS = (id: string) => ({
  status: {
    source: id,
    state: 'conflict',
    ahead: 0,
    behind: 1,
    dirty_paths: [],
    conflicted_paths: ['concepts/runbook.md', 'concepts/other.md'],
    last_synced_at: null,
    last_error: null,
  },
});

test.describe('Admin → Sources', () => {
  test('lists a registered source with its policy, remote, and live state', async ({ signedInPage, apiAsAdmin }, testInfo) => {
    const id = sourceId('e2e-src', testInfo.workerIndex);
    const registered = await apiAsAdmin.put(`/api/v1/admin/sources/${enc(id)}`, {
      data: { remote_url: null, mode: 'direct', role: 'authoritative', local_dir: `topics/${id.slice(6)}`, enabled: true },
    });
    if (!registered.ok()) throw new Error(`register source failed: ${registered.status()} ${await registered.text()}`);

    try {
      await signedInPage.goto('/admin/repos');
      await expect(signedInPage.getByRole('heading', { name: 'Sources', exact: true })).toBeVisible();

      const row = rowFor(signedInPage, id);
      await expect(row).toBeVisible();
      await expect(row).toContainText('Direct · Authoritative');
      await expect(row).toContainText('local only');
      await expect(row).toContainText('Never');
      await expect(row).toContainText('In sync');

      // No remote means nothing to sync or push — and the menu says why, in text.
      await expect(row.getByRole('button', { name: 'Sync now' })).toBeDisabled();
      await row.getByRole('button', { name: `Actions for ${id}` }).click();
      const pushItem = signedInPage.getByRole('menuitem', { name: 'Push now' });
      await expect(pushItem).toHaveAttribute('aria-disabled', 'true');
      await expect(pushItem).toContainText('This source has no remote');
      await signedInPage.keyboard.press('Escape');
    } finally {
      await apiAsAdmin.delete(`/api/v1/admin/sources/${enc(id)}`);
    }
  });

  test('the attention strip names a blocked source and opens it on the right tab; filters live in the URL', async ({
    signedInPage,
    apiAsAdmin,
  }, testInfo) => {
    const clean = sourceId('e2e-clean-row', testInfo.workerIndex);
    const blocked = sourceId('e2e-blocked-row', testInfo.workerIndex);
    for (const id of [clean, blocked]) {
      const registered = await apiAsAdmin.put(`/api/v1/admin/sources/${enc(id)}`, {
        data: { remote_url: null, mode: 'direct', local_dir: `topics/${id.slice(6)}` },
      });
      if (!registered.ok()) throw new Error(`register source failed: ${registered.status()} ${await registered.text()}`);
    }
    const sourcesRoute = await graftSources(signedInPage, { [blocked]: CONFLICT_STATUS(blocked) });

    try {
      await signedInPage.goto('/admin/repos');
      await expect(rowFor(signedInPage, blocked)).toContainText('Conflict (2)');

      const strip = signedInPage.getByRole('region', { name: /need(s)? attention/ });
      const item = strip.getByRole('button', { name: `${blocked} — Conflict (2)` });
      await expect(item).toBeVisible();
      await expect(strip.getByRole('button', { name: new RegExp(`^${clean}`) })).toHaveCount(0);

      // The entry opens that source's sheet on its Conflicts tab, addressably.
      await item.click();
      const sheet = detailSheet(signedInPage, blocked);
      await expect(sheet).toBeVisible();
      await expect(sheet.getByRole('tab', { name: /^Conflicts/ })).toHaveAttribute('aria-selected', 'true');
      await expect(signedInPage).toHaveURL(/[?&]tab=conflicts/);
      await sheet.getByRole('button', { name: `Close ${blocked}` }).click();
      await expect(sheet).toHaveCount(0);

      // Search narrows by id, remote or working tree, and survives a reload.
      const filters = signedInPage.getByRole('search', { name: 'Filter sources' });
      await filters.getByLabel('Search').fill(clean);
      await expect(rowFor(signedInPage, blocked)).toHaveCount(0);
      await expect(rowFor(signedInPage, clean)).toBeVisible();
      await expect(signedInPage).toHaveURL(/[?&]q=/);
      await signedInPage.reload();
      await expect(signedInPage.getByRole('search', { name: 'Filter sources' }).getByLabel('Search')).toHaveValue(clean);
      await expect(rowFor(signedInPage, blocked)).toHaveCount(0);

      // State: Needs attention keeps the blocked source and drops the clean one.
      await signedInPage.getByRole('button', { name: 'Clear filters' }).first().click();
      await signedInPage.getByRole('search', { name: 'Filter sources' }).getByLabel('State').selectOption({ label: 'Needs attention' });
      await expect(signedInPage).toHaveURL(/[?&]state=attention/);
      await expect(rowFor(signedInPage, blocked)).toBeVisible();
      await expect(rowFor(signedInPage, clean)).toHaveCount(0);

      // Policy: no direct source is a review source.
      await signedInPage.getByRole('search', { name: 'Filter sources' }).getByLabel('State').selectOption({ label: 'All' });
      await signedInPage.getByRole('search', { name: 'Filter sources' }).getByLabel('Policy').selectOption({ label: 'Review' });
      await expect(rowFor(signedInPage, clean)).toHaveCount(0);
      await expect(rowFor(signedInPage, blocked)).toHaveCount(0);
    } finally {
      await signedInPage.unroute(sourcesRoute);
      await apiAsAdmin.delete(`/api/v1/admin/sources/${enc(clean)}`);
      await apiAsAdmin.delete(`/api/v1/admin/sources/${enc(blocked)}`);
    }
  });

  test('a deep link opens the detail sheet on the named tab, and tabs keep the URL in step', async ({ signedInPage, apiAsAdmin }, testInfo) => {
    const id = sourceId('e2e-deeplink', testInfo.workerIndex);
    const registered = await apiAsAdmin.put(`/api/v1/admin/sources/${enc(id)}`, {
      data: { remote_url: null, mode: 'direct' },
    });
    if (!registered.ok()) throw new Error(`register source failed: ${registered.status()} ${await registered.text()}`);

    try {
      await signedInPage.goto(`/admin/repos?source=${enc(id)}&tab=conflicts`);
      const sheet = detailSheet(signedInPage, id);
      await expect(sheet.getByRole('tab', { name: /^Conflicts/ })).toHaveAttribute('aria-selected', 'true');
      const conflicts = sheet.getByRole('region', { name: `Conflicts for ${id}` });
      await expect(conflicts.getByText(/merging cleanly/i)).toBeVisible();

      // Direct mode never opens change requests, so the sheet offers no such tab.
      await expect(sheet.getByRole('tab', { name: 'Change requests' })).toHaveCount(0);

      await sheet.getByRole('tab', { name: 'Selection' }).click();
      await expect(signedInPage).toHaveURL(/[?&]tab=selection/);
      await sheet.getByRole('tab', { name: 'Overview' }).click();
      await expect(signedInPage).not.toHaveURL(/[?&]tab=/);
      await expect(sheet.getByRole('region', { name: `Overview of ${id}` })).toContainText(/local only/i);

      // A link to a source that is not registered says so instead of showing nothing.
      await signedInPage.goto(`/admin/repos?source=${enc('topic:e2e-not-registered')}`);
      await expect(signedInPage.getByRole('dialog', { name: 'topic:e2e-not-registered' })).toContainText('No such source');
    } finally {
      await apiAsAdmin.delete(`/api/v1/admin/sources/${enc(id)}`);
    }
  });

  test('the resolved conflict history comes from the server and survives a reload', async ({ signedInPage, apiAsAdmin }, testInfo) => {
    const id = sourceId('e2e-history', testInfo.workerIndex);
    const registered = await apiAsAdmin.put(`/api/v1/admin/sources/${enc(id)}`, {
      data: { remote_url: null, mode: 'direct' },
    });
    if (!registered.ok()) throw new Error(`register source failed: ${registered.status()} ${await registered.text()}`);

    // Parking a real merge conflict needs a remote and a two-sided edit (covered
    // by server/tests/sync-conflicts.e2e.test.ts). Here the queue route is
    // stubbed with a conflict resolved *before this visit*, which is exactly the
    // state a session-local history could not reproduce.
    const asked: string[] = [];
    const conflictsRoute = (url: URL) => url.pathname.startsWith('/api/v1/admin/sources/') && url.pathname.endsWith('/conflicts');
    await signedInPage.route(conflictsRoute, async (route, request) => {
      asked.push(request.url());
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          conflicts: [
            {
              id: 'conflict-from-an-earlier-session',
              source_id: id,
              path: 'concepts/runbook.md',
              page_id: null,
              ours: 'Local edit.',
              theirs: 'Upstream edit.',
              base: 'Line one.',
              detected_at: '2026-02-01T10:00:00.000Z',
              resolved_at: '2026-02-01T11:00:00.000Z',
              resolution: 'theirs',
              resolved_by: 'usr_admin',
              resolved_by_username: 'admin',
            },
          ],
          resolved_limit: 20,
        }),
      });
    });

    /** Open the source's Conflicts tab and expand the collapsed resolved history. */
    async function openHistory() {
      const conflicts = detailSheet(signedInPage, id).getByRole('region', { name: `Conflicts for ${id}` });
      await conflicts.locator('summary', { hasText: /^Resolved \(1\)$/ }).click();
      return conflicts.getByRole('table', { name: `Resolved conflicts for ${id}` });
    }

    try {
      await signedInPage.goto('/admin/repos');
      await rowFor(signedInPage, id).getByText(id, { exact: true }).click();
      await detailSheet(signedInPage, id).getByRole('tab', { name: /^Conflicts/ }).click();
      const history = await openHistory();
      const entry = history.locator('tr[data-resolved-path="concepts/runbook.md"]');
      await expect(entry).toBeVisible();
      await expect(entry).toContainText('Kept theirs');
      await expect(entry).toContainText('admin');
      // Nothing is open, so the open list still says the source merges cleanly.
      await expect(detailSheet(signedInPage, id).getByText(/merging cleanly/i)).toBeVisible();

      // The panel asked the server for the resolved rows rather than remembering them.
      expect(asked.length).toBeGreaterThan(0);
      expect(asked.every((u) => u.includes('includeResolved=true'))).toBe(true);

      // A reload wipes every session-local memory; the URL reopens the same tab
      // and the history must still be there.
      await signedInPage.reload();
      const afterReload = await openHistory();
      await expect(afterReload.locator('tr[data-resolved-path="concepts/runbook.md"]')).toContainText('Kept theirs');
    } finally {
      await signedInPage.unroute(conflictsRoute);
      await apiAsAdmin.delete(`/api/v1/admin/sources/${enc(id)}`);
    }
  });

  test('Keep theirs shows both sides as a diff and asks first, naming the file and the side discarded', async ({
    signedInPage,
    apiAsAdmin,
  }, testInfo) => {
    const id = sourceId('e2e-resolve', testInfo.workerIndex);
    const registered = await apiAsAdmin.put(`/api/v1/admin/sources/${enc(id)}`, {
      data: { remote_url: null, mode: 'direct' },
    });
    if (!registered.ok()) throw new Error(`register source failed: ${registered.status()} ${await registered.text()}`);

    // Both the queue and the resolve call are stubbed: a real conflict needs a
    // remote (server/tests/sync-conflicts.e2e.test.ts covers the engine side).
    // The stub flips the row to resolved once the POST arrives, as the server does.
    const conflict = {
      id: 'conflict-open-e2e',
      source_id: id,
      path: 'concepts/runbook.md',
      page_id: null,
      ours: 'Line one.\nLocal edit.\n',
      theirs: 'Line one.\nUpstream edit.\n',
      base: 'Line one.\n',
      detected_at: '2026-09-01T10:00:00.000Z',
      resolved_at: null as string | null,
      resolution: null as string | null,
      resolved_by: null as string | null,
      resolved_by_username: null as string | null,
    };
    const resolveBodies: unknown[] = [];
    const conflictsRoute = (url: URL) => url.pathname.startsWith('/api/v1/admin/sources/') && url.pathname.endsWith('/conflicts');
    const resolveRoute = (url: URL) => url.pathname === `/api/v1/admin/sources/conflicts/${conflict.id}/resolve`;
    await signedInPage.route(conflictsRoute, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ conflicts: [conflict], resolved_limit: 20 }) }),
    );
    await signedInPage.route(resolveRoute, async (route, request) => {
      resolveBodies.push(request.postDataJSON());
      Object.assign(conflict, { resolved_at: '2026-09-01T11:00:00.000Z', resolution: 'theirs', resolved_by: 'usr_admin', resolved_by_username: 'admin' });
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ conflict, status: CONFLICT_STATUS(id).status }),
      });
    });

    try {
      await signedInPage.goto(`/admin/repos?source=${enc(id)}&tab=conflicts`);
      const sheet = detailSheet(signedInPage, id);
      const card = sheet.locator('[data-conflict-path="concepts/runbook.md"]');
      await expect(card).toBeVisible();
      await expect(card.getByText('Mine (here)')).toBeVisible();
      await expect(card.getByText('Theirs (remote)')).toBeVisible();
      await expect(card).toContainText('Local edit.');
      await expect(card).toContainText('Upstream edit.');

      // Asking is not doing: Cancel sends nothing.
      await card.getByRole('button', { name: 'Keep theirs' }).click();
      const confirm = signedInPage.getByRole('dialog', { name: 'Keep theirs for concepts/runbook.md?' });
      await expect(confirm).toBeVisible();
      await expect(confirm).toContainText(/\(mine\) is discarded/i);
      await confirm.getByRole('button', { name: 'Cancel' }).click();
      await expect(confirm).toHaveCount(0);
      // Cancelling the dialog leaves the sheet under it open.
      await expect(sheet).toBeVisible();
      expect(resolveBodies).toHaveLength(0);

      // Esc also dismisses only the dialog.
      await card.getByRole('button', { name: 'Keep theirs' }).click();
      await expect(confirm).toBeVisible();
      await signedInPage.keyboard.press('Escape');
      await expect(confirm).toHaveCount(0);
      await expect(sheet).toBeVisible();

      await card.getByRole('button', { name: 'Keep theirs' }).click();
      await confirm.getByRole('button', { name: 'Keep theirs' }).click();
      await expect(confirm).toHaveCount(0);
      expect(resolveBodies).toEqual([{ choice: 'theirs' }]);
      await expect(signedInPage.getByText('Kept theirs for concepts/runbook.md.')).toBeVisible();

      // The conflict leaves the open list for the resolved history.
      await expect(card).toHaveCount(0);
      const conflicts = sheet.getByRole('region', { name: `Conflicts for ${id}` });
      await conflicts.locator('summary', { hasText: /^Resolved \(1\)$/ }).click();
      await expect(conflicts.locator('tr[data-resolved-path="concepts/runbook.md"]')).toContainText('Kept theirs');
    } finally {
      await signedInPage.unroute(conflictsRoute);
      await signedInPage.unroute(resolveRoute);
      await apiAsAdmin.delete(`/api/v1/admin/sources/${enc(id)}`);
    }
  });

  test('the editor explains each sync policy and asks for a host only under review', async ({ signedInPage }) => {
    await signedInPage.goto('/admin/repos');
    await signedInPage.getByRole('button', { name: /add source/i }).first().click();

    const editor = signedInPage.getByRole('dialog', { name: 'Register a source' });
    await expect(editor).toBeVisible();
    await expect(signedInPage).toHaveURL(/[?&]new=1/);

    // Plan §8.2: each policy says what it does and who it fits.
    await expect(editor.getByText(/debounced, per author/i)).toBeVisible();
    // The review mode card's own sentence (the Advanced branch-prefix helper also mentions per-item branches).
    await expect(editor.getByText(/commits to a per-item branch/i)).toBeVisible();
    await expect(editor.getByText(/no local commits and no push/i)).toBeVisible();
    await expect(editor.getByText(/Fits: Solo, small team, backup remote/i)).toBeVisible();
    await expect(editor.getByText(/Fits: Teams whose repository requires PRs/i)).toBeVisible();

    // Direct is the default and needs no change-request host.
    await expect(editor.locator('input[name="source-mode"][value="direct"]')).toBeChecked();
    await expect(editor.getByRole('combobox', { name: /^Host\b/ })).toHaveCount(0);

    await editor.locator('input[name="source-mode"][value="review"]').check();
    await expect(editor.getByRole('group', { name: 'Change-request host' })).toBeVisible();
    // Required fields carry a required marker in their accessible name, so match the select by role and prefix.
    await expect(editor.getByRole('combobox', { name: /^Host\b/ })).toBeVisible();
    await expect(editor.getByLabel('Host base URL')).toBeVisible();
    await expect(editor.getByLabel('Host token env var')).toBeVisible();
    await expect(editor.getByLabel('Webhook secret env var')).toBeVisible();

    // Review mode cannot be saved without one: the field says why, and the
    // summary at the top lists it.
    await editor.getByLabel('Source id').fill('topic:needs-a-host');
    await editor.getByRole('button', { name: 'Register source' }).click();
    await expect(editor.getByRole('combobox', { name: /^Host\b/ })).toHaveAttribute('aria-invalid', 'true');
    await expect(editor.locator('#source-host_kind-error')).toContainText(/needs a change-request host/i);
    await expect(editor.locator('.Sources__errorSummary')).toContainText('Host');
    await expect(editor.locator('.kp-sheet__error')).toContainText(/not saved/i);

    // No credential field anywhere — tokens are named by environment variable.
    await expect(editor.locator('input[type="password"]')).toHaveCount(0);
  });

  test('registers a local, direct source through the editor and lands on its detail sheet', async ({ signedInPage, apiAsAdmin }, testInfo) => {
    const id = sourceId('e2e-form', testInfo.workerIndex);
    const slug = id.slice('topic:'.length);

    try {
      await signedInPage.goto('/admin/repos');
      await signedInPage.getByRole('button', { name: /add source/i }).first().click();

      const editor = signedInPage.getByRole('dialog', { name: 'Register a source' });
      await editor.getByLabel('Source id').fill(id);
      await editor.getByLabel('Local working tree').fill(`topics/${slug}`);
      await editor.locator('input[name="source-mode"][value="direct"]').check();
      await editor.getByRole('button', { name: 'Register source' }).click();

      await expect(signedInPage.getByText('Source saved')).toBeVisible();
      await expect(editor).toHaveCount(0);
      const sheet = detailSheet(signedInPage, id);
      await expect(sheet).toBeVisible();
      await expect(sheet.locator('[data-detail="local-dir"]')).toHaveText(`topics/${slug}`);
      await sheet.getByRole('button', { name: `Close ${id}` }).click();

      const row = rowFor(signedInPage, id);
      await expect(row).toBeVisible();
      await expect(row).toContainText('Direct');
    } finally {
      await apiAsAdmin.delete(`/api/v1/admin/sources/${enc(id)}`);
    }
  });

  test('closing the editor with unsaved changes asks before discarding them', async ({ signedInPage, apiAsAdmin }, testInfo) => {
    const id = sourceId('e2e-dirty', testInfo.workerIndex);
    const registered = await apiAsAdmin.put(`/api/v1/admin/sources/${enc(id)}`, {
      data: { remote_url: null, mode: 'direct' },
    });
    if (!registered.ok()) throw new Error(`register source failed: ${registered.status()} ${await registered.text()}`);

    try {
      await signedInPage.goto(`/admin/repos?edit=${enc(id)}`);
      const editor = signedInPage.getByRole('dialog', { name: `Edit ${id}` });
      // Nothing changed yet: nothing to save.
      await expect(editor.getByRole('button', { name: 'Save source' })).toBeDisabled();
      await editor.getByLabel('Branch', { exact: true }).fill('e2e-unsaved');

      await editor.getByRole('button', { name: 'Cancel' }).click();
      const discard = signedInPage.getByRole('dialog', { name: 'Discard changes?' });
      await expect(discard).toBeVisible();
      await discard.getByRole('button', { name: 'Cancel' }).click();
      await expect(editor.getByLabel('Branch', { exact: true })).toHaveValue('e2e-unsaved');

      await editor.getByRole('button', { name: 'Cancel' }).click();
      await discard.getByRole('button', { name: 'Discard' }).click();
      await expect(editor).toHaveCount(0);
      await expect(signedInPage).not.toHaveURL(/[?&]edit=/);
    } finally {
      await apiAsAdmin.delete(`/api/v1/admin/sources/${enc(id)}`);
    }
  });

  test('Remove asks for the source id to be typed, and nothing is removed until it is', async ({ signedInPage, apiAsAdmin }, testInfo) => {
    const id = sourceId('e2e-remove', testInfo.workerIndex);
    const registered = await apiAsAdmin.put(`/api/v1/admin/sources/${enc(id)}`, {
      data: { remote_url: null, mode: 'direct', local_dir: `topics/${id.slice(6)}` },
    });
    if (!registered.ok()) throw new Error(`register source failed: ${registered.status()} ${await registered.text()}`);

    const stillRegistered = async () =>
      ((await (await apiAsAdmin.get('/api/v1/admin/sources')).json()).sources as { id: string }[]).some((s) => s.id === id);

    try {
      await signedInPage.goto('/admin/repos');
      const row = rowFor(signedInPage, id);
      await rowMenu(signedInPage, id, 'Remove…');

      // Review §3.3: removing a source is a typed confirmation, and it says what it leaves alone.
      const dialog = signedInPage.getByRole('dialog', { name: `Remove ${id}?` });
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText(/files on disk and the remote repository are untouched/i);
      const confirm = dialog.getByRole('button', { name: 'Remove source' });
      await expect(confirm).toBeDisabled();

      // Cancelling removes nothing.
      await dialog.getByRole('button', { name: 'Cancel' }).click();
      await expect(dialog).toHaveCount(0);
      await expect(row).toBeVisible();
      expect(await stillRegistered()).toBe(true);

      // A near miss keeps the button disabled; the exact id enables it.
      await rowMenu(signedInPage, id, 'Remove…');
      await dialog.getByLabel(/type .* to confirm/i).fill(id.slice(0, -1));
      await expect(confirm).toBeDisabled();
      await dialog.getByLabel(/type .* to confirm/i).fill(id);
      await confirm.click();

      await expect(dialog).toHaveCount(0);
      await expect(row).toHaveCount(0);
      await expect(signedInPage.getByText(`Removed ${id}.`)).toBeVisible();
      expect(await stillRegistered()).toBe(false);
    } finally {
      await apiAsAdmin.delete(`/api/v1/admin/sources/${enc(id)}`);
    }
  });

  test('a save the server refuses keeps the editor open with everything typed, the reason beside its field', async ({
    signedInPage,
    apiAsAdmin,
  }, testInfo) => {
    const holder = sourceId('e2e-holder', testInfo.workerIndex);
    const blocked = sourceId('e2e-blocked', testInfo.workerIndex);
    const sharedDir = `topics/${holder.slice(6)}`;
    // Two enabled sources cannot share a working tree — a rule only the server
    // knows (it needs the other rows), so the form cannot catch it first.
    const registered = await apiAsAdmin.put(`/api/v1/admin/sources/${enc(holder)}`, {
      data: { remote_url: null, mode: 'direct', local_dir: sharedDir, enabled: true },
    });
    if (!registered.ok()) throw new Error(`register source failed: ${registered.status()} ${await registered.text()}`);

    try {
      await signedInPage.goto('/admin/repos');
      await signedInPage.getByRole('button', { name: /add source/i }).first().click();
      const editor = signedInPage.getByRole('dialog', { name: 'Register a source' });
      await editor.getByLabel('Source id').fill(blocked);
      await editor.getByLabel('Local working tree').fill(sharedDir);
      await editor.getByLabel('Branch', { exact: true }).fill('e2e-branch');
      await editor.getByRole('button', { name: 'Register source' }).click();

      // The refusal is beside the field it is about, listed in the summary, and
      // announced in the sheet's footer.
      const localDir = editor.getByLabel('Local working tree');
      await expect(editor.locator('#source-local_dir-error')).toContainText(/is already used by source/i);
      await expect(localDir).toHaveAttribute('aria-invalid', 'true');
      await expect(editor.locator('.Sources__errorSummary')).toContainText('Local working tree');
      await expect(editor.locator('.kp-sheet__error')).toContainText(/not saved/i);
      // Nothing was typed in vain.
      await expect(editor).toBeVisible();
      await expect(editor.getByLabel('Source id')).toHaveValue(blocked);
      await expect(editor.getByLabel('Branch', { exact: true })).toHaveValue('e2e-branch');

      // Editing the field clears its message; a valid tree then saves, closes the
      // editor, and opens the new source's detail sheet.
      await localDir.fill(`topics/${blocked.slice(6)}`);
      await expect(editor.getByText(/is already used by source/i)).toHaveCount(0);
      await editor.getByRole('button', { name: 'Register source' }).click();
      await expect(signedInPage.getByText('Source saved')).toBeVisible();
      await expect(editor).toHaveCount(0);
      await expect(detailSheet(signedInPage, blocked)).toBeVisible();
    } finally {
      await apiAsAdmin.delete(`/api/v1/admin/sources/${enc(blocked)}`);
      await apiAsAdmin.delete(`/api/v1/admin/sources/${enc(holder)}`);
    }
  });

  test('a Test connection result is cleared when the remote URL changes', async ({ signedInPage }) => {
    await signedInPage.goto('/admin/repos?new=1');
    const editor = signedInPage.getByRole('dialog', { name: 'Register a source' });

    // A path that is not a repository: the probe answers without any network.
    const remote = editor.getByLabel('Remote URL');
    await remote.fill('/nonexistent/e2e-not-a-repo');
    await editor.getByRole('button', { name: 'Test connection' }).click();
    const result = editor.locator('.Sources__testRow [role="status"]');
    await expect(result).toBeVisible({ timeout: 30_000 });

    // The verdict was about the old URL; it must not stay beside a new one.
    await remote.fill('/nonexistent/e2e-another');
    await expect(result).toHaveCount(0);
  });

  test('the admin console points at Sources and the review queue is reachable', async ({ signedInPage }) => {
    await signedInPage.goto('/admin');
    await expect(signedInPage.getByRole('region', { name: 'Operations' }).getByRole('link', { name: 'Sources', exact: true })).toHaveAttribute(
      'href',
      '/admin/repos',
    );

    // Admins always get the Review entry, between Latest and Sections (§3.4;
    // Browse and Tags are no longer sidebar destinations).
    const sidebar = signedInPage.locator('.kp-sidebar');
    await expect(sidebar.getByRole('button', { name: 'Review', exact: true })).toBeVisible();
    for (const label of ['Home', 'Topics', 'Latest', 'Sections', 'Search']) {
      await expect(sidebar.getByRole('button', { name: label, exact: true })).toBeVisible();
    }

    await sidebar.getByRole('button', { name: 'Review', exact: true }).click();
    await expect(signedInPage).toHaveURL(/\/review$/);
    await expect(signedInPage.getByRole('heading', { name: 'In review', exact: true })).toBeVisible();
  });
});

/**
 * Plan B3 / D4a — the source tells the truth about its host.
 *
 * Runbook §3.3's diagnosis is "is that variable set on THIS server", and until
 * now nothing in the product could answer it. The two sources below are the two
 * answers, produced without a secret existing anywhere: `PATH` is set in every
 * process that could be running this test, and a name nobody exports is not.
 */
test.describe('Admin → Sources → host tokens', () => {
  test('says whether the env var a source names is set on this server, and never what is in it', async ({
    signedInPage,
    apiAsAdmin,
  }, testInfo) => {
    const present = sourceId('e2e-tokenset', testInfo.workerIndex);
    const absent = sourceId('e2e-tokenmissing', testInfo.workerIndex);
    const missingVar = `E3_E2E_UNSET_TOKEN_${testInfo.workerIndex}`;
    const pathValue = process.env['PATH'];
    expect(pathValue, 'PATH is set in every process that could run this, which is what makes it the probe').toBeTruthy();
    for (const [id, env] of [
      [present, 'PATH'],
      [absent, missingVar],
    ] as const) {
      const registered = await apiAsAdmin.put(`/api/v1/admin/sources/${enc(id)}`, {
        data: { remote_url: null, mode: 'direct', host_token_env: env, local_dir: `topics/${id.slice(6)}` },
      });
      if (!registered.ok()) throw new Error(`register source failed: ${registered.status()} ${await registered.text()}`);
    }

    try {
      // What crosses the wire is a boolean beside the NAME. Asserted on the
      // response rather than only on the pixels, because "the value never
      // leaves the server" is a claim about the payload.
      const wire = await (await apiAsAdmin.get('/api/v1/admin/sources')).json();
      const row = (wire.sources as { id: string; host_token_present: boolean }[]).find((s) => s.id === present);
      expect(row?.host_token_present).toBe(true);
      expect(JSON.stringify(wire)).not.toContain(pathValue!);

      await signedInPage.goto(`/admin/repos?source=${enc(present)}`);
      const set = detailSheet(signedInPage, present).locator('[data-secret="host-token"]');
      await expect(set).toHaveText('PATH ✓');
      await expect(set).toHaveAttribute('data-tone', 'ok');
      await expect(set).toHaveAttribute('title', /never leaves the server/i);

      await signedInPage.goto(`/admin/repos?source=${enc(absent)}`);
      const unset = detailSheet(signedInPage, absent).locator('[data-secret="host-token"]');
      await expect(unset).toHaveText(`${missingVar} ✗ not set on this server`);
      await expect(unset).toHaveAttribute('data-tone', 'error');
      // B5: the chip says where the runbook answers it.
      await expect(unset).toHaveAttribute('title', /runbook §3\.3/);
      await expect(unset).toHaveAttribute('title', /docs\/operations-runbook\.md#33-/);
      // A direct source is not blocked by a token it never uses, so the
      // attention strip does not list it.
      await expect(signedInPage.locator(`[data-attention="host-token"]`, { hasText: absent })).toHaveCount(0);

      // And the value itself is nowhere on the page, in text or in a title.
      const rendered = await signedInPage.evaluate(() => document.documentElement.outerHTML);
      expect(rendered).not.toContain(pathValue!);
    } finally {
      await apiAsAdmin.delete(`/api/v1/admin/sources/${enc(present)}`);
      await apiAsAdmin.delete(`/api/v1/admin/sources/${enc(absent)}`);
    }
  });
});

/**
 * Plan A1 — what a source selects, and what that selection indexed.
 *
 * Before this, `include_globs` / `exclude_globs` / `default_type` were settable
 * only from the config file or curl, and a source configured that way looked
 * exactly like an ordinary OKF source. Sources are still registered with no
 * remote, so nothing here starts an engine or touches a repository.
 */
test.describe('Admin → Sources → selection and details', () => {
  test('editing globs and the default type round-trips, marks the row Selective, and shows on the Selection tab', async ({
    signedInPage,
    apiAsAdmin,
  }, testInfo) => {
    const id = sourceId('e2e-globs', testInfo.workerIndex);
    const registered = await apiAsAdmin.put(`/api/v1/admin/sources/${enc(id)}`, {
      data: { remote_url: null, mode: 'direct', local_dir: `topics/${id.slice(6)}` },
    });
    if (!registered.ok()) throw new Error(`register source failed: ${registered.status()} ${await registered.text()}`);

    try {
      await signedInPage.goto('/admin/repos');
      const row = rowFor(signedInPage, id);
      await expect(row).toBeVisible();
      // An ordinary source indexes the OKF layout and says nothing about it.
      await expect(row.locator('[data-kind="selection"]')).toHaveCount(0);

      await rowMenu(signedInPage, id, 'Edit…');
      const editor = signedInPage.getByRole('dialog', { name: `Edit ${id}` });
      await expect(editor).toBeVisible();

      // The selection is collapsed, and its summary says what is in effect.
      const selection = editor.locator('details', { has: signedInPage.locator('summary', { hasText: 'OKF layout (default)' }) });
      await selection.locator('summary').click();

      // A glob that leaves the repository is refused beside the field, before any request.
      await editor.getByLabel('Include globs').fill('docs/**/*.md\n/etc/*.md');
      await editor.getByRole('button', { name: 'Save source' }).click();
      await expect(editor.locator('#source-include_globs-error')).toContainText(/is an absolute path/i);
      await expect(editor).toBeVisible();

      await editor.getByLabel('Include globs').fill('docs/**/*.md\n\n  handbook/*.md  ');
      await editor.getByLabel('Exclude globs').fill('docs/archive/**');
      await editor.getByLabel('Default type for imported files').selectOption({ label: 'How-To' });
      await editor.getByRole('button', { name: 'Save source' }).click();
      await expect(signedInPage.getByText('Source saved')).toBeVisible();

      // Stored as the server stores it: trimmed, blank lines dropped.
      const wire = await (await apiAsAdmin.get('/api/v1/admin/sources')).json();
      const saved = (wire.sources as Record<string, unknown>[]).find((s) => s['id'] === id);
      expect(saved).toMatchObject({
        include_globs: '["docs/**/*.md","handbook/*.md"]',
        exclude_globs: '["docs/archive/**"]',
        default_type: 'How-To',
      });

      // Saving lands on the detail sheet; its Selection tab shows what was saved.
      const sheet = detailSheet(signedInPage, id);
      await sheet.getByRole('tab', { name: 'Selection' }).click();
      const details = sheet.getByRole('region', { name: `Selection for ${id}` });
      await expect(details.locator('[data-detail="include"]')).toContainText('docs/**/*.md');
      await expect(details.locator('[data-detail="include"]')).toContainText('handbook/*.md');
      await expect(details.locator('[data-detail="exclude"]')).toContainText('docs/archive/**');
      await expect(details.locator('[data-detail="default-type"]')).toHaveText('How-To');

      // Edit from the sheet: the collapsed summary now names the globs, one per line inside.
      await sheet.getByRole('button', { name: 'Edit', exact: true }).click();
      const again = signedInPage.getByRole('dialog', { name: `Edit ${id}` });
      await again.locator('summary', { hasText: 'docs/**/*.md, handbook/*.md minus docs/archive/**' }).click();
      await expect(again.getByLabel('Include globs')).toHaveValue('docs/**/*.md\nhandbook/*.md');
      await expect(again.getByLabel('Default type for imported files')).toHaveValue('How-To');

      // Clearing both lists restores the default layout.
      await again.getByLabel('Include globs').fill('');
      await again.getByLabel('Exclude globs').fill('');
      await again.getByLabel('Default type for imported files').selectOption('');
      await again.getByRole('button', { name: 'Save source' }).click();
      await expect(again).toHaveCount(0);
      await sheet.getByRole('tab', { name: 'Selection' }).click();
      await expect(sheet.locator('[data-detail="include"]')).toContainText(/concepts\/\*\.md at any depth/);
      await sheet.getByRole('button', { name: `Close ${id}` }).click();

      await expect(row.locator('[data-kind="selection"]')).toHaveCount(0);
    } finally {
      await apiAsAdmin.delete(`/api/v1/admin/sources/${enc(id)}`);
    }
  });

  test('a glob-selecting source is marked Selective in the list, with every glob in its description', async ({
    signedInPage,
    apiAsAdmin,
  }, testInfo) => {
    const id = sourceId('e2e-selective', testInfo.workerIndex);
    const registered = await apiAsAdmin.put(`/api/v1/admin/sources/${enc(id)}`, {
      data: { remote_url: null, mode: 'direct', include_globs: ['docs/**/*.md', 'handbook/*.md'], exclude_globs: ['docs/archive/**'] },
    });
    if (!registered.ok()) throw new Error(`register source failed: ${registered.status()} ${await registered.text()}`);

    try {
      await signedInPage.goto('/admin/repos');
      const chip = rowFor(signedInPage, id).locator('[data-kind="selection"]');
      await expect(chip).toHaveText('Selective');
      await expect(chip).toHaveAttribute('title', /docs\/\*\*\/\*\.md, handbook\/\*\.md/);
      await expect(chip).toHaveAttribute('title', /Excludes: docs\/archive\/\*\*/);
    } finally {
      await apiAsAdmin.delete(`/api/v1/admin/sources/${enc(id)}`);
    }
  });

  test('Overview shows how many items the source indexed and the commit its working tree is on', async ({
    signedInPage,
    apiAsAdmin,
  }, testInfo) => {
    const id = sourceId('e2e-details', testInfo.workerIndex);
    const registered = await apiAsAdmin.put(`/api/v1/admin/sources/${enc(id)}`, {
      data: { remote_url: null, mode: 'direct', local_dir: `topics/${id.slice(6)}`, host_token_env: 'PATH' },
    });
    if (!registered.ok()) throw new Error(`register source failed: ${registered.status()} ${await registered.text()}`);

    // A HEAD needs a git clone on the server's disk, which a browser test cannot make.
    const sha = '0123456789abcdef0123456789abcdef01234567';

    // The real wire first: a source with no clone has a count and an honest null HEAD.
    const wire = await (await apiAsAdmin.get('/api/v1/admin/sources')).json();
    const real = (wire.sources as Record<string, unknown>[]).find((s) => s['id'] === id)!;
    expect(real['item_count']).toBe(0);
    expect(real['head']).toBeNull();

    const sourcesRoute = await graftSources(signedInPage, {
      [id]: { item_count: 42, head: { sha, committed_at: '2026-09-13T10:00:00.000Z' } },
    });

    try {
      await signedInPage.goto('/admin/repos');
      await rowFor(signedInPage, id).getByText(id, { exact: true }).click();

      const sheet = detailSheet(signedInPage, id);
      await expect(signedInPage).toHaveURL(/[?&]source=/);
      const overview = sheet.getByRole('region', { name: `Overview of ${id}` });
      await expect(overview.locator('[data-detail="item-count"]')).toHaveText('42 items');
      await expect(overview.locator('[data-detail="head"]')).toContainText('0123456');
      await expect(overview.locator('[data-detail="head"] [title]')).toHaveAttribute('title', sha);
      // The host/token presence row (B3) rides along, presence only.
      await expect(overview.locator('[data-secret="host-token"]')).toHaveText('PATH ✓');

      // No globs: the default layout, spelled out rather than left blank.
      await sheet.getByRole('tab', { name: 'Selection' }).click();
      await expect(sheet.locator('[data-detail="include"]')).toContainText(/concepts\/\*\.md at any depth/);
      await expect(sheet.locator('[data-detail="default-status"]')).toContainText('Server default');
    } finally {
      await signedInPage.unroute(sourcesRoute);
      await apiAsAdmin.delete(`/api/v1/admin/sources/${enc(id)}`);
    }
  });
});
