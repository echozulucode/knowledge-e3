/**
 * Sidebar — collapsible left rail with navigation items
 * Collapsed: 56px (icons only)
 * Expanded: 240px (icons + labels)
 * Persists state to localStorage
 */

import React, { useEffect, useRef, useState } from 'react';
import { useNavigate, useRouterState } from '@tanstack/react-router';
import { useDebouncedValue } from '../../hooks/useDebouncedValue.js';
import { Icon, appIcons } from '../../icons.js';
import './Sidebar.css';

interface SidebarProps {
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onOpenPalette: () => void;
  /** Mobile drawer open state (<= 860px). */
  mobileOpen?: boolean;
  /** Called when a nav action should dismiss the mobile drawer. */
  onMobileClose?: () => void;
}

const NAV_ITEMS = [
  { id: 'home', label: 'Home', icon: appIcons.house, route: '/' },
  { id: 'browse', label: 'Browse', icon: appIcons.list, route: '/browse', search: { view: 'cards' } },
  { id: 'tags', label: 'Tags', icon: appIcons.tag, route: '/browse', search: { view: 'tags' } },
  { id: 'sections', label: 'Sections', icon: appIcons.layerGroup, route: '/sections' },
  // Admin moved to the user dropdown (admin-only) in GlobalHeader.
  { id: 'search', label: 'Search', icon: appIcons.magnifyingGlass, action: 'palette' },
] as const;

const BOTTOM_ITEMS = [
  { id: 'profile', label: 'Profile', icon: appIcons.user, route: '/profile' },
  { id: 'help', label: 'Help', icon: appIcons.fileLines, route: '/help' },
] as const;

