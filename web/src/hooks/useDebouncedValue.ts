import { useEffect, useState } from 'react';

/**
 * Debounce a rapidly-changing value (a search box) before it drives navigation
 * or a request.
 *
 * Search inputs used to navigate on every keystroke, which pushed one history
 * entry per character: typing "kafka" cost five Back presses to undo, walking
 * the query backwards one letter at a time. Debouncing collapses a burst of
 * typing into a single update; navigation callers should ALSO pass
 * `replace: true` so a refined query replaces the previous one instead of
 * stacking.
 */
export function useDebouncedValue<T>(value: T, delayMs = 250): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);

  return debounced;
}
