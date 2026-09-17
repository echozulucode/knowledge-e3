/**
 * useEscapeLayer — let an open popup inside a dialog close ITSELF on Esc.
 *
 * `Modal` listens for Esc on `document` in the capture phase so it wins over
 * page handlers. That also means an open listbox (or a nested "Choose from
 * Files" dialog) inside an `EditDialog` never sees Esc: the whole dialog closes
 * instead of the popup. A `window` capture listener runs before any `document`
 * one, so while `active` this takes Esc, stops it there, and closes only the
 * innermost layer — the behaviour a keyboard user expects.
 */
import { useEffect, useRef } from 'react';

export function useEscapeLayer(active: boolean, onEscape: () => void): void {
  const onEscapeRef = useRef(onEscape);
  onEscapeRef.current = onEscape;

  useEffect(() => {
    if (!active) return;
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      e.preventDefault();
      onEscapeRef.current();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [active]);
}
