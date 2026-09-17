/**
 * OverflowMenu — the "⋯" row-actions menu (the admin UX review §3.2).
 *
 * Use it wherever a row or card would otherwise carry 2–6 buttons: DataTable's
 * `rowActions`, a pinned-topic card, a source detail header. Keep the primary
 * action (open/edit) OUT of the menu - it is the row click or the page's main
 * button; the menu holds the rest ("View on site · Duplicate · Delete…").
 *
 * Rules it enforces (§3.3):
 *   - Nothing destructive commits from here: a `danger` item should open a
 *     ConfirmDialog, not delete. Label such items with a trailing "…".
 *   - A disabled item shows its `disabledReason` as visible text under the
 *     label - never only a tooltip. It stays focusable (aria-disabled) so a
 *     screen-reader user hears the reason too.
 *
 * Keyboard (WAI-ARIA menu button): Enter/Space/ArrowDown open on the first
 * item, ArrowUp opens on the last; in the menu ArrowUp/Down wrap, Home/End jump,
 * typing a letter jumps to the next matching item, Esc closes and returns focus
 * to the button, Tab closes and moves on. Click outside closes. Selecting an
 * item returns focus to the button BEFORE calling `onSelect`, so a dialog the
 * item opens restores focus to the right place when it closes.
 *
 * The menu is position:fixed next to the button so it is never clipped by a
 * scrolling table or a dialog; it closes on scroll/resize rather than chasing
 * the button.
 */
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { isTypeaheadKey, menuKeyTarget, openKeyTarget, placeMenu, typeaheadIndex } from './OverflowMenu.model.js';
import './OverflowMenu.css';

export interface OverflowMenuItem {
  id: string;
  label: string;
  onSelect: () => void;
  danger?: boolean;
  disabledReason?: string;
  icon?: ReactNode;
  separatorBefore?: boolean;
}

export interface OverflowMenuProps {
  /** Accessible name, e.g. "Actions for Updates". */
  label: string;
  items: OverflowMenuItem[];
  align?: 'start' | 'end';
  /** Visible text next to the "⋯" icon (e.g. "More"); the icon alone by default. */
  buttonText?: string;
  disabled?: boolean;
}

const TYPEAHEAD_RESET_MS = 500;

