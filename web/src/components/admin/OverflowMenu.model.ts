/**
 * Pure keyboard logic for OverflowMenu (WAI-ARIA menu button pattern).
 *
 * Disabled items stay focusable on purpose: their reason is visible text inside
 * the item, and a screen-reader user can only hear that reason if focus can
 * land on it (aria-disabled, not `disabled`).
 */

export type MenuKeyResult = { type: 'focus'; index: number } | { type: 'close' } | { type: 'none' };

/** Arrow keys wrap; Home/End jump; Esc closes (focus returns to the button); Tab closes and lets focus move on. */
export function menuKeyTarget(key: string, current: number, count: number): MenuKeyResult {
  if (count <= 0) return key === 'Escape' || key === 'Tab' ? { type: 'close' } : { type: 'none' };
  switch (key) {
    case 'ArrowDown':
      return { type: 'focus', index: current < 0 ? 0 : (current + 1) % count };
    case 'ArrowUp':
      return { type: 'focus', index: current < 0 ? count - 1 : (current - 1 + count) % count };
    case 'Home':
    case 'PageUp':
      return { type: 'focus', index: 0 };
    case 'End':
    case 'PageDown':
      return { type: 'focus', index: count - 1 };
    case 'Escape':
    case 'Tab':
      return { type: 'close' };
    default:
      return { type: 'none' };
  }
}

/** Keys on the closed menu button that open the menu, and where focus should start. */
export function openKeyTarget(key: string, count: number): number | null {
  if (count <= 0) return null;
  if (key === 'ArrowDown' || key === 'Enter' || key === ' ') return 0;
  if (key === 'ArrowUp') return count - 1;
  return null;
}

/**
 * Typeahead: the next item (after `current`, wrapping) whose label starts with
 * `query`. Returns -1 when nothing matches. A query of one repeated character
 * ("dd") cycles through items starting with that character, as native menus do.
 */
export function typeaheadIndex(labels: readonly string[], current: number, query: string): number {
  if (!query || labels.length === 0) return -1;
  const q = query.toLocaleLowerCase();
  const repeated = q.length > 1 && q.split('').every((ch) => ch === q[0]);
  const needle = repeated ? q[0]! : q;
  // A multi-character query may still match the current item ("de" while on "Delete").
  const startOffset = repeated || q.length === 1 ? 1 : 0;
  for (let step = 0; step < labels.length; step++) {
    const index = (current + startOffset + step + labels.length) % labels.length;
    if (labels[index]!.toLocaleLowerCase().startsWith(needle)) return index;
  }
  return -1;
}

/** Is this key a printable character that should feed typeahead? */
export function isTypeaheadKey(key: string, modifiers: { ctrlKey: boolean; metaKey: boolean; altKey: boolean }): boolean {
  return key.length === 1 && key !== ' ' && !modifiers.ctrlKey && !modifiers.metaKey && !modifiers.altKey;
}

export interface MenuPosition {
  top: number;
  left: number;
  /** True when the menu opens upward because there is no room below. */
  above: boolean;
}

/**
 * Fixed-position placement next to the trigger. Fixed (not absolute) so a menu
 * inside a horizontally scrolling table or a dialog is never clipped.
 */
export function placeMenu(
  trigger: { top: number; bottom: number; left: number; right: number },
  menu: { width: number; height: number },
  viewport: { width: number; height: number },
  align: 'start' | 'end',
  gap = 4,
  margin = 8,
): MenuPosition {
  const spaceBelow = viewport.height - trigger.bottom - gap - margin;
  const spaceAbove = trigger.top - gap - margin;
  const above = menu.height > spaceBelow && spaceAbove > spaceBelow;
  const top = above ? Math.max(margin, trigger.top - gap - menu.height) : Math.min(trigger.bottom + gap, Math.max(margin, viewport.height - margin - menu.height));
  const rawLeft = align === 'end' ? trigger.right - menu.width : trigger.left;
  const left = Math.min(Math.max(margin, rawLeft), Math.max(margin, viewport.width - margin - menu.width));
  return { top, left, above };
}
