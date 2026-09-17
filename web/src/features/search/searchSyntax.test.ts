/**
 * The search tips and `/help` say exactly what the parser accepts.
 *
 * This reads the real `packages/search/src/query-parser.ts` (the web does not
 * depend on that package), so adding or removing a key there fails here until
 * `searchSyntax.ts` says the same — the drift that left `/help` with no search
 * section and the tips a key short is the failure this exists to stop.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SEARCH_TIPS, SUPPORTED_FILTER_HELP, UPDATED_FORMS_TIP } from './searchSyntax.js';

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const parserSource = readFileSync(`${repoRoot}packages/search/src/query-parser.ts`, 'utf8');

/** The `key:` of every entry in the parser's `SUPPORTED_SEARCH_FILTERS` array. */
function parserKeys(): string[] {
  const start = parserSource.indexOf('SUPPORTED_SEARCH_FILTERS');
  const open = parserSource.indexOf('[', parserSource.indexOf('=', start));
  const close = parserSource.indexOf('\n];', open);
  const block = parserSource.slice(open, close);
  return [...block.matchAll(/\bkey:\s*'([a-z]+)'/g)].map((match) => match[1]!);
}

describe('search syntax help', () => {
  it('found the parser table (guards the reader above against a silent zero)', () => {
    expect(parserKeys().length).toBeGreaterThan(0);
  });

  it('documents every key the parser accepts, and no key it does not', () => {
    expect(SUPPORTED_FILTER_HELP.map((filter) => filter.key).sort()).toEqual(parserKeys().sort());
  });

  it('gives every key an example that starts with that key', () => {
    for (const filter of SUPPORTED_FILTER_HELP) {
      expect(filter.example.startsWith(`${filter.key}:`)).toBe(true);
      expect(filter.description.trim()).not.toBe('');
    }
  });

  it('explains the forms updated: takes', () => {
    expect(SEARCH_TIPS).toContain(UPDATED_FORMS_TIP);
    expect(UPDATED_FORMS_TIP).toMatch(/updated:2026\b/);
    expect(UPDATED_FORMS_TIP).toMatch(/updated:<=?\d{4}/);
    expect(UPDATED_FORMS_TIP).toMatch(/updated:30d/);
  });
});