export function OverflowMenu({ label, items, align = 'end', buttonText, disabled = false }: OverflowMenuProps): JSX.Element {
  const menuId = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const typeahead = useRef({ query: '', timer: 0 });
  // Where the button was when the menu was placed; see the scroll handler.
  const placedTrigger = useRef<{ top: number; left: number } | null>(null);

  const close = useCallback((returnFocus: boolean) => {
    setOpen(false);
    setActiveIndex(-1);
    setPosition(null);
    if (returnFocus) buttonRef.current?.focus();
  }, []);

  const openAt = (index: number): void => {
    if (items.length === 0) return;
    setActiveIndex(index);
    setOpen(true);
  };

  // Place before paint so the menu never flashes at (0,0).
  useLayoutEffect(() => {
    if (!open || !buttonRef.current || !menuRef.current) return;
    const trigger = buttonRef.current.getBoundingClientRect();
    const menu = menuRef.current.getBoundingClientRect();
    const placed = placeMenu(trigger, { width: menu.width, height: menu.height }, { width: window.innerWidth, height: window.innerHeight }, align);
    placedTrigger.current = { top: trigger.top, left: trigger.left };
    setPosition({ top: placed.top, left: placed.left });
  }, [open, align, items.length]);

  // Roving focus follows activeIndex once the menu is placed.
  useEffect(() => {
    if (open && position && activeIndex >= 0) itemRefs.current[activeIndex]?.focus({ preventScroll: true });
  }, [open, position, activeIndex]);

  // Click outside, scroll and resize close the menu.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as Node | null;
      if (target && (menuRef.current?.contains(target) || buttonRef.current?.contains(target))) return;
      close(false);
    };
    const onScroll = (event: Event): void => {
      // Scrolling inside a long menu is fine; anything else detaches it from the button.
      if (menuRef.current && event.target instanceof Node && menuRef.current.contains(event.target)) return;
      // Scroll events are dispatched a frame late, so a click right after a scroll (a trackpad
      // still gliding, or a click that first scrolled the row into view) would otherwise open
      // the menu and shut it at once. Close only when the button has really moved.
      const trigger = buttonRef.current?.getBoundingClientRect();
      const placedAt = placedTrigger.current;
      if (trigger && placedAt && Math.abs(trigger.top - placedAt.top) < 2 && Math.abs(trigger.left - placedAt.left) < 2) return;
      close(false);
    };
    const onResize = (): void => close(false);
    // Esc must close only the menu. Modal listens for Esc on `document` in the
    // capture phase, which runs before any React handler; a `window` capture
    // listener runs earlier still, so the menu can claim the key first.
    const onEscape = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      close(true);
    };
    window.addEventListener('keydown', onEscape, true);
    document.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('keydown', onEscape, true);
      document.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
    };
  }, [open, close]);

  useEffect(() => () => window.clearTimeout(typeahead.current.timer), []);

  const onButtonKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    const start = openKeyTarget(event.key, items.length);
    if (start === null) return;
    event.preventDefault();
    openAt(start);
  };

  const select = (item: OverflowMenuItem): void => {
    if (item.disabledReason) return;
    close(true);
    item.onSelect();
  };

  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (isTypeaheadKey(event.key, event)) {
      const state = typeahead.current;
      window.clearTimeout(state.timer);
      state.query += event.key;
      state.timer = window.setTimeout(() => {
        state.query = '';
      }, TYPEAHEAD_RESET_MS);
      const index = typeaheadIndex(
        items.map((item) => item.label),
        activeIndex,
        state.query,
      );
      if (index >= 0) setActiveIndex(index);
      event.preventDefault();
      return;
    }
    const result = menuKeyTarget(event.key, activeIndex, items.length);
    if (result.type === 'none') return;
    if (result.type === 'close') {
      // Tab: close and let the browser move focus on. (Esc is handled by the
      // window capture listener above and never reaches here.)
      close(event.key === 'Escape');
      return;
    }
    event.preventDefault();
    setActiveIndex(result.index);
  };

  return (
    <div className="kp-overflow">
      <button
        ref={buttonRef}
        type="button"
        className="kp-overflow__button"
        aria-label={buttonText ? undefined : label}
        title={buttonText ? undefined : label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        disabled={disabled || items.length === 0}
        onClick={() => (open ? close(false) : openAt(0))}
        onKeyDown={onButtonKeyDown}
        data-open={open ? 'true' : undefined}
      >
        <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false">
          <circle cx="5" cy="12" r="2" />
          <circle cx="12" cy="12" r="2" />
          <circle cx="19" cy="12" r="2" />
        </svg>
        {buttonText ? (
          <span>
            {buttonText}
            <span className="kp-overflow__vh"> — {label}</span>
          </span>
        ) : null}
      </button>
      {open ? (
        <div
          ref={menuRef}
          id={menuId}
          role="menu"
          aria-label={label}
          className="kp-overflow__menu"
          // Hidden until measured so the first frame is not at (0,0).
          style={position ? { top: position.top, left: position.left } : { top: 0, left: 0, visibility: 'hidden' }}
          onKeyDown={onMenuKeyDown}
        >
          {items.map((item, index) => {
            const labelId = `${menuId}-${item.id}-label`;
            const reasonId = item.disabledReason ? `${menuId}-${item.id}-reason` : undefined;
            return (
              <div key={item.id} className="kp-overflow__entry" role="none">
                {item.separatorBefore && index > 0 ? <div role="separator" className="kp-overflow__separator" /> : null}
                <button
                  ref={(el) => {
                    itemRefs.current[index] = el;
                  }}
                  type="button"
                  role="menuitem"
                  tabIndex={index === activeIndex ? 0 : -1}
                  className="kp-overflow__item"
                  data-danger={item.danger ? 'true' : undefined}
                  aria-disabled={item.disabledReason ? true : undefined}
                  // Name = label, description = reason, so the reason is read
                  // after the name instead of being run into it.
                  aria-labelledby={labelId}
                  aria-describedby={reasonId}
                  onClick={() => select(item)}
                  onMouseMove={() => {
                    if (activeIndex !== index) setActiveIndex(index);
                  }}
                >
                  {item.icon ? (
                    <span className="kp-overflow__icon" aria-hidden="true">
                      {item.icon}
                    </span>
                  ) : null}
                  <span className="kp-overflow__text">
                    <span id={labelId} className="kp-overflow__label">
                      {item.label}
                    </span>
                    {item.disabledReason ? (
                      <span id={reasonId} className="kp-overflow__reason">
                        {item.disabledReason}
                      </span>
                    ) : null}
                  </span>
                </button>
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
