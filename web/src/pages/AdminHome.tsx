import { Link } from '@tanstack/react-router';
import { Icon, appIcons } from '../icons.js';
import { AdminTabs } from '../components/admin/AdminTabs.js';
import './AdminHome.css';

const ADMIN_SECTIONS = [
  {
    title: 'Users',
    description: 'Invite and manage accounts, assign roles, disable access, and reset passwords.',
    to: '/admin/users',
    action: 'Manage users',
    icon: appIcons.users,
  },
  {
    title: 'Authentication',
    description: 'Configure how people sign in — local password policy, SSO (OIDC/SAML), and LDAP.',
    to: '/admin/auth',
    action: 'Configure authentication',
    icon: appIcons.shieldHalved,
  },
  {
    title: 'Spaces',
    description: 'Create and review the space catalog used to organize items.',
    to: '/admin/topics',
    action: 'Manage spaces',
    icon: appIcons.layerGroup,
  },
  {
    title: 'Primary categories',
    description: 'Review and manage the primary category catalog used by item metadata.',
    to: '/admin/primary-categories',
    action: 'Manage primary categories',
    icon: appIcons.layerGroup,
  },
  {
    title: 'Tags and groups',
    description: 'Review tag usage, create global or Space-scoped groups, and expose picker values to item editing.',
    to: '/admin/tags-groups',
    action: 'Manage tags and groups',
    icon: appIcons.tag,
  },
] as const;

export function AdminHome() {
  return (
    <main className="AdminHome" aria-labelledby="admin-home-title">
      <AdminTabs />
      <section className="AdminHome__hero">
        <div className="AdminHome__eyebrow">
          <Icon icon={appIcons.gear} />
          <span>Admin</span>
        </div>
        <h1 id="admin-home-title">Admin console</h1>
        <p>
          System-wide configuration lives here — users, authentication, and the taxonomy catalog. Personal preferences
          (theme, account, sessions) live in your <Link to="/profile">profile</Link>.
        </p>
      </section>

      <section className="AdminHome__grid" aria-label="Admin sections">
        {ADMIN_SECTIONS.map((section) => (
          <Link key={section.to} to={section.to} className="AdminHome__card">
            <span className="AdminHome__cardIcon" aria-hidden="true">
              <Icon icon={section.icon} />
            </span>
            <span className="AdminHome__cardText">
              <strong>{section.title}</strong>
              <span>{section.description}</span>
            </span>
            <span className="AdminHome__cardAction">{section.action}</span>
          </Link>
        ))}
      </section>
    </main>
  );
}
