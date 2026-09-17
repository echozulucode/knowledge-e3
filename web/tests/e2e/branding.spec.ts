import type { Page } from '@playwright/test';
import { test, expect } from './fixtures.js';

/**
 * Tenant branding and curated front-page links (reader plan §4).
 *
 * Eric's requirement in full: "The company using should be able to set their own
 * logo and have custom news, updates and links to sections from the main page."
 * This spec covers the two halves the UI is responsible for — that a configured
 * logo, name, tagline and favicon actually reach the chrome, and that curated
 * links actually render as anchors you can click.
 *
 * Branding is read from `GET /api/v1/site`, and curated links from
 * `GET /api/v1/site/links`, both of which come from the operator's config file
 * and the topic's bundle `index.md` respectively. Those are set outside the app,
 * so this spec stubs the two responses rather than restarting the server with a
 * different config: what is under test here is that the web app renders what the
 * server tells it, and that an unconfigured instance still looks like itself.
 * The server half — parsing, validation, fallbacks and the `index.md` round
 * trip — is covered by server/tests/site-config.test.ts,
 * server/tests/site-http.e2e.test.ts and packages/okf/tests/bundle-index-links.test.ts.
 */

const ACME = {
  home_topic: null,
  name: 'Acme Engineering Knowledge',
  short_name: 'Acme',
  logo: '/logo/ke3-cube-light.png',
  logo_dark: '/logo/ke3-cube-dark.png',
  favicon: '/logo/ke3-cube-dark.png',
  tagline: 'What do you want to build today?',
  search_placeholder: 'Search runbooks, ADRs, guidance…',
};

const CURATED = [
  { label: 'Onboarding checklist', to: '/sections' },
  { label: 'Latest changes', to: '/latest', description: 'Everything published this month' },
  { label: 'Tool request form', href: 'https://intranet.example/tools/request' },
];

/** Answer `GET /site` with `site`, leaving the real server's value untouched. */
async function stubSite(page: Page, site: Record<string, unknown>): Promise<void> {
  await page.route('**/api/v1/site', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(site) });
  });
}

/** Answer `GET /site/links` (with or without a `?topic=`) with `links`. */
async function stubLinks(page: Page, links: unknown[]): Promise<void> {
  await page.route('**/api/v1/site/links*', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ links }) });
  });
}

test.describe('tenant branding', () => {
  test('a configured logo, name, search wording and favicon reach the chrome', async ({ signedInPage }) => {
    await stubSite(signedInPage, ACME);
    await signedInPage.goto('/');

    const sidebar = signedInPage.locator('.kp-sidebar');
    if ((await sidebar.getAttribute('class'))?.includes('collapsed')) {
      await sidebar.getByRole('button', { name: 'Expand sidebar' }).click();
    }

    // The logo is the configured asset, in both theme variants, and nothing on
    // the page still points at a hard-coded mark that isn't the tenant's.
    await expect(sidebar.locator('img[data-site-logo="light"]')).toHaveAttribute('src', ACME.logo);
    await expect(sidebar.locator('img[data-site-logo="dark"]')).toHaveAttribute('src', ACME.logo_dark);

    // The wordmark is the tenant's name — as plain text, without the product's
    // own `× 10³` superscript.
    const wordmark = sidebar.locator('[data-site-name]');
    await expect(wordmark).toHaveText(ACME.name);
    await expect(wordmark.locator('sup')).toHaveCount(0);

    // The browser tab carries the tenant's name and favicon.
    await expect(signedInPage).toHaveTitle(ACME.name);
    await expect(signedInPage.locator('link[rel~="icon"]').first()).toHaveAttribute('href', ACME.favicon);

    // And the tenant's own search wording, on the one quick search: the header
    // trigger (the rail's search box, which used to carry it, is gone).
    await expect(signedInPage.locator('.kp-header-search')).toContainText(ACME.search_placeholder);
    await expect(sidebar.getByRole('textbox')).toHaveCount(0);
  });

  test('with no site configuration at all, the product looks exactly as it always has', async ({ signedInPage }) => {
    await stubSite(signedInPage, {
      home_topic: null,
      name: null,
      short_name: null,
      logo: null,
      logo_dark: null,
      favicon: null,
      tagline: null,
      search_placeholder: null,
    });
    await signedInPage.goto('/');

    const sidebar = signedInPage.locator('.kp-sidebar');
    if ((await sidebar.getAttribute('class'))?.includes('collapsed')) {
      await sidebar.getByRole('button', { name: 'Expand sidebar' }).click();
    }
    await expect(sidebar.locator('img[data-site-logo="light"]')).toHaveAttribute('src', '/logo/ke3-cube-light.png');
    await expect(sidebar.locator('img[data-site-logo="dark"]')).toHaveAttribute('src', '/logo/ke3-cube-dark.png');
    // The product's own wordmark keeps its superscript.
    await expect(sidebar.locator('[data-site-name] sup')).toHaveText('3');
    await expect(signedInPage.locator('.kp-header-search')).toContainText('Search…');
  });
});

test.describe('curated front-page links', () => {
  test('the curator\'s links render on the front page and go where they say', async ({ signedInPage }) => {
    await stubSite(signedInPage, ACME);
    await stubLinks(signedInPage, CURATED);
    await signedInPage.goto('/');

    const quickLinks = signedInPage.getByRole('region', { name: 'Quick links' });
    await expect(quickLinks).toBeVisible();
    await expect(quickLinks.getByRole('link')).toHaveCount(3);

    // A described link shows its description as well as its label.
    await expect(quickLinks).toContainText('Everything published this month');

    // An external link opens in a new tab and leaks no referrer.
    const external = quickLinks.getByRole('link', { name: /Tool request form/ });
    await expect(external).toHaveAttribute('href', 'https://intranet.example/tools/request');
    await expect(external).toHaveAttribute('target', '_blank');
    await expect(external).toHaveAttribute('rel', /noreferrer/);

    // An in-app link is a real navigation: it lands on the route it names.
    await quickLinks.getByRole('link', { name: /Onboarding checklist/ }).click();
    await expect(signedInPage).toHaveURL(/\/sections$/);
  });

  test('a topic with no curated links shows no quick-links block at all', async ({ signedInPage }) => {
    await stubSite(signedInPage, ACME);
    await stubLinks(signedInPage, []);
    await signedInPage.goto('/');

    // Absence is the signal: no empty heading, no placeholder row.
    await expect(signedInPage.getByRole('region', { name: 'Quick links' })).toHaveCount(0);
  });

  test('a malformed link is dropped without taking the front page with it', async ({ signedInPage }) => {
    await stubSite(signedInPage, ACME);
    await stubLinks(signedInPage, [
      { label: 'Script', href: 'javascript:alert(1)' },
      { label: 'No destination' },
      { label: 'Sections', to: '/sections' },
    ]);
    await signedInPage.goto('/');

    const quickLinks = signedInPage.getByRole('region', { name: 'Quick links' });
    await expect(quickLinks.getByRole('link')).toHaveCount(1);
    await expect(quickLinks.getByRole('link')).toHaveAttribute('href', '/sections');
    // The rest of the front page is still there.
    await expect(signedInPage.locator('main.Home')).toBeVisible();
  });
});
