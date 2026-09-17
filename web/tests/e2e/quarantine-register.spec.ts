import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';
import { type QuarantineCategory } from './quarantine.js';

/**
 * The convention's teeth (issue 92).
 *
 * Every exclusion from the CI gate has to carry an owner, a diagnosis, a reason
 * and an expiry, and has to appear in `docs/e2e-quarantine.md`. Nothing else
 * enforces that — a `@quarantine` in a title is one keystroke and disappears
 * from view immediately — so this spec is what keeps the register honest, and
 * it is deliberately NOT quarantinable: if it fails, the gate fails.
 *
 * It reads the spec sources rather than the running suite because the thing
 * under test is the SOURCE convention: a test that is quarantined the old way
 * (`'title @quarantine'`) is invisible to the runner's annotation API but is
 * exactly what this must catch.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');
const REGISTER = join(REPO_ROOT, 'docs', 'e2e-quarantine.md');

const CATEGORIES: QuarantineCategory[] = ['app-bug', 'test-rot', 'unknown'];
const SELF = 'quarantine-register.spec.ts';

interface QuarantineRecord {
  file: string;
  title: string;
  owner: string;
  category: string;
  reason: string;
  expires: string;
}

/**
 * `test('title', quarantine({ ... }), ...)` — the only sanctioned form. A whole
 * `test.describe` may be quarantined the same way when every test in it is out
 * for one reason.
 */
const QUARANTINED = /(?:test\.describe|test)\(\s*(['"`])((?:\\.|(?!\1).)*)\1\s*,\s*quarantine\(\{([^}]*)\}\)/g;

/** A hand-written tag in a title: the form this convention replaced. */
const TAG_IN_TITLE = /(['"`])[^'"`\n]*@quarantine[^'"`\n]*\1/;

function field(body: string, key: string): string {
  const match = new RegExp(`${key}\\s*:\\s*(['"\`])((?:\\\\.|(?!\\1).)*)\\1`).exec(body);
  return match?.[2] ?? '';
}

function specFiles(): string[] {
  return readdirSync(HERE)
    .filter((name) => name.endsWith('.spec.ts'))
    .sort();
}

function records(): QuarantineRecord[] {
  const out: QuarantineRecord[] = [];
  for (const file of specFiles()) {
    // This file quotes the sanctioned form in its own comments; scanning itself
    // would report those examples as incomplete quarantines.
    if (file === SELF) continue;
    const source = readFileSync(join(HERE, file), 'utf8');
    for (const match of source.matchAll(QUARANTINED)) {
      const body = match[3] ?? '';
      out.push({
        file,
        title: match[2] ?? '',
        owner: field(body, 'owner'),
        category: field(body, 'category'),
        reason: field(body, 'reason'),
        expires: field(body, 'expires'),
      });
    }
  }
  return out;
}

test.describe('the quarantine register', () => {
  // NB: this title must not contain the literal tag, or `--grep-invert` would
  // exclude the guard from the very gate it protects. (It did, once.)
  test('no test carries a hand-written tag in its title instead of the helper', () => {
    const offenders: string[] = [];
    for (const file of specFiles()) {
      if (file === SELF) continue;
      const lines = readFileSync(join(HERE, file), 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (TAG_IN_TITLE.test(line)) offenders.push(`${file}:${i + 1}`);
      });
    }
    expect(
      offenders,
      'Quarantine through quarantine() from ./quarantine.js, which requires an owner, a category, a reason and an expiry.',
    ).toEqual([]);
  });

  test('every quarantined test names an owner, a diagnosis, a reason and an expiry', () => {
    const incomplete = records()
      .filter((r) => !r.owner || !r.reason || !CATEGORIES.includes(r.category as QuarantineCategory) || !/^\d{4}-\d{2}-\d{2}$/.test(r.expires))
      .map((r) => `${r.file} › ${r.title}`);
    expect(incomplete, 'owner, category (app-bug | test-rot | unknown), reason and expires (YYYY-MM-DD) are all required.').toEqual([]);
  });

  test('no quarantine has outlived its expiry', () => {
    const today = new Date().toISOString().slice(0, 10);
    const expired = records()
      .filter((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.expires) && r.expires < today)
      .map((r) => `${r.file} › ${r.title} (expired ${r.expires}, owner ${r.owner})`);
    expect(
      expired,
      'An expired quarantine is a debt nobody paid. Fix the test, fix the product, or set a new date with a reason.',
    ).toEqual([]);
  });

  /**
   * A file-level `test.skip(true, ...)` removes a whole suite from every run,
   * local included, and shows up as "skipped" rather than as a debt. That is how
   * 08-frontmatter-strip.spec.ts sat for months behind a reason that had stopped
   * being true. Skips of that shape have to be registered like quarantines.
   * Conditional skips (`test.skip(!process.env.X, ...)`) are opt-in gates, not
   * exclusions, and are left alone.
   */
  test('docs/e2e-quarantine.md lists every wholesale-skipped spec file', () => {
    const register = readFileSync(REGISTER, 'utf8');
    const missing = specFiles()
      .filter((file) => /test\.skip\(\s*true\s*,/.test(readFileSync(join(HERE, file), 'utf8')))
      .filter((file) => !register.includes(file));
    expect(missing, `A file-level test.skip(true, ...) needs a row in ${REGISTER}, with an owner and an expiry.`).toEqual([]);
  });

  test('docs/e2e-quarantine.md lists every quarantined test', () => {
    const register = readFileSync(REGISTER, 'utf8');
    const missing = records()
      .filter((r) => !register.includes(r.title))
      .map((r) => `${r.file} › ${r.title}`);
    expect(missing, `Add these to ${REGISTER} — the register is the human-readable half of the convention.`).toEqual([]);
  });
});
