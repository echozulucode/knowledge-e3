import { describe, expect, it } from 'vitest';
import {
  ADMIN_NAV,
  adminPageLabel,
  countMissingSecrets,
  countOpenConflicts,
  healthNeedsAttention,
  resolveActiveAdminNav,
} from './AdminNav.model.js';

/** `item` or `item/child` for a path, or null. */
function resolved(pathname: string): string | null {
  const active = resolveActiveAdminNav(pathname);
  if (!active) return null;
  return active.child ? `${active.item.id}/${active.child.id}` : active.item.id;
}

describe('resolveActiveAdminNav', () => {
  it('lights Overview only on /admin itself', () => {
    expect(resolved('/admin')).toBe('overview');
    expect(resolved('/admin/')).toBe('overview');
    // An unknown admin path is not "Overview" just because /admin prefixes it.
    expect(resolved('/admin/nope')).toBeNull();
  });

  it('resolves plain items, including their deeper paths', () => {
    expect(resolved('/admin/users')).toBe('users');
    expect(resolved('/admin/audit')).toBe('audit');
    expect(resolved('/admin/images')).toBe('files');
    expect(resolved('/admin/data')).toBe('data');
    expect(resolved('/admin/repos')).toBe('sources');
  });

  it('keeps Content and System apart although /admin/health prefixes /admin/health/system', () => {
    expect(resolved('/admin/health')).toBe('health/health-content');
    expect(resolved('/admin/health/system')).toBe('health/health-system');
    expect(resolved('/admin/health/system/')).toBe('health/health-system');
  });

  it('gives /admin/sections/pinned to Pinned topics and every other section path to Sections', () => {
    expect(resolved('/admin/sections')).toBe('sections/sections-list');
    expect(resolved('/admin/sections/pinned')).toBe('sections/pinned');
    expect(resolved('/admin/sections/new')).toBe('sections/sections-list');
    expect(resolved('/admin/sections/getting-started')).toBe('sections/sections-list');
    // A slug that merely starts with "pinned" is a section, not the pinned page.
    expect(resolved('/admin/sections/pinned-notes')).toBe('sections/sections-list');
  });

  it('puts the settings and API tokens under Authentication, lighting API tokens on its own page', () => {
    expect(resolved('/admin/auth')).toBe('auth/auth-settings');
    expect(resolved('/admin/auth/')).toBe('auth/auth-settings');
    expect(resolved('/admin/auth/tokens')).toBe('auth/tokens');
    expect(resolved('/admin/authx')).toBeNull();
  });

  it('matches on whole segments only', () => {
    expect(resolved('/admin/healthy')).toBeNull();
    expect(resolved('/admin/users-archive')).toBeNull();
  });

  it('puts the three Taxonomy pages under Taxonomy', () => {
    expect(resolved('/admin/topics')).toBe('taxonomy/topics');
    expect(resolved('/admin/primary-categories')).toBe('taxonomy/categories');
    expect(resolved('/admin/tags-groups')).toBe('taxonomy/tags-groups');
  });

  it('returns nothing outside the console', () => {
    expect(resolved('/')).toBeNull();
    expect(resolved('/sections/getting-started')).toBeNull();
    expect(resolved('/administrator')).toBeNull();
  });
});

describe('ADMIN_NAV', () => {
  it('keeps every destination the tabs had, once', () => {
    const targets = ADMIN_NAV.flatMap((g) => g.items.flatMap((i) => (i.children ? i.children.map((c) => c.to) : [i.to])));
    expect(new Set(targets).size).toBe(targets.length);
    for (const path of [
      '/admin',
      '/admin/users',
      '/admin/auth',
      '/admin/auth/tokens',
      '/admin/audit',
      '/admin/topics',
      '/admin/primary-categories',
      '/admin/tags-groups',
      '/admin/sections',
      '/admin/sections/pinned',
      '/admin/images',
      '/admin/data',
      '/admin/repos',
      '/admin/health',
      '/admin/health/system',
    ]) {
      expect(targets).toContain(path);
    }
  });

  it('links each parent to one of its own children', () => {
    for (const item of ADMIN_NAV.flatMap((g) => g.items)) {
      if (item.children) expect(item.children.map((c) => c.to)).toContain(item.to);
    }
  });
});

describe('adminPageLabel', () => {
  it('names the page, disambiguating short child labels', () => {
    expect(adminPageLabel(resolveActiveAdminNav('/admin'))).toBe('Overview');
    expect(adminPageLabel(resolveActiveAdminNav('/admin/users'))).toBe('Users');
    expect(adminPageLabel(resolveActiveAdminNav('/admin/health/system'))).toBe('System health');
    expect(adminPageLabel(resolveActiveAdminNav('/admin/health'))).toBe('Content health');
    expect(adminPageLabel(resolveActiveAdminNav('/admin/primary-categories'))).toBe('Primary categories');
    expect(adminPageLabel(resolveActiveAdminNav('/admin/sections/pinned'))).toBe('Pinned topics');
    expect(adminPageLabel(resolveActiveAdminNav('/admin/auth'))).toBe('Authentication');
    expect(adminPageLabel(resolveActiveAdminNav('/admin/auth/tokens'))).toBe('API tokens');
    expect(adminPageLabel(null)).toBe('Overview');
  });
});

describe('badges', () => {
  const status = (state: string, conflicted_paths: string[] = []) => ({
    status: { source: 's', state, ahead: 0, behind: 0, dirty_paths: [], conflicted_paths, last_synced_at: null, last_error: null } as never,
  });

  it('counts open conflicted paths across sources, and a conflict with no listed paths as one', () => {
    expect(countOpenConflicts(undefined)).toBe(0);
    expect(countOpenConflicts([status('idle'), status('idle')])).toBe(0);
    expect(countOpenConflicts([status('conflict', ['a.md', 'b.md']), status('conflict'), status('idle')])).toBe(3);
  });

  it('counts sources missing a named secret, treating an absent flag as unknown', () => {
    expect(
      countMissingSecrets([
        { host_token_env: 'GH_TOKEN', host_token_present: false, webhook_secret_env: null, webhook_secret_present: undefined },
        { host_token_env: 'GH_TOKEN', host_token_present: true, webhook_secret_env: 'HOOK', webhook_secret_present: false },
        { host_token_env: 'GH_TOKEN', host_token_present: undefined, webhook_secret_env: null, webhook_secret_present: undefined },
        { host_token_env: null, host_token_present: false, webhook_secret_env: null, webhook_secret_present: false },
      ]),
    ).toBe(2);
  });

  it('flags Health for any verdict but healthy, and not while unknown', () => {
    expect(healthNeedsAttention(undefined)).toBe(false);
    expect(healthNeedsAttention('healthy')).toBe(false);
    expect(healthNeedsAttention('degraded')).toBe(true);
    expect(healthNeedsAttention('at_risk')).toBe(true);
  });
});
