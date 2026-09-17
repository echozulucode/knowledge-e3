/**
 * Accessible modal shell.
 *
 * Provides the cross-cutting dialog behavior that every modal needs and that
 * ConflictDialog/RenameDialog were missing (issue P2-1 / #48):
 *   - role="dialog" + aria-modal + aria-labelledby
 *   - Esc to close (captured, so it also works from inputs and is stopped from
 *     reaching page-level Esc handlers)
 *   - a focus trap that keeps Tab/Shift+Tab inside the dialog
 *   - initial focus into the dialog and focus restoration on close
 *   - optional backdrop-click to close
 *
 * Presentation is left to the caller: pass the panel's `className` (Tailwind or
 * otherwise) and render the dialog body as children, including a heading whose
 * id matches `labelledBy`.
 */
import { useEffect, useRef, type ReactNode } from 'react';

interface ModalProps {
  /** Called on Esc, backdrop click, or any caller-driven dismissal. */
  onClose: () => void;
  /** id of the heading element rendered inside `children`. */
  labelledBy: string;
  children: ReactNode;
  /** Classes for the dialog panel (the focus-trapped container). */
  className?: string;
  /** Classes for the full-screen backdrop. Has a sensible default. */
  backdropClassName?: string;
  /** Close when the backdrop (not the panel) is clicked. Default true. */
  closeOnBackdrop?: boolean;
}

/**
 * Open modals, innermost last. Every Modal listens on `document`, and
 * stopPropagation does not stop a sibling listener on the same node, so a
 * ConfirmDialog opened over a Sheet used to close BOTH on one Esc (and the
 * outer trap could pull Tab focus back out of the inner dialog). Only the
 * topmost modal handles Esc and Tab.
 */
const openModals: object[] = [];

function focusableWithin(root: HTMLElement | null): HTMLElement[] {
  if (!root) return [];
  const selector =
    'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';
  return Array.from(root.querySelectorAll<HTMLElement>(selector)).filter(
    (el) => el.offsetParent !== null || el === document.activeElement,
  );
}

export function Modal({
  onClose,
  labelledBy,
  children,
  className,
  backdropClassName = 'fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4',
  closeOnBackdrop = true,
}: ModalProps): JSX.Element {
  const panelRef = useRef<HTMLDivElement>(null);
  // The latest onClose, read at key time. Depending on `onClose` directly made
  // the effect below re-run whenever a caller passed a fresh inline function -
  // i.e. on every parent render - which re-ran the initial-focus step and yanked
  // focus back to the first control while someone was typing in the dialog.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const layer = {};
    openModals.push(layer);
    const previouslyFocused = document.activeElement as HTMLElement | null;
    // Move focus into the dialog (first focusable, else the panel itself).
    const initial = focusableWithin(panelRef.current)[0] ?? panelRef.current;
    initial?.focus();

    const onKeyDown = (e: KeyboardEvent): void => {
      if (openModals[openModals.length - 1] !== layer) return;
      if (e.key === 'Escape') {
        e.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (e.key === 'Tab') {
        const focusable = focusableWithin(panelRef.current);
        if (focusable.length === 0) {
          e.preventDefault();
          return;
        }
        const first = focusable[0]!;
        const last = focusable[focusable.length - 1]!;
        const active = document.activeElement;
        if (e.shiftKey && active === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && active === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    // Capture phase so Esc works from inside inputs and is intercepted before
    // any page-level keydown handler (e.g. the editor's) sees it.
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      const index = openModals.indexOf(layer);
      if (index !== -1) openModals.splice(index, 1);
      previouslyFocused?.focus?.();
    };
    // Mount-only: focus moves in once and is restored once.
  }, []);

  return (
    <div
      className={backdropClassName}
      role="presentation"
      onMouseDown={(e) => {
        if (closeOnBackdrop && e.target === e.currentTarget) onCloseRef.current();
      }}
    >
      <div ref={panelRef} role="dialog" aria-modal="true" aria-labelledby={labelledBy} className={className}>
        {children}
      </div>
    </div>
  );
}
