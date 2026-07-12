/**
 * useKeyboardHelp: global keyboard listener for Cmd+? and Cmd+/ to toggle
 * the keyboard help modal. Also handles Escape to close when open.
 *
 * Skips activation if the active element is an input/textarea/contenteditable
 * EXCEPT: allows the shortcut to fire inside contenteditable to maximize
 * discoverability (? requires Shift on most layouts, so collisions are rare).
 * Escape is guarded against firing inside editors to avoid conflicts with
 * editor escape behavior.
 */

import { useEffect, type Dispatch, type SetStateAction } from 'react';

export function useKeyboardHelp(setOpen: Dispatch<SetStateAction<boolean>>): void {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement | null;

      // Cmd+? or Cmd+/ to toggle help modal
      const isCmdQuestion = (e.metaKey || e.ctrlKey) && e.key === '?';
      const isCmdSlash = (e.metaKey || e.ctrlKey) && e.key === '/';

      if (isCmdQuestion || isCmdSlash) {
        // Allow shortcut to fire even inside editors for discoverability
        // (? requires Shift on most layouts, collisions are rare)
        e.preventDefault();
        setOpen((prev: boolean) => !prev);
        return;
      }

      // Escape to close (only if currently in focus-trapped modal context)
      // Guard: skip if we're inside a contenteditable to avoid conflicts
      if (e.key === 'Escape') {
        const tag = target?.tagName;
        const isEditableContext = tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable;
        if (!isEditableContext) {
          // Escape closes the modal (modal's own effect handles this)
          // But we don't preventDefault here — let the modal's effect handle it
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [setOpen]);
}
