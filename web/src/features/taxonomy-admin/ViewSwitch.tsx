/**
 * ViewSwitch — the segmented `Tags (137) | Groups (8)` control
 * (the admin UX review §4.6), also Primary categories'
 * `Active | Archived`.
 *
 * WAI-ARIA tabs with automatic activation: one tab stop (the selected tab),
 * ArrowLeft/ArrowRight wrap, Home/End jump, and moving selects — each view is
 * one cheap table, so there is nothing to confirm before showing it. The
 * caller renders the matching `role="tabpanel"` with `id={panelId}` and
 * `aria-labelledby={tabId(value)}`; the view itself lives in the URL.
 */
import { useRef, type KeyboardEvent } from 'react';
import './ViewSwitch.css';

export interface ViewSwitchOption<V extends string> {
  value: V;
  label: string;
  /** Rendered as "(N)" after the label; omitted while unknown. */
  count?: number;
}

export interface ViewSwitchProps<V extends string> {
  /** Accessible name of the tablist, e.g. "Tags and groups views". */
  label: string;
  options: readonly ViewSwitchOption<V>[];
  value: V;
  onChange: (value: V) => void;
  /** Prefix for tab ids; the panel is `${idBase}-panel`. */
  idBase: string;
}

export const viewTabId = (idBase: string, value: string): string => `${idBase}-tab-${value}`;
export const viewPanelId = (idBase: string): string => `${idBase}-panel`;

export function ViewSwitch<V extends string>({ label, options, value, onChange, idBase }: ViewSwitchProps<V>): JSX.Element {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const current = options.findIndex((o) => o.value === value);
    let next = -1;
    if (event.key === 'ArrowRight') next = (current + 1) % options.length;
    else if (event.key === 'ArrowLeft') next = (current - 1 + options.length) % options.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = options.length - 1;
    if (next < 0) return;
    event.preventDefault();
    const option = options[next];
    if (!option) return;
    onChange(option.value);
    refs.current[next]?.focus();
  };

  return (
    <div className="kp-view-switch" role="tablist" aria-label={label} onKeyDown={onKeyDown}>
      {options.map((option, index) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            ref={(el) => {
              refs.current[index] = el;
            }}
            type="button"
            role="tab"
            id={viewTabId(idBase, option.value)}
            aria-selected={selected}
            aria-controls={viewPanelId(idBase)}
            tabIndex={selected ? 0 : -1}
            className="kp-view-switch__tab"
            onClick={() => onChange(option.value)}
          >
            {option.label}
            {option.count !== undefined ? <span className="kp-view-switch__count"> ({option.count.toLocaleString('en-US')})</span> : null}
          </button>
        );
      })}
    </div>
  );
}
