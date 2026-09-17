import { describe, expect, it, beforeEach, vi } from 'vitest';
import {
  pushToast,
  dismissToast,
  pauseToast,
  resumeToast,
  toastAction,
  toastDuration,
  ACTION_TOAST_MIN_MS,
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

  it('a toast with an action stays at least 8s', () => {
    pushToast({ kind: 'success', message: 'Section deleted', action: { label: 'Undo', onAction: () => {} } });
    vi.advanceTimersByTime(ACTION_TOAST_MIN_MS - 1);
    expect(__getToastsForTesting()).toHaveLength(1);
    vi.advanceTimersByTime(2);
    expect(__getToastsForTesting()).toHaveLength(0);
  });

  it('keeps legacy actionLabel/onAction working and resolves either shape', () => {
    const onAction = vi.fn();
    const legacy = { kind: 'info' as const, message: 'x', actionLabel: 'Retry', onAction };
    expect(toastAction(legacy)).toEqual({ label: 'Retry', onAction });
    expect(toastDuration(legacy)).toBe(ACTION_TOAST_MIN_MS);
    const modern = { kind: 'success' as const, action: { label: 'Undo', onAction } };
    expect(toastAction(modern)).toBe(modern.action);
    expect(toastAction({ actionLabel: 'Orphan label' })).toBeNull();
    expect(toastDuration({ kind: 'success' })).toBe(2500);
    expect(toastDuration({ kind: 'error', action: { label: 'Retry', onAction } })).toBeNull();
  });

  it('pausing holds the clock and resuming continues with the time left', () => {
    const id = pushToast({ kind: 'success', message: 'Moved', action: { label: 'Undo', onAction: () => {} } });
    vi.advanceTimersByTime(6000);
    pauseToast(id);
    vi.advanceTimersByTime(60_000);
    expect(__getToastsForTesting()).toHaveLength(1);
    resumeToast(id);
    vi.advanceTimersByTime(1999);
    expect(__getToastsForTesting()).toHaveLength(1);
    vi.advanceTimersByTime(2);
    expect(__getToastsForTesting()).toHaveLength(0);
  });

  it('dismissing clears a pending timer (no late double-dismiss)', () => {
    const id = pushToast({ kind: 'success', message: 'a' });
    dismissToast(id);
    const other = pushToast({ kind: 'error', message: 'b' });
    vi.advanceTimersByTime(5000);
    expect(__getToastsForTesting().map((t) => t.id)).toEqual([other]);
  });
});
