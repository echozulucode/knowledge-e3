import { describe, expect, it, beforeEach, vi } from 'vitest';
import {
  pushToast,
  dismissToast,
  __getToastsForTesting,
  __resetToastsForTesting,
} from './useToast.js';

describe('useToast module store', () => {
  beforeEach(() => {
    __resetToastsForTesting();
    vi.useFakeTimers();
  });

  it('pushToast adds an entry the shared snapshot can observe', () => {
    const id = pushToast({ kind: 'success', message: 'saved' });
    expect(id).toMatch(/^toast-/);
    const list = __getToastsForTesting();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id, kind: 'success', message: 'saved' });
  });

  it('producer and consumer import the same module instance (regression: per-call useState)', async () => {
    const producer = await import('./useToast.js');
    const consumer = await import('./useToast.js');
    expect(producer).toBe(consumer);

    const id = producer.pushToast({ kind: 'info', message: 'hello' });
    expect(consumer.__getToastsForTesting().some((t) => t.id === id)).toBe(true);
  });

  it('success toasts auto-dismiss after 2500ms', () => {
    pushToast({ kind: 'success', message: 'saved' });
    expect(__getToastsForTesting()).toHaveLength(1);

    vi.advanceTimersByTime(2499);
    expect(__getToastsForTesting()).toHaveLength(1);

    vi.advanceTimersByTime(2);
    expect(__getToastsForTesting()).toHaveLength(0);
  });

  it('info toasts auto-dismiss after 2500ms', () => {
    pushToast({ kind: 'info', message: 'fyi' });
    vi.advanceTimersByTime(2501);
    expect(__getToastsForTesting()).toHaveLength(0);
  });

  it('error toasts do not auto-dismiss', () => {
    const id = pushToast({ kind: 'error', message: 'boom' });
    vi.advanceTimersByTime(60_000);
    expect(__getToastsForTesting()).toHaveLength(1);

    dismissToast(id);
    expect(__getToastsForTesting()).toHaveLength(0);
  });

  it('dismissing an unknown id is a safe no-op', () => {
    expect(() => dismissToast('toast-does-not-exist')).not.toThrow();
    expect(__getToastsForTesting()).toHaveLength(0);
  });

  it('snapshot reference stays stable when nothing changes', () => {
    pushToast({ kind: 'error', message: 'first' });
    const a = __getToastsForTesting();
    const b = __getToastsForTesting();
    expect(a).toBe(b);
  });

  it('snapshot reference changes after a mutation (subscribers see updates)', () => {
    pushToast({ kind: 'error', message: 'first' });
    const before = __getToastsForTesting();
    pushToast({ kind: 'error', message: 'second' });
    const after = __getToastsForTesting();
    expect(after).not.toBe(before);
    expect(after).toHaveLength(2);
  });
});
