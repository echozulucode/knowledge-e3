/**
 * useToast — module-level toast store shared by producers and the viewport.
 *
 * State lives in a module-scope Map. Components subscribe via
 * useSyncExternalStore so every caller sees the same toast list regardless of
 * where it mounts in the tree. Public API (push, dismiss, toasts) is unchanged.
 *
 * Success/info auto-dismiss after 2500ms; errors persist until dismissed.
 *
 * Actions ("Undo", "Retry"): pass `action: { label, onAction }` (or the older
 * `actionLabel` + `onAction`, still supported). A toast carrying an action stays
 * at least 8 s - an Undo that vanishes in 2.5 s is not reachable by keyboard or
 * screen-reader users (WCAG 2.2.1) - and its timer pauses while the pointer or
 * focus is on the toast (`pauseToast` / `resumeToast`, called by Toast.tsx).
 */

import { useSyncExternalStore } from 'react';

export interface Toast {
  id: string;
  kind: 'success' | 'error' | 'info';
  message: string;
  /** A button in the toast, e.g. { label: 'Undo', onAction: restore }. Clicking it runs onAction and dismisses. */
  action?: ToastAction;
  /** @deprecated use `action` - kept for existing call sites. */
  actionLabel?: string;
  /** @deprecated use `action` - kept for existing call sites. */
  onAction?: () => void;
  createdAt: number;
}

export interface ToastAction {
  label: string;
  onAction: () => void;
}

interface UseToastReturn {
  toasts: Toast[];
  push: (opts: Omit<Toast, 'id' | 'createdAt'>) => string;
  dismiss: (id: string) => void;
}

const AUTO_DISMISS_MS = 2500;
/** Minimum lifetime of a success/info toast that offers an action. */
export const ACTION_TOAST_MIN_MS = 8000;

let toastCounter = 0;
const toastMap = new Map<string, Toast>();
let snapshot: Toast[] = [];
const listeners = new Set<() => void>();
/** Auto-dismiss bookkeeping so a hovered/focused toast can pause and resume. */
const timers = new Map<string, { handle: ReturnType<typeof setTimeout> | null; remaining: number; startedAt: number }>();

function rebuildSnapshot() {
  snapshot = Array.from(toastMap.values());
}

function notify() {
  rebuildSnapshot();
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): Toast[] {
  return snapshot;
}

/** The action a toast offers, from either the new `action` or the legacy pair. */
export function toastAction(toast: Pick<Toast, 'action' | 'actionLabel' | 'onAction'>): ToastAction | null {
  if (toast.action) return toast.action;
  if (toast.actionLabel && toast.onAction) return { label: toast.actionLabel, onAction: toast.onAction };
  return null;
}

/** Auto-dismiss delay, or null when the toast persists until dismissed. */
export function toastDuration(toast: Pick<Toast, 'kind' | 'action' | 'actionLabel' | 'onAction'>): number | null {
  if (toast.kind === 'error') return null;
  return toastAction(toast) ? ACTION_TOAST_MIN_MS : AUTO_DISMISS_MS;
}

function startTimer(id: string, ms: number): void {
  timers.set(id, { handle: setTimeout(() => dismissToast(id), ms), remaining: ms, startedAt: Date.now() });
}

export function pushToast(opts: Omit<Toast, 'id' | 'createdAt'>): string {
  const id = `toast-${toastCounter++}`;
  const toast: Toast = { ...opts, id, createdAt: Date.now() };
  toastMap.set(id, toast);
  notify();

  const duration = toastDuration(opts);
  if (duration !== null) startTimer(id, duration);

  return id;
}

/** Stop the auto-dismiss clock (pointer over / focus inside the toast). */
export function pauseToast(id: string): void {
  const timer = timers.get(id);
  if (!timer || timer.handle === null) return;
  clearTimeout(timer.handle);
  timer.remaining = Math.max(0, timer.remaining - (Date.now() - timer.startedAt));
  timer.handle = null;
}

/** Restart the clock with what was left - never less than a short grace period. */
export function resumeToast(id: string): void {
  const timer = timers.get(id);
  if (!timer || timer.handle !== null) return;
  startTimer(id, Math.max(timer.remaining, 1000));
}

export function dismissToast(id: string): void {
  const timer = timers.get(id);
  if (timer?.handle) clearTimeout(timer.handle);
  timers.delete(id);
  if (!toastMap.delete(id)) return;
  notify();
}

export function useToast(): UseToastReturn {
  const toasts = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return { toasts, push: pushToast, dismiss: dismissToast };
}

export function __getToastsForTesting(): Toast[] {
  return snapshot;
}

export function __resetToastsForTesting(): void {
  for (const timer of timers.values()) if (timer.handle) clearTimeout(timer.handle);
  timers.clear();
  toastMap.clear();
  notify();
}