export const Sidebar: React.FC<SidebarProps> = ({ collapsed, onToggleCollapsed, onOpenPalette, mobileOpen, onMobileClose }) => {
  const navigate = useNavigate();
  const [searchQuery, setSearchQuery] = useState('');
  const currentSearch = useRouterState({ select: (s) => s.location.search as { view?: string; q?: string } });
  const currentPathname = useRouterState({ select: (s) => s.location.pathname });
  const currentView = currentSearch.view === 'tags' ? 'tags' : 'grouped';

  useEffect(() => {
    setSearchQuery(currentSearch.q ?? '');
  }, [currentSearch.q]);

  // Navigate on a debounced value, and REPLACE rather than push: typing a query
  // should cost exactly one history entry, not one per character. `typing`
  // guards against the effect firing for URL-driven changes (Back, a link),
  // which would otherwise re-navigate and fight the user's own navigation.
  const debouncedQuery = useDebouncedValue(searchQuery, 250);
  const typing = useRef(false);
  useEffect(() => {
    if (!typing.current) return;
    typing.current = false;
    if ((currentSearch.q ?? '') === debouncedQuery) return;
    navigate({
      to: '/browse',
      search: { view: 'grouped', q: debouncedQuery || undefined } as any,
      replace: true,
    });
  }, [debouncedQuery]);

  // Determine active route for each nav item.
  const isActive = (item: (typeof NAV_ITEMS)[number] | (typeof BOTTOM_ITEMS)[number]): boolean => {
    if (!('route' in item)) return false;
    const route = (item as { route: string }).route;
    if (route === '/') return currentPathname === '/';
    if (route === '/browse') {
      if (currentPathname !== '/browse') return false;
      const wantTags = 'search' in item && (item as { search: { view?: string } }).search.view === 'tags';
      return wantTags ? currentView === 'tags' : currentView !== 'tags';
    }
    return currentPathname === route || currentPathname.startsWith(route + '/');
  };

  const handleNavClick = (item: (typeof NAV_ITEMS)[number] | (typeof BOTTOM_ITEMS)[number]) => {
    if ('action' in item && item.action === 'palette') {
      navigate({ to: '/browse', search: { view: 'grouped' } as any });
      window.setTimeout(() => {
        document.querySelector<HTMLInputElement>('[data-main-search-input="true"]')?.focus();
      }, 0);
      onMobileClose?.();
      return;
    }
    if ('route' in item) {
      const search = 'search' in item ? (item as { search: unknown }).search : undefined;
      navigate({ to: item.route as any, search: search as any });
      onMobileClose?.();
    }
  };

  // On mobile the drawer always renders expanded content (labels, search),
  // regardless of the desktop collapse state.
  const effectiveCollapsed = mobileOpen ? false : collapsed;

  return (
    <aside className={`kp-sidebar ${effectiveCollapsed ? 'collapsed' : 'expanded'} ${mobileOpen ? 'open' : ''}`}>
      {/* Brand row — the logo toggles collapse (mock method); a collapse button
          sits at the end when expanded. Collapsed shows just the centered cube. */}
      <div className="kp-sidebar-brand">
        <button
          type="button"
          className="kp-sidebar-logo"
          onClick={onToggleCollapsed}
          title={effectiveCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          aria-label={effectiveCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          <img src="/logo/ke3-cube-light.png" alt="" aria-hidden="true" className="kp-sidebar-logo-img kp-logo-light" />
          <img src="/logo/ke3-cube-dark.png" alt="" aria-hidden="true" className="kp-sidebar-logo-img kp-logo-dark" />
        </button>
        {!effectiveCollapsed && <span className="kp-sidebar-brandtitle">Knowledge × 10<sup>3</sup></span>}
        {!effectiveCollapsed && (
          <button
            type="button"
            className="kp-sidebar-collapse-btn"
            onClick={onToggleCollapsed}
            title="Collapse sidebar"
            aria-label="Collapse sidebar"
          >
            <Icon icon={appIcons.anglesLeft} />
          </button>
        )}
      </div>

      {/* Primary action — New item (composes on the browse surface) */}
      <div className="kp-sidebar-primary">
        <button
          type="button"
          className="kp-sidebar-new"
          onClick={() => navigate({ to: '/browse', search: { new: 'concept' } as any })}
          title="Create a new item"
          aria-label="Create a new item"
        >
          <span className="kp-sidebar-icon"><Icon icon={appIcons.plus} /></span>
          {!effectiveCollapsed && <span className="kp-sidebar-label">New item</span>}
        </button>
      </div>

      {/* Navigation Items (Top) */}
      <nav className="kp-sidebar-nav">
        {NAV_ITEMS.map((item) => {
          const active = isActive(item);
          return (
          <button
            key={item.id}
            className={`kp-sidebar-item ${active ? 'active' : ''}`}
            onClick={() => handleNavClick(item)}
            title={item.label}
            aria-label={item.label}
          >
            <span className="kp-sidebar-icon"><Icon icon={item.icon} /></span>
            {!effectiveCollapsed && <span className="kp-sidebar-label">{item.label}</span>}
          </button>
          );
        })}
      </nav>

      {/* Search Input (when expanded) */}
      {!effectiveCollapsed && (
        <div className="kp-sidebar-search">
          <input
            type="text"
            placeholder="Search..."
            value={searchQuery}
            onChange={(e) => {
              typing.current = true;
              setSearchQuery(e.target.value);
            }}
            className="kp-sidebar-search-input"
          />
        </div>
      )}

      {/* Bottom Navigation Items */}
      <nav className="kp-sidebar-footer">
        {BOTTOM_ITEMS.map((item) => {
          const active = currentPathname === item.route;
          return (
          <button
            key={item.id}
            className={`kp-sidebar-item ${active ? 'active' : ''}`}
            onClick={() => handleNavClick(item)}
            title={item.label}
            aria-label={item.label}
          >
            <span className="kp-sidebar-icon"><Icon icon={item.icon} /></span>
            {!effectiveCollapsed && <span className="kp-sidebar-label">{item.label}</span>}
          </button>
          );
        })}
      </nav>
    </aside>
  );
};
