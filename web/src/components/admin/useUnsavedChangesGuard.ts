/**
 * useUnsavedChangesGuard — "Discard unsaved changes?" before leaving an editor
 * (the admin UX review §3.2). Every admin editor uses it:
 * EditPageLayout wires it in; a side sheet or custom editor calls it directly.
 *
 * What it covers:
 *   - in-app navigation (Link, navigate(), back/forward) via TanStack Router's
 *     `useBlocker`, which blocks through the router's history object;
 *   - tab close and reload via the same blocker's `enableBeforeUnload` (the
 *     router registers the one `beforeunload` listener, so there is no second
 *     mechanism to keep in step). Browsers show their own generic text there;
 *     `message` only applies to in-app navigation.
 * Closing a dialog is NOT navigation - EditDialog asks with ConfirmDialog.
 *
 * Why a native confirm for in-app navigation: the blocker must answer
 * synchronously-or-async inside history's navigation attempt, and a native
 * confirm is the one prompt that also works for back/forward and needs no host
 * component. It is the same wording Compose's Cancel already uses
 * ('Discard unsaved changes?'), so the product asks one question one way.
 *
 * Only pathname changes prompt. Search-param changes on the same page (a tab, a
 * preview toggle, `?user=`) keep the edit in place, so they pass through.
 *
 * After a successful save that navigates away in the same tick (e.g. create →
 * `/admin/sections/$slug`), the dirty flag has not re-rendered yet. Pass
 * `ignoreBlocker: true` to that navigate call:
 *   navigate({ to: '/admin/sections/$slug', params, replace: true, ignoreBlocker: true })
 */
import { useBlocker } from '@tanstack/react-router';
import { useCallback, useRef } from 'react';

export const UNSAVED_CHANGES_MESSAGE = 'Discard unsaved changes?';

export function useUnsavedChangesGuard(isDirty: boolean, message: string = UNSAVED_CHANGES_MESSAGE): void {
  // Refs keep the blocker callbacks stable: useBlocker re-registers with history
  // whenever a callback identity changes, and that would happen every render.
  const dirtyRef = useRef(isDirty);
  dirtyRef.current = isDirty;
  const messageRef = useRef(message);
  messageRef.current = message;

  const shouldBlockFn = useCallback(({ current, next }: { current: { pathname: string }; next: { pathname: string } }): boolean => {
    if (!dirtyRef.current) return false;
    if (current.pathname === next.pathname) return false;
    return !window.confirm(messageRef.current);
  }, []);

  const enableBeforeUnload = useCallback(() => dirtyRef.current, []);

  useBlocker({ shouldBlockFn, enableBeforeUnload, disabled: !isDirty });
}
