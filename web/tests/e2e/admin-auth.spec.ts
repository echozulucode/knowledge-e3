import { test, expect, ADMIN } from './fixtures.js';
import type { APIRequestContext, Page } from '@playwright/test';

async function readMode(api: APIRequestContext): Promise<'public' | 'authenticated'> {
  const res = await api.get('/api/v1/access');
  if (!res.ok()) throw new Error(`read access failed: ${res.status()} ${await res.text()}`);
  return ((await res.json()) as { read_mode: 'public' | 'authenticated' }).read_mode;
}

async function setMode(api: APIRequestContext, read_mode: 'public' | 'authenticated'): Promise<void> {
  const res = await api.put('/api/v1/admin/access', { data: { read_mode } });
  if (!res.ok()) throw new Error(`set access failed: ${res.status()} ${await res.text()}`);
}

type Policy = { min_length: number; require_number: boolean; require_symbol: boolean; require_uppercase: boolean };

async function readPolicy(api: APIRequestContext): Promise<Policy> {
  const res = await api.get('/api/v1/admin/auth/password-policy');
  if (!res.ok()) throw new Error(`read policy failed: ${res.status()} ${await res.text()}`);
  return ((await res.json()) as { policy: Policy }).policy;
}

async function setPolicy(api: APIRequestContext, policy: Policy): Promise<void> {
  const res = await api.put('/api/v1/admin/auth/password-policy', { data: policy });
  if (!res.ok()) throw new Error(`set policy failed: ${res.status()} ${await res.text()}`);
}

/** One settings section, found by its heading (each is a region named by its h2). */
function section(page: Page, name: string) {
  return page.getByRole('region', { name });
}

const PROVENANCE = /^(Default|Set in admin( by \S+)?( · [A-Z][a-z]{2} \d{1,2}, \d{4})?|From environment( \(.+\))?|From knowledge-e3\.config)$/;

/**
 * Admin → Authentication settings (features/01-authentication.feature;
 * the admin UX review §4.7).
 *
 * Plan D8: this page used to describe OIDC, SAML and LDAP as configurable, and
 * the AdminHome card promised the same. None of the three exists anywhere in
 * the codebase. The test is deliberately worded as an absence — an admin must
 * not be told something false about their own deployment — plus the positive
 * statement that replaced it, so the panel cannot be emptied instead of fixed.
 *
 * The settings rules under test: every editable section has one save model
 * (its own Discard / Save, enabled only while it differs from what is saved),
 * every section says where its value came from, and making content Public
 * still needs "public" typed.
 */
