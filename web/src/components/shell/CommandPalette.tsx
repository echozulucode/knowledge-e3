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

export const COMMAND_PALETTE_SCOPE_HINT = 'Searches all Topics. Use browse filters for scoped search.';

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

  // Search for pages
  const { data: results = [] } = useSearch(debouncedQuery);

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
      const lastIndex = query.length === 0 ? 0 : Math.min(results.length, 8) - 1;
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
          } else if (query.length > 0 && results[selectedIndex]) {
            navigate({ to: `/p/${results[selectedIndex].slug}` });
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
            placeholder="Search knowledge — titles, tags, topics, decisions…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            autoFocus
            className="kp-palette-input"
          />
          {query.length > 0 ? (
            <span className="kp-palette-count">{Math.min(results.length, 8)} of {results.length}</span>
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
              <div className="kp-palette-empty">Type to search pages…</div>
            </>
          ) : results.length === 0 ? (
            <div className="kp-palette-empty">
              <div>No matches for '{query}'</div>
              <div>Try a broader term, a related acronym, or search by Topic, tag, category, group, command text, or decision wording.</div>
            </div>
          ) : (
            results.slice(0, 8).map((result, index) => (
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
