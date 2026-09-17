/**
 * ContentTypeBadge — a small, color-coded chip identifying a concept's kind
 * (OKF `type`). Colors are keyed to the content-type *group* so related kinds
 * read as a family (Support = orange, Reference = sky, Publishing = pink, …).
 *
 * Resolves against the content-type registry supplied by the nearest
 * `ContentTypesProvider` (the app fetches `GET /content-types` and hands the
 * list down — this package never talks to the API), so callers pass only the
 * raw `type` string (e.g. `page.type`). Unknown types still render neutrally
 * rather than disappearing — the badge is descriptive, not gating.
 */
import { createContext, useContext, useMemo, type ReactNode } from 'react';

const GROUP_KEYS: Record<string, string> = {
  Reference: 'reference',
  Support: 'support',
  Operations: 'operations',
  Guides: 'guides',
  Decisions: 'decisions',
  Publishing: 'publishing',
};

/** The slice of a registry entry the badge needs (structurally matches `GET /content-types`). */
export interface ContentTypeEntry {
  key: string;
  label: string;
  group: string;
  icon: string;
}

export interface ContentTypeMeta {
  label: string;
  group: string;
  groupKey: string;
  icon: string;
}

function slugifyType(value: string): string {
  return value.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

export function resolveContentTypeMeta(
  type: string | null | undefined,
  types: ContentTypeEntry[],
): ContentTypeMeta | null {
  if (!type || !type.trim()) return null;
  const trimmed = type.trim();
  const match = types.find(
    (t) => t.label.toLowerCase() === trimmed.toLowerCase() || t.key === slugifyType(trimmed),
  );
  if (match) {
    return { label: match.label, group: match.group, groupKey: GROUP_KEYS[match.group] ?? 'default', icon: match.icon };
  }
  return { label: trimmed, group: 'Other', groupKey: 'default', icon: 'tag' };
}

interface ContentTypesContextValue {
  types: ContentTypeEntry[];
  /** Maps a registry `icon` key to a glyph. Absent = badges render without an icon. */
  renderIcon?: (iconKey: string) => ReactNode;
}

const ContentTypesContext = createContext<ContentTypesContextValue>({ types: [] });

export interface ContentTypesProviderProps extends ContentTypesContextValue {
  children?: ReactNode;
}

export function ContentTypesProvider({ types, renderIcon, children }: ContentTypesProviderProps) {
  const value = useMemo(() => ({ types, renderIcon }), [types, renderIcon]);
  return <ContentTypesContext.Provider value={value}>{children}</ContentTypesContext.Provider>;
}

export function useContentTypeMeta(type: string | null | undefined): ContentTypeMeta | null {
  const { types } = useContext(ContentTypesContext);
  return useMemo(() => resolveContentTypeMeta(type, types), [type, types]);
}

export interface ContentTypeBadgeProps {
  type: string | null | undefined;
  size?: 'sm' | 'md';
  showIcon?: boolean;
}

export function ContentTypeBadge({ type, size = 'md', showIcon = true }: ContentTypeBadgeProps) {
  const { renderIcon } = useContext(ContentTypesContext);
  const meta = useContentTypeMeta(type);
  if (!meta) return null;
  return (
    <span className="kp-type-badge" data-group={meta.groupKey} data-size={size} title={`${meta.label} · ${meta.group}`}>
      {showIcon && renderIcon ? (
        <span className="kp-type-badge__icon" aria-hidden="true">
          {renderIcon(meta.icon)}
        </span>
      ) : null}
      <span className="kp-type-badge__label">{meta.label}</span>
    </span>
  );
}
