/**
 * Root layout component — app shell with sidebar, header, and main content area
 * Persists sidebar collapse state to localStorage (kp-sidebar-collapsed)
 * Handles Cmd+K global command palette trigger
 */

import { useEffect, useState } from 'react';
import { Outlet, useNavigate, useRouterState } from '@tanstack/react-router';
import { useMe, useAccess } from '../queries.js';
import { Sidebar } from '../components/shell/Sidebar.js';
import { GlobalHeader } from '../components/shell/GlobalHeader.js';
import { CommandPalette } from '../components/shell/CommandPalette.js';
import { ToastViewport } from '../components/Toast.js';
import '../pages/Root.css';

const SIDEBAR_STORAGE_KEY = 'kp-sidebar-collapsed';
const AUTH_MODE = import.meta.env.VITE_KNOWLEDGE_E3_AUTH_MODE === 'disabled' ? 'disabled' : 'session';

export function Root() {
  const { data: user, isLoading, isError } = useMe();
  const { data: readMode, isLoading: accessLoading } = useAccess();
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const onLoginPage = pathname === '/login';

  // An anonymous visitor (session mode, no resolved /me). In `public` read mode
  // they may browse content, but admin/profile routes still require a login.
  const isAnon = AUTH_MODE === 'session' && !isLoading && isError;
  const isProtectedRoute = pathname.startsWith('/admin') || pathname.startsWith('/profile');
  const mustLogin =
    isAnon && !onLoginPage && !accessLoading && (readMode !== 'public' || isProtectedRoute);
  // While we still don't know the access mode, hold rendering for an anon on a
  // non-login route so we never flash protected content before deciding.
  const awaitingAccess = isAnon && !onLoginPage && accessLoading;

  // Sidebar collapse state (persisted)
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() => {
    if (typeof window === 'undefined') return true;
    try {
      const stored = localStorage.getItem(SIDEBAR_STORAGE_KEY);
      return stored !== 'false'; // Default true (collapsed)
    } catch {
      return true; // Fallback: localStorage may be unavailable
    }
  });

  // Command palette modal state
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [pageInEditMode, setPageInEditMode] = useState(false);
  // Mobile nav drawer (<= 860px)
  const [navOpen, setNavOpen] = useState(false);

  // Persist sidebar state on change
  useEffect(() => {
    try {
      localStorage.setItem(SIDEBAR_STORAGE_KEY, String(sidebarCollapsed));
    } catch {
      // Ignore — localStorage may be unavailable
    }
  }, [sidebarCollapsed]);

  // Keep global shell affordances in sync with page edit mode. The page editor
  // owns edit state locally, so it reports mode changes upward with a lightweight
  // browser event instead of exposing route-specific state through the app shell.
  useEffect(() => {
    const handlePageEditModeChanged = (event: Event) => {
      const detail = (event as CustomEvent<{ isEditing?: boolean }>).detail;
      const isEditing = Boolean(detail?.isEditing);
      setPageInEditMode(isEditing);
      if (isEditing) setPaletteOpen(false);
    };

    window.addEventListener('kp:page-edit-mode-changed', handlePageEditModeChanged);
    return () => window.removeEventListener('kp:page-edit-mode-changed', handlePageEditModeChanged);
  }, []);

  useEffect(() => {
    if (!pathname.startsWith('/p/') && !pathname.startsWith('/items/')) {
      setPageInEditMode(false);
    }
    setNavOpen(false); // close the mobile drawer on navigation
  }, [pathname]);

  // Global keyboard listeners: Cmd/Ctrl+K opens command palette; Cmd/Ctrl+? routes to Help.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const isCmdK = (e.metaKey || e.ctrlKey) && e.key === 'k';
      const isHelp = (e.metaKey || e.ctrlKey) && (e.key === '?' || e.key === '/');

      if (isCmdK) {
        e.preventDefault();
        if (pageInEditMode) return;
        setPaletteOpen((prev) => !prev);
        return;
      }

      if (isHelp) {
        e.preventDefault();
        setPaletteOpen(false);
        navigate({ to: '/help' as any });
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [navigate, pageInEditMode]);

  // Redirect anonymous visitors to login only when reading is restricted
  // (authenticated mode) or they hit an admin/profile route. In public read
  // mode they can browse content without a session.
  useEffect(() => {
    if (mustLogin) {
      navigate({ to: '/login' });
    }
  }, [mustLogin, navigate]);

  if (mustLogin || awaitingAccess) {
    return null;
  }

  // On login page, render without shell
  if (onLoginPage) {
    return <Outlet />;
  }

  // Authenticated: render full app shell
  return (
    <div className={`kp-app${navOpen ? ' kp-nav-open' : ''}`}>
      {/* Mobile drawer backdrop */}
      <div
        className="kp-nav-backdrop"
        role="presentation"
        onClick={() => setNavOpen(false)}
      />

      {/* Sidebar (collapsible; drawer on mobile) */}
      <Sidebar
        collapsed={sidebarCollapsed}
        onToggleCollapsed={() => setSidebarCollapsed((c) => !c)}
        onOpenPalette={() => setPaletteOpen(true)}
        mobileOpen={navOpen}
        onMobileClose={() => setNavOpen(false)}
      />

      {/* Main content area */}
      <div className="kp-main">
        {/* Header */}
        <GlobalHeader onOpenPalette={() => setPaletteOpen(true)} onOpenNav={() => setNavOpen(true)} />

        {/* Page content (Outlet) */}
        <Outlet />
      </div>

      {/* Command palette modal */}
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onOpenKeyboardHelp={() => {
          setPaletteOpen(false);
          navigate({ to: '/help' as any });
        }}
      />

      {/* Toast notification system (global) */}
      <ToastViewport />
    </div>
  );
}
