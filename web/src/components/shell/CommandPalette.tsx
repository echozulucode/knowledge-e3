/**
 * CommandPalette — the header's quick search (Cmd+K / Ctrl+K, or the "Search…"
 * trigger and its mobile icon twin).
 *
 * Eric, 2026-09-12: "repurpose the Search in the top nav to be a quick search
 * that has an MRU". `/search` is the one full search surface; this is the fast
 * door to it:
 *
 *  - **Empty query** — the reader's recent searches (`useRecentSearches`), each
 *    one re-runnable or removable, then the keyboard-shortcuts entry.
 *  - **With a query** — "Search all results for ‘q’" first (and highlighted, so
 *    Enter hands the query to `/search`), then the server's grouped top matches,
 *    each of which still jumps straight to its item.
 *
 * Matches are marked in each row's title and snippet from the server's
 * `highlights` ranges (`SearchResultRow`), the same as on `/search`.
 *
 * A search is RECORDED when it is submitted to `/search` from here, or when a
 * result is opened here with a non-empty query. Typing alone never records —
 * half a word is not something anyone wants to repeat.
 */

import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useNavigate } from '@tanstack/react-router';
import type { SearchResult } from '../../queries.js';
import { NO_MATCHES_HINT } from '../../features/search/copy.js';
import { useGroupedSearch } from '../../features/search/queries.js';
import { displayStateForHit, flattenGroups, reviewUrlForHit } from '../../features/search/grouping.js';
import { SearchResultRow } from '../../features/search/SearchResultRow.js';
import { useRecentSearches } from '../../features/search/useRecentSearches.js';
import { Icon, appIcons } from '../../icons.js';
import './CommandPalette.css';

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  onOpenKeyboardHelp?: () => void;
}

/**
 * The palette and `/search` are two doors to ONE search, so they end in one
 * place (home plan R2.3). The hint used to send the reader to Browse, which is
 * a different list with different facets.
 */
export const COMMAND_PALETTE_SCOPE_HINT = 'Choose a result to jump straight to it, or press Enter to open every result in Search.';

/**
 * Hits requested per query. The server groups them by content type and caps
 * each group (5), so the palette shows a few rows per type and hands the rest
 * to /search via each group's "See all".
 */
const PALETTE_LIMIT = 25;

