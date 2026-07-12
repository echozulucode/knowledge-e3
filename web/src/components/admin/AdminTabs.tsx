/**
 * AdminTabs — the shared navigation shell for the admin console.
 *
 * Primary tabs (Overview · Users · Authentication · Taxonomy) sit at the top of
 * every /admin* page. The Taxonomy tab owns a secondary row (Topics · Categories
 * · Tags & groups) that only appears while a taxonomy page is active. Active
 * state is derived from the current path so each page just renders <AdminTabs />.
 */
import { Link, useRouterState } from '@tanstack/react-router';
import { Icon, appIcons } from '../../icons.js';
import './AdminTabs.css';

const TAXONOMY_PATHS = ['/admin/topics', '/admin/primary-categories', '/admin/tags-groups'];

const PRIMARY_TABS = [
  { to: '/admin', label: 'Overview', icon: appIcons.gaugeHigh, exact: true },
  { to: '/admin/users', label: 'Users', icon: appIcons.users, exact: false },
  { to: '/admin/auth', label: 'Authentication', icon: appIcons.shieldHalved, exact: false },
  { to: '/admin/topics', label: 'Taxonomy', icon: appIcons.layerGroup, exact: false, group: TAXONOMY_PATHS },
  { to: '/admin/data', label: 'Data', icon: appIcons.floppyDisk, exact: false },
  { to: '/admin/sections', label: 'Sections', icon: appIcons.list, exact: false },
  { to: '/admin/repos', label: 'Repos', icon: appIcons.sliders, exact: false },
  { to: '/admin/images', label: 'Images', icon: appIcons.image, exact: false },
] as const;

const TAXONOMY_TABS = [
  { to: '/admin/topics', label: 'Spaces' },
  { to: '/admin/primary-categories', label: 'Categories' },
  { to: '/admin/tags-groups', label: 'Tags & groups' },
] as const;

export function AdminTabs() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const onTaxonomy = TAXONOMY_PATHS.some((p) => pathname.startsWith(p));

  const isActive = (tab: (typeof PRIMARY_TABS)[number]): boolean => {
    if ('group' in tab && tab.group) return tab.group.some((p) => pathname.startsWith(p));
    return tab.exact ? pathname === tab.to : pathname.startsWith(tab.to);
  };

  return (
    <nav className="AdminTabs" aria-label="Admin sections">
      <div className="AdminTabs__row" role="tablist">
        {PRIMARY_TABS.map((tab) => (
          <Link
            key={tab.to}
            to={tab.to}
            className={`AdminTabs__tab${isActive(tab) ? ' AdminTabs__tab--active' : ''}`}
            aria-current={isActive(tab) ? 'page' : undefined}
          >
            <Icon icon={tab.icon} />
            <span>{tab.label}</span>
          </Link>
        ))}
      </div>
      {onTaxonomy && (
        <div className="AdminTabs__row AdminTabs__row--sub" role="tablist" aria-label="Taxonomy">
          {TAXONOMY_TABS.map((tab) => (
            <Link
              key={tab.to}
              to={tab.to}
              className={`AdminTabs__subtab${pathname.startsWith(tab.to) ? ' AdminTabs__subtab--active' : ''}`}
              aria-current={pathname.startsWith(tab.to) ? 'page' : undefined}
            >
              {tab.label}
            </Link>
          ))}
        </div>
      )}
    </nav>
  );
}
