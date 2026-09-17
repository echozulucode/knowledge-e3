/**
 * Every System health check the server can return has a runbook pointer
 * (review §4.9), and that pointer is a real section.
 *
 * The ids are read out of the SERVER'S source rather than restated here: a copy
 * of the list in this test would pass forever while a new check shipped with no
 * "where to read next". Both the declared list (`SYSTEM_CHECK_IDS`) and the ids
 * `checks.ts` actually passes to `check(...)` are read, and must agree, so a
 * check added to one and not the other fails too.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CHECK_RUNBOOK, RUNBOOK, checkRunbook } from './runbook.js';

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const read = (path: string) => readFileSync(`${repoRoot}${path}`, 'utf8');

function declaredIds(): string[] {
  const types = read('server/src/system-health/system-health.types.ts');
  const list = /SYSTEM_CHECK_IDS\s*=\s*\[([\s\S]*?)\]/.exec(types)?.[1] ?? '';
  return [...list.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!);
}

function emittedIds(): string[] {
  const checks = read('server/src/system-health/checks.ts');
  return [...new Set([...checks.matchAll(/\bcheck\(\s*'([a-z_]+)'/g)].map((m) => m[1]!))];
}

describe('System health runbook pointers', () => {
  const declared = declaredIds();

  it('reads the server’s check ids (the parse itself is not silently empty)', () => {
    expect(declared.length).toBeGreaterThanOrEqual(10);
    expect(declared).toContain('restore_drill');
    expect([...emittedIds()].sort()).toEqual([...declared].sort());
  });

  it('has a runbook section for every check id the server can return', () => {
    const missing = declared.filter((id) => checkRunbook(id) === null);
    expect(missing).toEqual([]);
  });

  it('points only at sections the runbook map already verifies against the document', () => {
    // runbook.test.ts proves every RUNBOOK entry resolves to a heading; a
    // check pointer built from anything else would skip that proof.
    const verified = new Set<unknown>(Object.values(RUNBOOK));
    for (const [id, section] of Object.entries(CHECK_RUNBOOK)) {
      expect(verified.has(section), id).toBe(true);
    }
  });

  it('answers null for an id this client does not know, including prototype keys', () => {
    expect(checkRunbook('litestream')).toBeNull();
    expect(checkRunbook('toString')).toBeNull();
  });
});
