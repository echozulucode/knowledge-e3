import { describe, it, expect } from 'vitest';
import { computeLineDiff, type DiffSegment } from './lineDiff.js';

describe('lineDiff', () => {
  it('identical inputs produce all context segments', () => {
    const text = 'line1\nline2\nline3';
    const diff = computeLineDiff(text, text);

    expect(diff).toHaveLength(3);
    expect(diff.every((s) => s.kind === 'context')).toBe(true);
    expect(diff[0]).toEqual({
      kind: 'context',
      left: 'line1',
      right: 'line1',
      leftLine: 1,
      rightLine: 1,
    });
  });

  it('total replace produces all delete then all insert', () => {
    const left = 'old1\nold2';
    const right = 'new1\nnew2';
    const diff = computeLineDiff(left, right);

    // Should have deletes for left, then inserts for right
    const deletes = diff.filter((s) => s.kind === 'delete');
    const inserts = diff.filter((s) => s.kind === 'insert');

    expect(deletes).toHaveLength(2);
    expect(inserts).toHaveLength(2);
    expect(deletes[0]).toEqual({ kind: 'delete', line: 'old1', leftLine: 1 });
    expect(inserts[0]).toEqual({ kind: 'insert', line: 'new1', rightLine: 1 });
  });

  it('single line insert in middle', () => {
    const left = 'line1\nline3';
    const right = 'line1\nline2\nline3';
    const diff = computeLineDiff(left, right);

    // Should be: context, insert, context
    expect(diff).toHaveLength(3);
    expect(diff[0]!.kind).toBe('context');
    expect((diff[0]! as any).left).toBe('line1');
    expect(diff[1]!.kind).toBe('insert');
    expect((diff[1]! as any).line).toBe('line2');
    expect(diff[2]!.kind).toBe('context');
    expect((diff[2]! as any).left).toBe('line3');
  });

  it('single line delete in middle', () => {
    const left = 'line1\nline2\nline3';
    const right = 'line1\nline3';
    const diff = computeLineDiff(left, right);

    // Should be: context, delete, context
    expect(diff).toHaveLength(3);
    expect(diff[0]!.kind).toBe('context');
    expect((diff[0]! as any).left).toBe('line1');
    expect(diff[1]!.kind).toBe('delete');
    expect((diff[1]! as any).line).toBe('line2');
    expect(diff[2]!.kind).toBe('context');
    expect((diff[2]! as any).left).toBe('line3');
  });

  it('empty strings', () => {
    const diff = computeLineDiff('', '');
    expect(diff).toHaveLength(1);
    expect(diff[0]).toEqual({
      kind: 'context',
      left: '',
      right: '',
      leftLine: 1,
      rightLine: 1,
    });
  });

  it('empty left, non-empty right', () => {
    const diff = computeLineDiff('', 'line1\nline2');
    const inserts = diff.filter((s) => s.kind === 'insert');
    expect(inserts).toHaveLength(2);
  });

  it('non-empty left, empty right', () => {
    const diff = computeLineDiff('line1\nline2', '');
    const deletes = diff.filter((s) => s.kind === 'delete');
    expect(deletes).toHaveLength(2);
  });
});
