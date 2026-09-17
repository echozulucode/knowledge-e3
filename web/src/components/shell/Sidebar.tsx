/**
 * Sidebar — collapsible left rail with navigation items
 * Collapsed: 56px (icons only)
 * Expanded: 240px (icons + labels)
 * Persists state to localStorage
 */

import React, { useMemo } from 'react';
import { useNavigate, useRouterState } from '@tanstack/react-router';
import { useReviewNavVisible } from '../../features/review/queries.js';
import { Icon, appIcons } from '../../icons.js';
import { SiteBrand } from './SiteBrand.js';
import { ThemeToggle } from './ThemeToggle.js';
import './Sidebar.css';

interface SidebarProps {
  collapsed: boolean;
  onToggleCollapsed: () => void;
  /** Mobile drawer open state (<= 860px). */
  mobileOpen?: boolean;
  /** Called when a nav action should dismiss the mobile drawer. */
  onMobileClose?: () => void;
}

/**
 * The durable destinations (§3.4): Home · Topics · Latest · Sections · Search.
 * Browse and Tags deliberately left this list — they are reachable from /search
 * and from a Topic landing, which keeps the rail short as the library grows.
 * Search is a route here — the /search page. There is one quick search: the
 * header's trigger, which opens the palette with recent searches (GlobalHeader,
 * Cmd+K). The rail used to carry a second search box that navigated to /search
 * as you typed; two search inputs for one index was one too many, so it went.
 */
const NAV_ITEMS = [
  { id: 'home', label: 'Home', icon: appIcons.house, route: '/' },
  { id: 'topics', label: 'Topics', icon: appIcons.bookOpen, route: '/topics' },
  { id: 'latest', label: 'Latest', icon: appIcons.clock, route: '/latest' },
  { id: 'sections', label: 'Sections', icon: appIcons.layerGroup, route: '/sections' },
  // Admin moved to the user dropdown (admin-only) in GlobalHeader.
  { id: 'search', label: 'Search', icon: appIcons.magnifyingGlass, route: '/search' },
] as const;

const BOTTOM_ITEMS = [
  { id: 'profile', label: 'Profile', icon: appIcons.user, route: '/profile' },
  { id: 'help', label: 'Help', icon: appIcons.fileLines, route: '/help' },
] as const;

/**
 * The review queue (plan §8.2) sits between Latest and Sections, but only for
 * the people it concerns: admins, and any author with an item in a change request.
 */
const REVIEW_ITEM = { id: 'review', label: 'Review', icon: appIcons.listCheck, route: '/review' } as const;

type NavItem = (typeof NAV_ITEMS)[number] | typeof REVIEW_ITEM | (typeof BOTTOM_ITEMS)[number];

export const Sidebar: React.FC<SidebarProps> = ({ collapsed, onToggleCollapsed, mobileOpen, onMobileClose }) => {
  const navigate = useNavigate();
  const currentSearch = useRouterState({ select: (s) => s.location.search as { q?: string } });
  const currentPathname = useRouterState({ select: (s) => s.location.pathname });
  const showReview = useReviewNavVisible();

  // "Review" is inserted rather than appended so the durable order stays
  // Home · Topics · Latest · Review · Sections · Search.
  const navItems = useMemo<NavItem[]>(() => {
    if (!showReview) return [...NAV_ITEMS];
    const at = NAV_ITEMS.findIndex((item) => item.id === 'sections');
    return at < 0 ? [...NAV_ITEMS, REVIEW_ITEM] : [...NAV_ITEMS.slice(0, at), REVIEW_ITEM, ...NAV_ITEMS.slice(at)];
  }, [showReview]);

  // Determine active route for each nav item.
  const isActive = (item: NavItem): boolean => {
    const route = item.route;
    if (route === '/') return currentPathname === '/';
    return currentPathname === route || currentPathname.startsWith(route + '/');
  };

  const handleNavClick = (item: NavItem) => {
    // Search keeps whatever query is already in the URL, so clicking it from a
    // result page reopens that search rather than blanking it.
    const search = item.route === '/search' && currentSearch.q ? { q: currentSearch.q } : undefined;
    navigate({ to: item.route as any, search: search as any });
    onMobileClose?.();
  };

  // On mobile the drawer always renders expanded content (labels),
  // regardless of the desktop collapse state.
  const effectiveCollapsed = mobileOpen ? false : collapsed;

  return (
    <aside className={`kp-sidebar ${effectiveCollapsed ? 'collapsed' : 'expanded'} ${mobileOpen ? 'open' : ''}`}>
      {/* Brand row — the logo toggles collapse (mock method); a collapse button
          sits at the end when expanded. Collapsed shows just the centered mark.
          Both come from `<SiteBrand>` (`GET /site`), so a company's own logo and
          name appear here without touching this file. */}
      <div className="kp-sidebar-brand">
        <button
          type="button"
          className="kp-sidebar-logo"
          onClick={onToggleCollapsed}
          title={effectiveCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          aria-label={effectiveCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          <SiteBrand variant="mark" logoClassName="kp-sidebar-logo-img" />
        </button>
        {!effectiveCollapsed && <SiteBrand variant="name" nameClassName="kp-sidebar-brandtitle" />}
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
        {navItems.map((item) => {
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
        {/* Phones only (Sidebar.css): the header hides its theme icon at that
            width to keep its controls on one line, so the setting lives here. The
            drawer is never collapsed, so the icon-only rail does not need it. */}
        {!effectiveCollapsed && <ThemeToggle variant="row" className="kp-sidebar-item kp-sidebar-theme" />}
      </nav>
    </aside>
  );
};
