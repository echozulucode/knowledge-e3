/**
 * BacklinksPanel — responsive backlinks view for PageView
 *
 * Behavior: Collapsed by default at all viewports.
 * - Above 1280px: header button in rail; click to expand inline
 * - Below 1280px: button; click to open drawer modal
 *
 * Uses window.matchMedia to detect screen size and toggle between modes.
 * The drawer is built with <dialog> element and custom CSS for slide-in animation.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useBacklinks, type Backlink } from '../queries.js';
import './BacklinksPanel.css';

export interface BacklinksPanelProps {
  pageId: string;
  pageTitle: string;
}

export function BacklinksPanel({ pageId, pageTitle }: BacklinksPanelProps) {
  const { data: backlinks = [], isLoading } = useBacklinks(pageId);
  const [isLargeScreen, setIsLargeScreen] = useState(true);
  const [isExpanded, setIsExpanded] = useState(false); // Collapsed by default
  const dialogRef = useRef<HTMLDialogElement>(null);

  // Detect screen size changes
  useEffect(() => {
    const mediaQuery = window.matchMedia('(min-width: 1280px)');
    const handleChange = (e: MediaQueryListEvent) => {
      setIsLargeScreen(e.matches);
      // Close drawer/collapse if screen becomes large
      if (e.matches && isExpanded) {
        setIsExpanded(false);
      }
    };

    // Set initial value
    setIsLargeScreen(mediaQuery.matches);

    // Listen for changes
    mediaQuery.addEventListener('change', handleChange);
    return () => mediaQuery.removeEventListener('change', handleChange);
  }, [isExpanded]);

  // Sync drawer open state with dialog element
  useEffect(() => {
    if (isExpanded && !isLargeScreen && dialogRef.current) {
      dialogRef.current.showModal();
    } else if ((!isExpanded || isLargeScreen) && dialogRef.current && dialogRef.current.open) {
      dialogRef.current.close();
    }
  }, [isExpanded, isLargeScreen]);

  const handleDialogClose = useCallback(() => {
    setIsExpanded(false);
  }, []);

  const handleDialogClick = useCallback(
    (e: React.MouseEvent<HTMLDialogElement>) => {
      // Close on click outside the modal content
      if (e.target === dialogRef.current) {
        handleDialogClose();
      }
    },
    [handleDialogClose]
  );

  // Empty state: don't render if no backlinks
  if (backlinks.length === 0) {
    return null;
  }

  // Render backlinks list (only shown when expanded)
  const panelContent = (
    <div className="backlinks-panel-content">
      <div className="backlinks-header">
        <button
          className="backlinks-expand-button"
          onClick={() => setIsExpanded(!isExpanded)}
          aria-expanded={isExpanded}
        >
          <span className="backlinks-expand-label">Backlinks ({backlinks.length})</span>
          <span className={`backlinks-chevron ${isExpanded ? 'expanded' : ''}`}>▶︎</span>
        </button>
      </div>
      {isExpanded && (
        <div className="backlinks-list">
          {backlinks.map((backlink) => (
            <BacklinkCard key={`${backlink.source_item_id || backlink.source_page_id}`} backlink={backlink} />
          ))}
        </div>
      )}
    </div>
  );

  // Large screen: render as collapsible section in rail
  if (isLargeScreen) {
    return (
      <div className="backlinks-panel-container">
        {panelContent}
      </div>
    );
  }

  // Small screen: button + drawer modal
  return (
    <div className="backlinks-button-container">
      <button
        className="backlinks-button"
        onClick={() => setIsExpanded(true)}
      >
        <span className="backlinks-button-label">Backlinks ({backlinks.length})</span>
        <span className="backlinks-chevron">›</span>
      </button>
      <dialog
        ref={dialogRef}
        className="backlinks-drawer"
        onClick={handleDialogClick}
        onCancel={handleDialogClose}
      >
        <div className="backlinks-drawer-content">
          {panelContent}
        </div>
      </dialog>
    </div>
  );
}

interface BacklinkCardProps {
  backlink: Backlink;
}

function BacklinkCard({ backlink }: BacklinkCardProps) {
  const sourceSlug = backlink.source_item_slug || backlink.source_slug;
  const sourceTitle = backlink.source_item_title || backlink.source_title;

  return (
    <Link
      to="/p/$slug"
      params={{ slug: sourceSlug }}
      className="backlinks-card"
    >
      <div className="backlinks-card-title">
        {sourceTitle}
      </div>
      <div className="backlinks-card-snippet">
        {backlink.snippet}
      </div>
      <div className="backlinks-card-meta">
        <span className="backlinks-status-chip">Linked</span>
      </div>
    </Link>
  );
}
