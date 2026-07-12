import { test, expect } from './fixtures.js';

test.describe('admin Topic management', () => {
  test('lists existing topics from Admin and creates a topic in a modal', async ({ signedInPage, apiAsAdmin }, testInfo) => {
    const suffix = `admin-topic-${testInfo.workerIndex}-${Date.now()}`;
    const seedName = `Product Discovery ${suffix}`;
    const seedSlug = `product-discovery-${suffix}`;
    const createdName = `Implementation Notes ${suffix}`;
    const createdSlug = `implementation-notes-${suffix}`;
    const seed = await apiAsAdmin.post('/api/v1/topics', {
      data: {
        name: seedName,
        slug: seedSlug,
        description: 'Discovery notes and opportunity research',
      },
    });
    if (!seed.ok()) throw new Error(`seed topic failed: ${seed.status()} ${await seed.text()}`);

    await signedInPage.goto('/');
    await expect(signedInPage.getByRole('button', { name: /^topics$/i })).toHaveCount(0);
    await expect(signedInPage.getByRole('button', { name: /primary categories/i })).toHaveCount(0);

    await signedInPage.getByRole('button', { name: /^admin$/i }).click();
    await expect(signedInPage).toHaveURL(/\/admin$/);
    await expect(signedInPage.getByRole('heading', { name: 'Admin', exact: true })).toBeVisible();

    await signedInPage.getByRole('link', { name: /topics/i }).click();

    await expect(signedInPage).toHaveURL(/\/admin\/topics$/);
    await expect(signedInPage.getByRole('heading', { name: 'Topics', exact: true })).toBeVisible();
    await expect(signedInPage.getByText(/manage the topic catalog separately from article editing/i)).toBeVisible();
    await expect(signedInPage.getByRole('table', { name: /topic catalog/i })).toBeVisible();
    await expect(signedInPage.getByRole('row', { name: new RegExp(seedName, 'i') })).toContainText(seedSlug);
    await expect(signedInPage.getByRole('row', { name: new RegExp(seedName, 'i') })).toContainText('Discovery notes and opportunity research');
    await expect(signedInPage.getByRole('row', { name: new RegExp(seedName, 'i') })).toContainText('0 items');

    const tableTop = await signedInPage.getByRole('table', { name: /topic catalog/i }).evaluate((node) => node.getBoundingClientRect().top);
    const createButtonTop = await signedInPage.getByRole('button', { name: /^new topic$/i }).evaluate((node) => node.getBoundingClientRect().top);
    expect(tableTop).toBeLessThan(createButtonTop);

    await signedInPage.getByRole('button', { name: /^new topic$/i }).click();
    await expect(signedInPage.getByRole('dialog', { name: /new topic/i })).toBeVisible();
    await signedInPage.getByLabel('Topic name').fill(createdName);
    await signedInPage.getByLabel('Topic slug').fill(createdSlug);
    await signedInPage.getByLabel('Description').fill('Technical build notes');
    await signedInPage.getByRole('button', { name: /^create topic$/i }).click();

    await expect(signedInPage.getByText(createdSlug)).toBeVisible();
    await expect(signedInPage.getByText('Technical build notes').last()).toBeVisible();
    await expect(signedInPage.getByText(/topic created/i)).toBeVisible();
  });

  test('keeps risky topic operations and article topic reassignment out of the editor', async ({ signedInPage, apiAsAdmin }, testInfo) => {
    const suffix = `editor-boundary-${testInfo.workerIndex}-${Date.now()}`;
    const topicName = `Editor Boundary ${suffix}`;
    const renamedTopicName = `Editor Boundary Renamed ${suffix}`;
    const topicSlug = `editor-boundary-${suffix}`;
    const title = `Topic Admin Boundary Article ${suffix}`;
    const seed = await apiAsAdmin.post('/api/v1/topics', {
      data: { name: topicName, slug: topicSlug },
    });
    if (!seed.ok()) throw new Error(`seed topic failed: ${seed.status()} ${await seed.text()}`);

    const pageRes = await apiAsAdmin.post('/api/v1/pages', {
      data: {
        title,
        body: 'Article editor should not reassign topics.',
        status: 'draft',
        frontmatter: { topic: topicName },
      },
    });
    if (!pageRes.ok()) throw new Error(`seed page failed: ${pageRes.status()} ${await pageRes.text()}`);
    const body = await pageRes.json();

    await signedInPage.goto('/admin/topics');

    await signedInPage.getByRole('row', { name: new RegExp(topicName, 'i') }).getByRole('button', { name: /rename topic/i }).click();
    const renameDialog = signedInPage.getByRole('dialog', { name: /rename topic/i });
    await renameDialog.getByLabel(/topic name/i).fill(renamedTopicName);
    await renameDialog.getByRole('button', { name: /^save topic$/i }).click();
    await expect(signedInPage.getByRole('row', { name: new RegExp(renamedTopicName, 'i') })).toBeVisible();

    await expect(signedInPage.getByRole('button', { name: new RegExp(`archive topic ${renamedTopicName}`, 'i') })).toBeDisabled();
    await expect(signedInPage.getByText(/topics with assigned items cannot be archived/i)).toBeVisible();

    await signedInPage.goto(`/?q=${encodeURIComponent(renamedTopicName)}`);
    await expect(signedInPage.locator('.PageList__CardTitle').filter({ hasText: title })).toBeVisible();
    await expect(signedInPage.getByText(new RegExp(`Topic: ${renamedTopicName}`, 'i'))).toBeVisible();

    await signedInPage.goto(`/p/${body.page.slug}?edit=1`);

    const editorMain = signedInPage.locator('main');
    await expect(editorMain.getByRole('combobox', { name: /topic/i })).toHaveCount(0);
    await expect(editorMain.getByRole('textbox', { name: /topic/i })).toHaveCount(0);
    await expect(editorMain.getByRole('button', { name: /topic/i })).toHaveCount(0);
  });
});
