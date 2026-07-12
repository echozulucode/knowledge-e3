/**
 * RightContextPane — the Obsidian/VS Code-style secondary sidebar for reading
 * pages (goals doc §4). Flush-right, full-height, muted; scrolls independently
 * from the article. Tabs: TOC (default) · Properties · Tags. Collapses to a
 * narrow icon strip.
 */
import { useState, type ReactNode } from 'react';
import { Icon, appIcons } from '../icons.js';
import './RightContextPane.css';

export interface TocEntry {
  depth: number;
  text: string;
  id: string;
}

export interface PaneProperty {
  label: string;
  value: ReactNode;
  mono?: boolean;
}

export interface RightContextPaneProps {
  toc: TocEntry[];
  properties: PaneProperty[];
  tags: string[];
  onScrollTo: (id: string) => void;
  onTagClick?: (tag: string) => void;
  /** Related/backlinks content rendered under the Tags tab. */
  relatedSlot?: ReactNode;
  /** Collapsed state is owned by the parent so the reading grid can shrink. */
  collapsed: boolean;
  onToggleCollapsed: () => void;
}

type PaneTab = 'toc' | 'props' | 'tags';

export function RightContextPane({ toc, properties, tags, onScrollTo, onTagClick, relatedSlot, collapsed, onToggleCollapsed }: RightContextPaneProps) {
  const [tab, setTab] = useState<PaneTab>('toc');

  const tabs: { id: PaneTab; label: string; icon: typeof appIcons.list }[] = [
    { id: 'toc', label: 'On this page', icon: appIcons.list },
    { id: 'props', label: 'Properties', icon: appIcons.fileLines },
    { id: 'tags', label: 'Tags', icon: appIcons.tag },
  ];

  if (collapsed) {
    return (
      <div className="kp-ctx kp-ctx--collapsed">
        <button type="button" className="kp-ctx-tab kp-ctx-expand" onClick={onToggleCollapsed} title="Expand context pane" aria-label="Expand context pane">
          <Icon icon={appIcons.anglesLeft} fixedWidth={false} />
        </button>
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            className="kp-ctx-tab"
            onClick={() => { setTab(t.id); onToggleCollapsed(); }}
            title={t.label}
            aria-label={t.label}
          >
            <Icon icon={t.icon} fixedWidth={false} />
          </button>
        ))}
      </div>
    );
  }

  return (
    <div className="kp-ctx">
      <div className="kp-ctx-tabs" role="tablist" aria-label="Context pane">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            className={`kp-ctx-tab ${tab === t.id ? 'active' : ''}`}
            onClick={() => setTab(t.id)}
          >
            <Icon icon={t.icon} fixedWidth={false} />
            <span>{t.label === 'On this page' ? 'TOC' : t.label}</span>
          </button>
        ))}
        <button type="button" className="kp-ctx-tab kp-ctx-collapse" onClick={onToggleCollapsed} title="Collapse context pane" aria-label="Collapse context pane">
          <Icon icon={appIcons.anglesRight} fixedWidth={false} />
        </button>
      </div>

      <div className="kp-ctx-body">
        {tab === 'toc' && (
          <>
            <h2 className="kp-ctx-title">On this page</h2>
            {toc.length === 0 ? (
              <p className="kp-ctx-empty">No sections.</p>
            ) : (
              <nav className="kp-ctx-toc">
                {toc.map((e, i) => (
                  <button
                    key={`${e.id}-${i}`}
                    type="button"
                    className={`kp-ctx-toc-link depth-${Math.min(e.depth, 3)}`}
                    onClick={() => onScrollTo(e.id)}
                  >
                    {e.text}
                  </button>
                ))}
              </nav>
            )}
          </>
        )}

        {tab === 'props' && (
          <>
            <h2 className="kp-ctx-title">Object properties</h2>
            <dl className="kp-ctx-props">
              {properties.map((p, i) => (
                <div className="kp-ctx-prop" key={`${p.label}-${i}`}>
                  <dt>{p.label}</dt>
                  <dd className={p.mono ? 'mono' : undefined}>{p.value}</dd>
                </div>
              ))}
            </dl>
          </>
        )}

        {tab === 'tags' && (
          <>
            <h2 className="kp-ctx-title">Tags &amp; links</h2>
            {tags.length ? (
              <div className="kp-ctx-tags">
                {tags.map((t) => (
                  <button key={t} type="button" className="kp-ctx-tag" onClick={() => onTagClick?.(t)}>
                    {t}
                  </button>
                ))}
              </div>
            ) : (
              <p className="kp-ctx-empty">No tags.</p>
            )}
            {relatedSlot ? <div className="kp-ctx-related">{relatedSlot}</div> : null}
          </>
        )}
      </div>
    </div>
  );
}
