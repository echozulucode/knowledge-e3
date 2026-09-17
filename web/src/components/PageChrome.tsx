/**
 * PageChrome — slim chrome bar at the top of the page view.
 *
 * Per user direction (Wave J followup):
 *   - No title here. Title is rendered in the hero at the top of the body.
 *   - No metadata block here. Metadata pills live alongside the title in body.
 *   - Just the breadcrumb on the left and one Edit pill on the right.
 *
 * There is a single Edit action and it opens Compose (`/p/:slug/edit`). The
 * Save/Cancel/dirty props this bar used to carry belonged to the inline editor
 * that Compose replaced, and went with it.
 */

import { Link } from '@tanstack/react-router';
import { Icon, appIcons } from '../icons.js';

interface PageChromeProps {
  slug: string;
  /** False for anonymous (public read) visitors and read-only sources. */
  canEdit?: boolean;
  onEdit: () => void;
}

export function PageChrome({ slug, canEdit = true, onEdit }: PageChromeProps) {
  return (
    <div
      className="kp-page-chrome"
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 'var(--kp-space-4)',
        padding: 'var(--kp-space-3) var(--kp-space-6)',
        background: 'var(--kp-surface-base)',
        borderBottom: '1px solid var(--kp-border-subtle)',
        minHeight: '44px',
      }}
    >
      {/* Breadcrumb — left */}
      <nav
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--kp-space-1)',
          fontSize: 'var(--kp-text-sm)',
          color: 'var(--kp-text-secondary)',
          minWidth: 0,
        }}
      >
        <Link
          to="/"
          style={{
            color: 'var(--kp-text-secondary)',
            textDecoration: 'none',
            transition: 'color var(--kp-duration) var(--kp-ease)',
          }}
        >
          Pages
        </Link>
        <span style={{ color: 'var(--kp-text-muted)' }}>/</span>
        <span
          style={{
            color: 'var(--kp-text-primary)',
            fontWeight: 'var(--kp-weight-medium)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {slug}
        </span>
      </nav>

      {/* Action pill — right */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--kp-space-2)' }}>
        {canEdit && (
          <button onClick={onEdit} aria-label="Edit page" style={accentPillStyle} title="Edit">
            <Icon icon={appIcons.pencil} />
            <span className="kp-action-label">Edit</span>
          </button>
        )}
      </div>
    </div>
  );
}

const basePillStyle: React.CSSProperties = {
  height: '32px',
  padding: '0 14px',
  borderRadius: 'var(--kp-radius-pill)',
  fontFamily: 'var(--kp-font-ui)',
  fontSize: 'var(--kp-text-sm)',
  fontWeight: 'var(--kp-weight-semibold)',
  cursor: 'pointer',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: '6px',
  whiteSpace: 'nowrap',
  transition: 'background-color var(--kp-duration) var(--kp-ease), color var(--kp-duration) var(--kp-ease)',
};

const accentPillStyle: React.CSSProperties = {
  ...basePillStyle,
  background: 'var(--kp-accent)',
  color: 'var(--kp-accent-fg)',
  border: '1px solid var(--kp-accent)',
};