test.describe('Admin → Authentication', () => {
  test('describes the sign-in methods this instance actually has, and promises none it does not', async ({
    signedInPage,
  }) => {
    await signedInPage.goto('/admin/auth');
    await expect(signedInPage.getByRole('heading', { name: 'Authentication', level: 1 })).toBeVisible();

    const panel = signedInPage.getByRole('region', { name: 'Sign-in methods' });
    await expect(panel).toContainText('Username and password');
    await expect(panel).toContainText('Personal access tokens');
    await expect(panel).toContainText(/no OIDC, SAML, or LDAP support/i);

    // Nowhere on the page, in either direction: no promise, and no roadmap
    // promise put in its place.
    const text = await signedInPage.locator('main').innerText();
    expect(text).not.toMatch(/single sign-on|entra|okta|just-in-time|active directory/i);
    expect(text).not.toMatch(/later wave|coming soon|roadmap/i);
  });

  test('the Authentication entry on the admin Overview says what the page does', async ({ signedInPage }) => {
    await signedInPage.goto('/admin');
    // The Overview's shortcut list (not the nav, which carries labels only).
    const card = signedInPage
      .getByRole('main')
      .getByRole('listitem')
      .filter({ has: signedInPage.getByRole('link', { name: 'Authentication', exact: true }) })
      .first();
    await expect(card).toContainText(/password policy/i);
    await expect(card).not.toContainText(/SSO|OIDC|SAML|LDAP/i);
  });

  test('every setting says where its value came from, and the token list is no longer on this page', async ({ signedInPage }) => {
    await signedInPage.goto('/admin/auth');
    for (const name of ['Content visibility', 'Password policy', 'API token lifetime', 'Sign-in throttling']) {
      const provenance = section(signedInPage, name).locator('.AdminAuth__provenance');
      await expect(provenance, name).toBeVisible({ timeout: 15_000 });
      await expect(provenance, name).toHaveText(PROVENANCE);
    }

    // Throttling is deploy-time only: read-only, with where to change it instead.
    const throttle = section(signedInPage, 'Sign-in throttling');
    await expect(throttle).toContainText(/cannot be changed here/i);
    await expect(throttle.getByRole('button', { name: /save|discard/i })).toHaveCount(0);

    // The tokens moved to their own page; this one links there.
    await expect(signedInPage.getByRole('main').getByRole('table')).toHaveCount(0);
    await expect(signedInPage.getByRole('main')).not.toContainText('e3_');
    await signedInPage.getByRole('link', { name: 'API tokens →' }).click();
    await expect(signedInPage).toHaveURL(/\/admin\/auth\/tokens$/);
    await expect(signedInPage.getByRole('heading', { level: 1, name: 'API tokens' })).toBeVisible();
  });

  test('making content Public requires typing "public"; Cancel and Discard change nothing', async ({
    signedInPage,
    apiAsAdmin,
  }) => {
    const original = await readMode(apiAsAdmin);
    await setMode(apiAsAdmin, 'authenticated');
    try {
      await signedInPage.goto('/admin/auth');
      const visibility = section(signedInPage, 'Content visibility');
      const group = visibility.getByRole('radiogroup', { name: 'Who can read content' });
      const publicRadio = group.getByRole('radio', { name: /Public/ });
      const loginRadio = group.getByRole('radio', { name: /Login required/ });
      await expect(loginRadio).toBeChecked();
      await expect(visibility.getByRole('button', { name: 'Save' })).toBeDisabled();
      await expect(visibility.getByRole('button', { name: 'Discard' })).toBeDisabled();
      // An admin has set it (the API call above), so it says who.
      await expect(visibility.locator('.AdminAuth__provenance')).toHaveText(new RegExp(`^Set in admin by ${ADMIN.username}`));

      // Choosing is a draft, not a change: Discard puts it back.
      await publicRadio.check();
      await expect(visibility.getByRole('button', { name: 'Change to Public…' })).toBeEnabled();
      await visibility.getByRole('button', { name: 'Discard' }).click();
      await expect(loginRadio).toBeChecked();
      await expect(visibility.getByRole('button', { name: 'Save' })).toBeDisabled();

      await publicRadio.check();
      await visibility.getByRole('button', { name: 'Change to Public…' }).click();
      const dialog = signedInPage.getByRole('dialog', { name: 'Make content public?' });
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText(/anyone on the internet can read every published item/i);
      await expect(dialog).toContainText(/drafts and private topics stay hidden/i);
      await expect(dialog).toContainText(/editing still require/i);

      await dialog.getByRole('button', { name: 'Cancel' }).click();
      await expect(dialog).toBeHidden();
      expect(await readMode(apiAsAdmin)).toBe('authenticated');

      await visibility.getByRole('button', { name: 'Change to Public…' }).click();
      const confirm = signedInPage.getByRole('dialog', { name: 'Make content public?' });
      const makePublic = confirm.getByRole('button', { name: 'Make public' });
      await expect(makePublic).toBeDisabled();
      await confirm.getByLabel(/type public to confirm/i).fill('publi');
      await expect(makePublic).toBeDisabled();
      await confirm.getByLabel(/type public to confirm/i).fill('public');
      await expect(makePublic).toBeEnabled();
      await makePublic.click();
      await expect(confirm).toBeHidden();
      await expect(publicRadio).toBeChecked();
      await expect(visibility.getByRole('button', { name: 'Save' })).toBeDisabled();
      expect(await readMode(apiAsAdmin)).toBe('public');

      // Back to login required: a plain confirm, nothing to type.
      await loginRadio.check();
      await visibility.getByRole('button', { name: 'Change to Login required…' }).click();
      const back = signedInPage.getByRole('dialog', { name: 'Require login to read?' });
      await expect(back).toBeVisible();
      await expect(back.getByRole('textbox')).toHaveCount(0);
      await back.getByRole('button', { name: 'Require login' }).click();
      await expect(back).toBeHidden();
      await expect(loginRadio).toBeChecked();
      expect(await readMode(apiAsAdmin)).toBe('authenticated');
    } finally {
      await setMode(apiAsAdmin, original);
    }
  });

  test('password policy: no snap-to-1 while typing, errors on blur and Save, Discard and Save per section', async ({
    signedInPage,
    apiAsAdmin,
  }) => {
    const original = await readPolicy(apiAsAdmin);
    const start = { ...original, min_length: 10 };
    await setPolicy(apiAsAdmin, start);
    try {
      await signedInPage.goto('/admin/auth');
      const policy = section(signedInPage, 'Password policy');
      const minLength = policy.getByLabel(/Minimum length/);
      const save = policy.getByRole('button', { name: 'Save' });
      const discard = policy.getByRole('button', { name: 'Discard' });
      await expect(minLength).toHaveValue('10');
      await expect(save).toBeDisabled();

      // Clearing the box leaves it empty (it used to become "1").
      await minLength.fill('');
      await expect(minLength).toHaveValue('');
      await expect(policy.getByText(/Enter a whole number/)).toHaveCount(0);
      await minLength.blur();
      await expect(policy.getByText('Enter a whole number from 1 to 128.')).toBeVisible();
      await expect(minLength).toHaveAttribute('aria-invalid', 'true');

      // Save with an invalid value sends nothing.
      await save.click();
      await expect(policy.getByText('Enter a whole number from 1 to 128.')).toBeVisible();
      expect((await readPolicy(apiAsAdmin)).min_length).toBe(10);

      // A valid value clears the error as it is typed.
      await minLength.fill('14');
      await expect(policy.getByText(/Enter a whole number/)).toHaveCount(0);
      await policy.getByLabel('Require a symbol').setChecked(!start.require_symbol);

      // Discard restores the saved values.
      await discard.click();
      await expect(minLength).toHaveValue('10');
      await expect(policy.getByLabel('Require a symbol')).toBeChecked({ checked: start.require_symbol });
      await expect(save).toBeDisabled();

      await minLength.fill('14');
      await save.click();
      await expect(signedInPage.getByText('Password policy saved.')).toBeVisible();
      await expect(save).toBeDisabled();
      await expect(minLength).toHaveValue('14');
      expect((await readPolicy(apiAsAdmin)).min_length).toBe(14);
      await expect(policy.locator('.AdminAuth__provenance')).toHaveText(new RegExp(`^Set in admin by ${ADMIN.username} · `));
    } finally {
      await setPolicy(apiAsAdmin, original);
    }
  });

  test('leaving with an unsaved section asks first', async ({ signedInPage, apiAsAdmin }) => {
    const original = await readPolicy(apiAsAdmin);
    try {
      await signedInPage.goto('/admin/auth');
      const policy = section(signedInPage, 'Password policy');
      await policy.getByLabel(/Minimum length/).fill(String(original.min_length === 20 ? 21 : 20));

      let asked = '';
      signedInPage.once('dialog', (dialog) => {
        asked = dialog.message();
        void dialog.dismiss();
      });
      await signedInPage.getByRole('navigation', { name: 'Admin' }).getByRole('link', { name: 'Users', exact: true }).click();
      await expect.poll(() => asked).toBe('Discard unsaved changes?');
      await expect(signedInPage).toHaveURL(/\/admin\/auth$/);
      expect((await readPolicy(apiAsAdmin)).min_length).toBe(original.min_length);
    } finally {
      await setPolicy(apiAsAdmin, original);
    }
  });

  test('Profile lists my tokens without any part of the secret, and Revoke asks first', async ({ signedInPage, apiAsAdmin }) => {
    const tokenName = `e2e profile ${Date.now()}`;
    const minted = await apiAsAdmin.post('/api/v1/me/tokens', {
      data: { name: tokenName, scope: 'read', expires_in_days: 30 },
    });
    if (!minted.ok()) throw new Error(`mint failed: ${minted.status()} ${await minted.text()}`);
    const { id, token } = (await minted.json()) as { id: string; token: string };
    try {
      await signedInPage.goto('/profile');
      const table = signedInPage.locator('.Profile__tokenTable');
      const row = table.getByRole('row', { name: new RegExp(tokenName) });
      await expect(row).toBeVisible();
      await expect(table.getByRole('columnheader', { name: 'Token', exact: true })).toHaveCount(0);
      await expect(table).not.toContainText('e3_');
      await expect(signedInPage.locator('main')).not.toContainText(token.slice(0, 8));
      await expect(row).toContainText('Active');

      // A dialog, not window.confirm: Cancel leaves the token working.
      await row.getByRole('button', { name: 'Revoke' }).click();
      const dialog = signedInPage.getByRole('dialog', { name: `Revoke “${tokenName}”?` });
      await expect(dialog).toContainText(/stops working immediately/i);
      await dialog.getByRole('button', { name: 'Cancel' }).click();
      await expect(dialog).toBeHidden();
      await expect(row).toContainText('Active');

      await row.getByRole('button', { name: 'Revoke' }).click();
      await signedInPage.getByRole('dialog', { name: `Revoke “${tokenName}”?` }).getByRole('button', { name: 'Revoke token' }).click();
      await expect(row).toContainText('Revoked');
    } finally {
      await apiAsAdmin.delete(`/api/v1/me/tokens/${id}`);
    }
  });
});
