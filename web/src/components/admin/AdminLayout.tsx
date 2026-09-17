/**
 * AdminLayout — the parent route of every `/admin*` page
 * (the admin UX review §3.1). It renders the grouped AdminNav once
 * and the page beside it, so a page no longer carries its own navigation and
 * the nav keeps its place between admin pages.
 *
 * The root is also the admin area's size container: the nav and the page body
 * lay out against the width they actually get, which with the app rail open or
 * collapsed is not the viewport's.
 */
import { useLayoutEffect, useRef } from 'react';
import { Outlet, useRouterState } from '@tanstack/react-router';
import { AdminNav } from './AdminNav.js';
import './AdminLayout.css';

export function AdminLayout(): JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null);
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  // This element is the shell's scroll container (Root.css) and, unlike the
  // per-page <main> it replaces, it survives moving between admin pages. Left
  // alone, opening Users from the bottom of a long Tags page would land halfway
  // down Users. A new page starts at its top; a search-only change (Audit's
  // filters) keeps its place.
  useLayoutEffect(() => {
    rootRef.current?.scrollTo({ top: 0 });
  }, [pathname]);

  return (
    <div className="kp-admin-layout" ref={rootRef}>
      <div className="kp-admin-layout__frame">
        <AdminNav />
        <div className="kp-admin-layout__page">
          <Outlet />
        </div>
      </div>
    </div>
  );
}
