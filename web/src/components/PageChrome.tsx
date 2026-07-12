/**
 * PageChrome — slim chrome bar at the top of the page view.
 *
 * Per user direction (Wave J followup):
 *   - No title here. Title is rendered inline at the top of the editor body.
 *   - No metadata block here. Metadata pills live alongside the title in body.
 *   - Just breadcrumb on the left and an Edit/Save pill on the right.
 *
 * Pill on the right:
 *   - Read mode: Edit pencil
 *   - Edit mode: Save (primary) + Cancel (ghost)
 *
 * Props are kept compatible with the old API so PageView doesn't need to change
 * its prop list. Most are now no-ops / unused (kept for stable signature).
 */

import { Link } from '@tanstack/react-router';
import { Icon, appIcons } from '../icons.js';

interface PageChromeProps {
  pageTitle: string;            // unused now (kept for API stability)
  slug: string;
  isEditing: boolean;
  canEdit?: boolean;            // false for anonymous (public read) visitors
  onEnterEditMode: () => void;
  onSave: () => void;
  onCancel: () => void;
  onTitleChange?: (newTitle: string) => void;  // unused; title moved to body
  isSaving?: boolean;
  updatedAt?: string;           // unused; metadata moved to body
  status?: 'draft' | 'published';  // unused
  showHistory?: boolean;
  onHistory?: () => void;
  isDirty?: boolean;            // visual dirty indicator
}

export function PageChrome({
  slug,
  isEditing,
  canEdit = true,
  onEnterEditMode,
  isSaving = false,
  showHistory = true,
  onHistory,
  isDirty = false,
}: PageChromeProps) {
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
        {isDirty && (
          <span
            className="page-chrome-dirty-dot"
            style={{
              display: 'inline-block',
              width: '8px',
              height: '8px',
              borderRadius: '50%',
              background: 'var(--kp-accent)',
              marginRight: 'var(--kp-space-2)',
              verticalAlign: 'middle',
            }}
            aria-label="Unsaved changes"
            title="Unsaved changes"
          />
        )}
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

      {/* Action pill(s) — right */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--kp-space-2)' }}>
        {!isEditing ? (
          <>
            {canEdit && showHistory && onHistory && (
              <button
                onClick={onHistory}
                aria-label="History"
                style={ghostPillStyle}
                title="History"
              >
              <>
                <Icon icon={appIcons.clockRotateLeft} />
                <span className="kp-action-label">History</span>
              </>
              </button>
            )}
            {canEdit && (
              <button
                onClick={onEnterEditMode}
                aria-label="Edit page"
                style={accentPillStyle}
                title="Edit (E)"
              >
                <Icon icon={appIcons.pencil} />
                <span className="kp-action-label">Edit</span>
              </button>
            )}
          </>
        ) : (
          <span
            aria-live="polite"
            style={{
              color: 'var(--kp-text-secondary)',
              fontSize: 'var(--kp-text-sm)',
              fontWeight: 'var(--kp-weight-medium)',
            }}
          >
            {isSaving ? 'Saving…' : isDirty ? 'Unsaved changes' : 'Editing'}
          </span>
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

const ghostPillStyle: React.CSSProperties = {
  ...basePillStyle,
  background: 'transparent',
  color: 'var(--kp-text-secondary)',
  border: '1px solid var(--kp-border-subtle)',
};
