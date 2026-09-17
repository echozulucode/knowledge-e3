/**
 * The "Recent refusals" panel (plan B2) reads `content.refused` audit rows. The
 * payload is stored JSON written by whichever server version refused the
 * publish, so reading it must never throw and must never invent an item.
 */
import { describe, expect, it } from 'vitest';
import type { AuditRecord } from '../audit/queries.js';
import { refusalAttempt, rulesText, toRefusalRow } from './refusals.js';

function entry(overrides: Partial<AuditRecord> = {}): AuditRecord {
  return {
    id: 7,
    occurred_at: '2026-09-13T10:00:00.000Z',
    actor_id: 'u_alice',
    actor_username: 'alice',
    action: 'content.refused',
    page_id: null,
    page_slug: null,
    page_title: null,
    version_id: null,
    payload: {
      reason: 'lint_failed',
      source: 'mcp',
      operation: 'create',
      title: 'Agent Note',
      slug: null,
      topic: 'Ops',
      rules: [
        { code: 'description.missing', path: 'description' },
        { code: 'category.unknown', path: 'categories' },
      ],
    },
    ...overrides,
  };
}

describe('toRefusalRow', () => {
  it('reads a refused create: named by its title, not linkable, door in plain words', () => {
    expect(toRefusalRow(entry())).toEqual({
      id: 7,
      occurredAt: '2026-09-13T10:00:00.000Z',
      actor: 'alice',
      source: 'mcp',
      sourceLabel: 'MCP agent',
      operation: 'create',
      reason: 'lint_failed',
      slug: null,
      title: 'Agent Note',
      topic: 'Ops',
      rules: [
        { code: 'description.missing', path: 'description' },
        { code: 'category.unknown', path: 'categories' },
      ],
    });
  });

  it('prefers the live item over the payload for a refused publish, so a rename still links', () => {
    const row = toRefusalRow(
      entry({
        page_id: 'p1',
        page_slug: 'renamed-note',
        page_title: 'Renamed Note',
        payload: { reason: 'lint_failed', source: 'ui', operation: 'publish', title: 'Old Title', slug: 'old-title', rules: [] },
      }),
    );
    expect(row).toMatchObject({ slug: 'renamed-note', title: 'Renamed Note', sourceLabel: 'Compose', operation: 'publish' });
  });

  it('survives a payload it does not recognise, and keeps an unknown door visible', () => {
    const row = toRefusalRow(entry({ actor_username: null, actor_id: null, payload: 'not json', page_id: 'p9' }));
    expect(row).toMatchObject({ actor: 'system', source: 'unknown', sourceLabel: 'unknown', title: 'p9', rules: [], operation: null });

    const odd = toRefusalRow(entry({ payload: { source: 'carrier-pigeon', rules: [{ path: 'x' }, 'nope', { code: 'type.missing' }] } }));
    expect(odd.sourceLabel).toBe('carrier-pigeon');
    expect(odd.rules).toEqual([{ code: 'type.missing', path: null }]);
  });
});

describe('rulesText', () => {
  it('names the rule and only adds the field when the rule id does not already say it', () => {
    expect(
      rulesText([
        { code: 'description.missing', path: 'description' },
        { code: 'category.missing', path: 'e3_categories' },
        { code: 'blog.author.missing', path: 'authors' },
        { code: 'frontmatter.invalid', path: null },
      ]),
    ).toBe('description.missing, category.missing (e3_categories), blog.author.missing (authors), frontmatter.invalid');
  });

  it('shows a dash rather than an empty cell', () => {
    expect(rulesText([])).toBe('—');
  });
});

describe('refusalAttempt', () => {
  it('says what was attempted, and when the refusal was the override itself', () => {
    expect(refusalAttempt(toRefusalRow(entry()))).toBe('Create as published');
    expect(
      refusalAttempt(toRefusalRow(entry({ payload: { operation: 'publish', reason: 'lint_override_forbidden' } }))),
    ).toBe('Publish, override refused (admin only)');
  });
});
