/**
 * CommandPalette — Cmd+K modal for searching and navigating pages
 * Triggered via Cmd+K (Mac) / Ctrl+K (Win/Linux) or clicking the search pill
 */

import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useSearch } from '../../queries.js';
import { ContentTypeBadge } from '../ContentTypeBadge.js';
import { Icon, appIcons } from '../../icons.js';
import './CommandPalette.css';

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  onOpenKeyboardHelp?: () => void;
}

export const COMMAND_PALETTE_SCOPE_HINT = 'Jump to a page — or open the full results in Browse.';

/** Rows the palette renders before deferring to the full results page. */
const PALETTE_LIMIT = 8;

export const CommandPalette: React.FC<CommandPaletteProps> = ({ open, onClose, onOpenKeyboardHelp }) => {
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const navigate = useNavigate();

  // Debounce search query
  const [debouncedQuery, setDebouncedQuery] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query), 150);
    return () => clearTimeout(timer);
  }, [query]);

  // The palette shows the top few matches and hands off to /browse for the rest.
  // Ask for one more than we render so "N+ results" can be honest without
  // implying a total we never requested.
  const { data: results = [] } = useSearch(debouncedQuery, { limit: PALETTE_LIMIT + 1 });
  const shown = results.slice(0, PALETTE_LIMIT);
  const hasMore = results.length > PALETTE_LIMIT;

  /** Hand the query to the canonical results page — the palette is a jump list. */
  const seeAllResults = () => {
    navigate({ to: '/browse', search: { view: 'grouped', q: debouncedQuery } as any });
    onClose();
  };

  // Reset selection when results change
  useEffect(() => {
    setSelectedIndex(0);
  }, [results]);

  // Handle keyboard navigation
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      // selectedIndex is a 0-based index into the visible results (or the lone
      // keyboard-shortcuts row when the query is empty). At most 8 results are
      // shown, so navigation and Enter both operate on that same 0..lastIndex
      // range — keeping the highlighted row and the Enter target identical.
      const lastIndex = query.length === 0 ? 0 : shown.length - 1;
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          setSelectedIndex((prev) => (prev < lastIndex ? prev + 1 : 0));
          break;
        case 'ArrowUp':
          e.preventDefault();
          setSelectedIndex((prev) => (prev > 0 ? prev - 1 : Math.max(lastIndex, 0)));
          break;
        case 'Enter':
          e.preventDefault();
          if (query.length === 0 && selectedIndex === 0) {
            // Keyboard shortcuts row
            onOpenKeyboardHelp?.();
            onClose();
          } else if (query.length > 0 && shown[selectedIndex]) {
            navigate({ to: `/p/${shown[selectedIndex].slug}` });
            onClose();
          }
          break;
        case 'Escape':
          e.preventDefault();
          onClose();
          break;
      }
    },
    [query, results, selectedIndex, navigate, onClose, onOpenKeyboardHelp]
  );

  // Close on backdrop click
  const handleBackdropClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) {
      onClose();
    }
  };

  if (!open) return null;

  return (
    <div className="kp-palette-backdrop" onClick={handleBackdropClick}>
      <div className="kp-palette-modal">
        {/* Search Input */}
        <div className="kp-palette-header">
          <span className="kp-palette-search-icon" aria-hidden="true">
            <Icon icon={appIcons.magnifyingGlass} fixedWidth={false} />
          </span>
          <input
            type="text"
            placeholder="Jump to a page — start typing a title…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            autoFocus
            className="kp-palette-input"
          />
          {query.length > 0 ? (
            <span className="kp-palette-count">
              {hasMore ? `top ${PALETTE_LIMIT}` : `${shown.length} ${shown.length === 1 ? 'result' : 'results'}`}
            </span>
          ) : null}
        </div>

        {/* Results List */}
        <div className="kp-palette-results">
          <div className="kp-palette-empty">{COMMAND_PALETTE_SCOPE_HINT}</div>
          {query.length === 0 ? (
            <>
              {/* Show keyboard shortcuts row when palette first opens */}
              <button
                className={`kp-palette-item ${selectedIndex === 0 ? 'selected' : ''}`}
                onClick={() => {
                  onOpenKeyboardHelp?.();
                  onClose();
                }}
              >
                <div className="kp-palette-item-title">Keyboard shortcuts</div>
                <div className="kp-palette-item-meta">Cmd+?</div>
              </button>
              {/* Then show search hint */}
              <div className="kp-palette-empty">Type to jump to a page…</div>
            </>
          ) : results.length === 0 ? (
            <div className="kp-palette-empty">
              <div>No matches for '{query}'</div>
              <div>Try a broader term, a related acronym, or search by Topic, tag, category, group, command text, or decision wording.</div>
              <button type="button" className="kp-palette-seeall" onClick={seeAllResults}>
                Search all items for '{query}'
              </button>
            </div>
          ) : (
            shown.map((result, index) => (
              <button
                key={result.id}
                className={`kp-palette-item ${index === selectedIndex ? 'selected' : ''}`}
                onClick={() => {
                  navigate({ to: `/p/${result.slug}` });
                  onClose();
                }}
              >
                <div className="kp-palette-item-row">
                  <span className="kp-palette-item-title">{result.title}</span>
                  {result.type ? <ContentTypeBadge type={result.type} size="sm" /> : null}
                </div>
                {result.snippet ? (
                  <div className="kp-palette-item-snippet">{result.snippet}</div>
                ) : null}
                <div className="kp-palette-item-meta">
                  {result.topic ? <span className="kp-palette-tag">{result.topic}</span> : null}
                  {result.status ? (
                    <span className={`kp-palette-status kp-palette-status--${result.status}`}>
                      {result.status === 'published' ? 'Published' : 'Draft'}
                    </span>
                  ) : null}
                  {result.reasons && result.reasons.length > 0
                    ? result.reasons.slice(0, 2).map((r) => (
                        <span key={r} className="kp-palette-reason">{r}</span>
                      ))
                    : null}
                  {result.updated_at ? (
                    <span className="kp-palette-updated">Updated {new Date(result.updated_at).toLocaleDateString()}</span>
                  ) : null}
                </div>
              </button>
            ))
          )}
          {query.length > 0 && shown.length > 0 ? (
            <button type="button" className="kp-palette-seeall" onClick={seeAllResults}>
              {hasMore ? `See all results for '${query}'` : `Open '${query}' in Browse`}
            </button>
          ) : null}
        </div>

        {/* Keyboard hint footer */}
        <div className="kp-palette-footer">
          <span><kbd>↑</kbd><kbd>↓</kbd> navigate</span>
          <span><kbd>↵</kbd> open</span>
          <span><kbd>esc</kbd> close</span>
        </div>
      </div>
    </div>
  );
};