export const CommandPalette: React.FC<CommandPaletteProps> = ({ open, onClose, onOpenKeyboardHelp }) => {
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);
  const { searches: recentSearches, record: recordSearch, remove: removeRecent, clear: clearRecents } = useRecentSearches();

  // Remember what had focus BEFORE this open. It is read during render because
  // by the time any effect runs, the box's autoFocus has already moved focus.
  const openerRef = useRef<HTMLElement | null>(null);
  const wasOpenRef = useRef(false);
  if (open && !wasOpenRef.current && typeof document !== 'undefined') {
    openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  }
  wasOpenRef.current = open;

  const trimmed = query.trim();
  const hasQuery = trimmed.length > 0;

  // Debounce search query
  const [debouncedQuery, setDebouncedQuery] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query), 150);
    return () => clearTimeout(timer);
  }, [query]);

  // Every open starts on an empty box, so the recents are what the reader sees;
  // the list is the palette's memory now, not a half-typed query left behind.
  // Focus goes back to whatever opened the palette (the trigger, or the field
  // the reader was in when they pressed ⌘K).
  useEffect(() => {
    if (!open) return;
    return () => {
      setQuery('');
      setDebouncedQuery('');
      const opener = openerRef.current;
      openerRef.current = null;
      if (opener?.isConnected) opener.focus();
    };
  }, [open]);

  // The palette shows the server's grouped top matches (§3.5) and hands off to
  // /search for the rest.
  const { data: grouped } = useGroupedSearch(debouncedQuery, { limit: PALETTE_LIMIT });
  const groups = useMemo(() => (hasQuery ? (grouped?.groups ?? []) : []), [grouped, hasQuery]);
  const { flat: shown, starts: groupStarts } = useMemo(() => flattenGroups(groups), [groups]);
  // `total` is the server's real count over every match, so "top 5 of 412" is
  // now true where it used to cap silently at the page size.
  const total = grouped?.total ?? 0;
  const hasMore = total > shown.length;
  // Anything the parser could not honour is said here too, in one line: the
  // palette is a jump list, but it must not lie about what it searched.
  const warnings = hasQuery ? (grouped?.warnings ?? []) : [];

  /**
   * One flat, 0-based selection index over the rows in visual order, so the
   * highlighted row and the Enter target are always the same row:
   *   empty query → recents[0..n-1], then the keyboard-shortcuts row (n)
   *   with query  → "Search all results" (0), then results 1..shown.length
   */
  const lastIndex = hasQuery ? shown.length : recentSearches.length;
  const activeIndex = Math.min(selectedIndex, lastIndex);

  // Back to the top row whenever the rows underneath change.
  useEffect(() => {
    setSelectedIndex(0);
  }, [grouped, hasQuery]);

  /** Submit to the canonical results page — a search performed, so it is recorded. */
  const submitSearch = useCallback(
    (q: string, extra: { type?: string } = {}) => {
      const term = q.trim();
      if (!term) return;
      recordSearch(term);
      navigate({ to: '/search', search: { q: term, ...extra } as never });
      onClose();
    },
    [recordSearch, navigate, onClose],
  );

  /**
   * Focus one content type on the canonical results page. `/search` takes the
   * type by its label in the URL, exactly as its own facet chips write it
   * (`searchParams.ts`), so this lands on the chip already pressed.
   */
  const seeAllOfType = (label: string) => submitSearch(debouncedQuery, { type: label });

  const openResult = useCallback(
    (result: SearchResult) => {
      if (hasQuery) recordSearch(trimmed);
      navigate({ to: `/p/${result.slug}` });
      onClose();
    },
    [hasQuery, trimmed, recordSearch, navigate, onClose],
  );

  /** A recent search fills the box and runs at once — no debounce wait for a known query. */
  const runRecent = (entry: string) => {
    setQuery(entry);
    setDebouncedQuery(entry);
    inputRef.current?.focus();
  };

  const openKeyboardHelp = useCallback(() => {
    onOpenKeyboardHelp?.();
    onClose();
  }, [onOpenKeyboardHelp, onClose]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setSelectedIndex(activeIndex < lastIndex ? activeIndex + 1 : 0);
        break;
      case 'ArrowUp':
        e.preventDefault();
        setSelectedIndex(activeIndex > 0 ? activeIndex - 1 : lastIndex);
        break;
      case 'Enter': {
        e.preventDefault();
        if (hasQuery) {
          const result = activeIndex > 0 ? shown[activeIndex - 1] : undefined;
          if (result) openResult(result);
          else submitSearch(query);
        } else if (activeIndex < recentSearches.length) {
          runRecent(recentSearches[activeIndex]!);
        } else {
          openKeyboardHelp();
        }
        break;
      }
    }
  };

  // Escape closes from anywhere inside — the input, a remove button, a See all.
  const handleDialogKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };

  // Close on backdrop click
  const handleBackdropClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) {
      onClose();
    }
  };

  if (!open) return null;

  const recentCount = recentSearches.length;

  return (
    <div className="kp-palette-backdrop" onClick={handleBackdropClick}>
      <div className="kp-palette-modal" role="dialog" aria-modal="true" aria-label="Quick search" onKeyDown={handleDialogKeyDown}>
        {/* Search Input */}
        <div className="kp-palette-header">
          <span className="kp-palette-search-icon" aria-hidden="true">
            <Icon icon={appIcons.magnifyingGlass} fixedWidth={false} />
          </span>
          <input
            ref={inputRef}
            type="text"
            enterKeyHint="search"
            placeholder="Search titles, phrases, tags…"
            aria-label="Search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            autoFocus
            className="kp-palette-input"
          />
          {hasQuery ? (
            <span className="kp-palette-count">
              {hasMore ? `top ${shown.length} of ${total}` : `${shown.length} ${shown.length === 1 ? 'result' : 'results'}`}
            </span>
          ) : null}
          {/* A phone has no Escape key, and the palette is full-screen there. */}
          <button type="button" className="kp-palette-close" onClick={onClose}>
            Cancel
          </button>
        </div>

        {/* Results List */}
        <div className="kp-palette-results">
          {warnings.length > 0 ? (
            <div className="kp-palette-warnings" role="status">
              {warnings.map((warning) => (
                <div key={warning}>{warning}</div>
              ))}
            </div>
          ) : null}
          {!hasQuery ? (
            <>
              <div className="kp-palette-recents" role="group" aria-labelledby="kp-palette-recents-label">
                <div className="kp-palette-group-head">
                  <span id="kp-palette-recents-label" className="kp-palette-group-label">Recent searches</span>
                  {recentCount > 0 ? (
                    <button
                      type="button"
                      className="kp-palette-group-seeall"
                      onClick={() => {
                        clearRecents();
                        inputRef.current?.focus();
                      }}
                    >
                      Clear recent searches
                    </button>
                  ) : null}
                </div>
                {recentCount === 0 ? (
                  <div className="kp-palette-recents-empty">Searches you run appear here, so you can run them again.</div>
                ) : (
                  <ul className="kp-palette-recent-list" role="list">
                    {recentSearches.map((entry, index) => (
                      <li key={entry} className={`kp-palette-recent ${index === activeIndex ? 'selected' : ''}`}>
                        <button type="button" className="kp-palette-recent-run" onClick={() => runRecent(entry)}>
                          <Icon icon={appIcons.clockRotateLeft} fixedWidth={false} />
                          <span className="kp-palette-recent-text">{entry}</span>
                        </button>
                        {/* Removing the focused row would drop focus on the
                            floor; it returns to the box instead. */}
                        <button
                          type="button"
                          className="kp-palette-recent-remove"
                          aria-label={`Remove ${entry} from recent searches`}
                          title="Remove from recent searches"
                          onClick={() => {
                            removeRecent(entry);
                            inputRef.current?.focus();
                          }}
                        >
                          <Icon icon={appIcons.xmark} fixedWidth={false} />
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <button
                type="button"
                className={`kp-palette-item ${activeIndex === recentCount ? 'selected' : ''}`}
                onClick={openKeyboardHelp}
              >
                <div className="kp-palette-item-title">Keyboard shortcuts</div>
                <div className="kp-palette-item-meta">Cmd+?</div>
              </button>
              <div className="kp-palette-empty">{COMMAND_PALETTE_SCOPE_HINT}</div>
            </>
          ) : (
            <>
              {/* First, and highlighted by default: Enter in the box means
                  "search", and the row says so before the reader presses it. */}
              <button
                type="button"
                className={`kp-palette-seeall ${activeIndex === 0 ? 'selected' : ''}`}
                onClick={() => submitSearch(query)}
              >
                <Icon icon={appIcons.magnifyingGlass} fixedWidth={false} />
                <span>
                  Search all results for &lsquo;{trimmed}&rsquo;
                </span>
              </button>
              {debouncedQuery.trim() === trimmed && grouped && shown.length === 0 ? (
                <div className="kp-palette-empty">
                  <div>No quick matches for &lsquo;{trimmed}&rsquo;</div>
                  <div>{NO_MATCHES_HINT}</div>
                </div>
              ) : (
                groups.map((group, groupIndex) => (
                  <div key={group.key} className="kp-palette-group" role="group" aria-label={`${group.label} results`}>
                    <div className="kp-palette-group-head">
                      <span className="kp-palette-group-label">{group.label}</span>
                      <button
                        type="button"
                        className="kp-palette-group-seeall"
                        onClick={() => seeAllOfType(group.label)}
                        aria-label={`See all ${group.total} ${group.label} results`}
                      >
                        See all {group.total}
                      </button>
                    </div>
                    {group.hits.map((result, hitIndex) => {
                      const index = groupStarts[groupIndex]! + hitIndex + 1;
                      return (
                        <button
                          key={result.id}
                          type="button"
                          className={`kp-palette-item ${index === activeIndex ? 'selected' : ''}`}
                          onClick={() => openResult(result)}
                        >
                          {/* The same row as /search. No type chip: the group
                              heading above already names the type, and the line
                              repeats it as text. Why it matched is the snippet's
                              job, not a row of reason chips. */}
                          <SearchResultRow
                            title={result.title}
                            type={result.type}
                            displayState={displayStateForHit(result)}
                            reviewUrl={reviewUrlForHit(result)}
                            trustTier={result.trust_tier}
                            topic={result.topic}
                            snippet={result.snippet}
                            highlights={result.highlights}
                            snippetTruncated={result.snippet_truncated}
                            updatedAt={result.updated_at}
                            matchedFields={result.matched_fields}
                          />
                        </button>
                      );
                    })}
                  </div>
                ))
              )}
            </>
          )}
        </div>

        {/* Keyboard hint footer */}
        <div className="kp-palette-footer">
          <span><kbd>↑</kbd><kbd>↓</kbd> navigate</span>
          <span><kbd>↵</kbd> {hasQuery ? 'search or open' : 'run'}</span>
          <span><kbd>esc</kbd> close</span>
        </div>
      </div>
    </div>
  );
};
