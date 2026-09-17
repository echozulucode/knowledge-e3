import { describe, it, expect } from 'vitest';
import {
  repairBrokenLinks,
  downgradeInvalidMermaid,
  extractRepairMarkers,
  stripRepairMarkers,
  isContentUnchanged,
  REPAIR_PREFIX,
} from '../src/repair.js';

describe('repairBrokenLinks', () => {
  it('marks a link whose target is not in the bundle, leaving valid links alone', () => {
    const body = 'See [Orders](/concepts/orders.md) and [Ghost](/concepts/ghost.md).';
    const { body: out, repairs } = repairBrokenLinks(body, ['concepts/orders.md']);
    expect(out).toContain('[Orders](/concepts/orders.md) and'); // untouched
    expect(out).toContain(`/concepts/ghost.md) <!-- ${REPAIR_PREFIX} broken link to /concepts/ghost.md -->`);
    expect(repairs).toEqual(['broken link to /concepts/ghost.md']);
  });

  it('is idempotent — does not double-mark', () => {
    const body = 'See [Ghost](/concepts/ghost.md).';
    const first = repairBrokenLinks(body, []);
    const second = repairBrokenLinks(first.body, []);
    expect(second.repairs).toHaveLength(0);
    expect(second.body).toBe(first.body);
  });
});

describe('downgradeInvalidMermaid', () => {
  it('downgrades an invalid diagram to a text fence with a marker', () => {
    const body = '```mermaid\nnot a real diagram\n```';
    const { body: out, repairs } = downgradeInvalidMermaid(body, () => false);
    expect(out).toContain('```text');
    expect(out).toContain(`<!-- ${REPAIR_PREFIX}`);
    expect(repairs).toHaveLength(1);
  });

  it('leaves a valid diagram untouched', () => {
    const body = '```mermaid\ngraph TD; A-->B;\n```';
    const { body: out, repairs } = downgradeInvalidMermaid(body, () => true);
    expect(out).toBe(body);
    expect(repairs).toHaveLength(0);
  });
});

describe('repair markers', () => {
  it('extracts and strips markers', () => {
    const body = 'text [x](/y.md) <!-- e3-repair: broken link to /y.md -->\nmore';
    expect(extractRepairMarkers(body)).toEqual(['broken link to /y.md']);
    expect(stripRepairMarkers(body)).toBe('text [x](/y.md)\nmore');
  });
});

describe('isContentUnchanged (no-op guard)', () => {
  it('ignores trailing whitespace and final-newline differences', () => {
    expect(isContentUnchanged('a\nb\n', 'a\nb')).toBe(true);
    expect(isContentUnchanged('a\nb  \n', 'a\nb')).toBe(true);
    expect(isContentUnchanged('a\nb', 'a\nc')).toBe(false);
    expect(isContentUnchanged(undefined, 'a')).toBe(false);
  });
});
