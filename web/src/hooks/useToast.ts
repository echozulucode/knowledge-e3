/**
 * useToast — module-level toast store shared by producers and the viewport.
 *
 * State lives in a module-scope Map. Components subscribe via
 * useSyncExternalStore so every caller sees the same toast list regardless of
 * where it mounts in the tree. Public API (push, dismiss, toasts) is unchanged.
 *
 * Success/info auto-dismiss after 2500ms; errors persist until dismissed.
 */

import { useSyncExternalStore } from 'react';

export interface Toast {
  id: string;
  kind: 'success' | 'error' | 'info';
  message: string;
  actionLabel?: string;
  onAction?: () => void;
  createdAt: number;
}

interface UseToastReturn {
  toasts: Toast[];
  push: (opts: Omit<Toast, 'id' | 'createdAt'>) => string;
  dismiss: (id: string) => void;
}

const AUTO_DISMISS_MS = 2500;

let toastCounter = 0;
const toastMap = new Map<string, Toast>();
let snapshot: Toast[] = [];
const listeners = new Set<() => void>();

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

export function pushToast(opts: Omit<Toast, 'id' | 'createdAt'>): string {
  const id = `toast-${toastCounter++}`;
  const toast: Toast = { ...opts, id, createdAt: Date.now() };
  toastMap.set(id, toast);
  notify();

  if (opts.kind === 'success' || opts.kind === 'info') {
    setTimeout(() => dismissToast(id), AUTO_DISMISS_MS);
  }

  return id;
}

export function dismissToast(id: string): void {
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
  toastMap.clear();
  notify();
}
