/**
 * Pure helpers for EditPageLayout (node-testable, no DOM).
 */

export interface ShortcutKeyEvent {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/** Cmd+S on macOS, Ctrl+S elsewhere. Shift/Alt variants are left to the browser. */
export function isSaveShortcut(event: ShortcutKeyEvent): boolean {
  return (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 's';
}

export type SaveStatus = 'saving' | 'unsaved' | 'blocked' | 'ready' | 'clean';

/** The status line next to Save - also the visible reason Save is disabled (§3.3). */
export function saveStatus(input: { isDirty: boolean; isSaving: boolean; canSave: boolean }): { status: SaveStatus; text: string } {
  if (input.isSaving) return { status: 'saving', text: 'Saving…' };
  if (input.isDirty && input.canSave) return { status: 'unsaved', text: 'Unsaved changes' };
  if (input.isDirty) return { status: 'blocked', text: 'Fix the highlighted fields to save' };
  // e.g. a prefilled duplicate: nothing typed yet, but saving is meaningful.
  if (input.canSave) return { status: 'ready', text: '' };
  return { status: 'clean', text: 'No changes to save' };
}
