/**
 * ContentTypeBadge — a small, color-coded chip identifying a concept's kind
 * (OKF `type`). Colors are keyed to the content-type *group* so related kinds
 * read as a family (Support = orange, Reference = sky, Publishing = pink, …).
 *
 * Self-resolves against the cached `GET /content-types` registry, so callers
 * pass only the raw `type` string (e.g. `page.type`). Unknown types still render
 * neutrally rather than disappearing — the badge is descriptive, not gating.
 */
import { useMemo } from 'react';
import { useContentTypes, type ContentType } from '../queries.js';
import { Icon, iconByKey } from '../icons.js';
import './ContentTypeBadge.css';

const GROUP_KEYS: Record<string, string> = {
  Reference: 'reference',
  Support: 'support',
  Operations: 'operations',
  Guides: 'guides',
  Decisions: 'decisions',
  Publishing: 'publishing',
};

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
  types: ContentType[],
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

export function useContentTypeMeta(type: string | null | undefined): ContentTypeMeta | null {
  const { data: types = [] } = useContentTypes();
  return useMemo(() => resolveContentTypeMeta(type, types), [type, types]);
}

export interface ContentTypeBadgeProps {
  type: string | null | undefined;
  size?: 'sm' | 'md';
  showIcon?: boolean;
}

export function ContentTypeBadge({ type, size = 'md', showIcon = true }: ContentTypeBadgeProps) {
  const meta = useContentTypeMeta(type);
  if (!meta) return null;
  return (
    <span className="kp-type-badge" data-group={meta.groupKey} data-size={size} title={`${meta.label} · ${meta.group}`}>
      {showIcon ? (
        <span className="kp-type-badge__icon" aria-hidden="true">
          <Icon icon={iconByKey(meta.icon)} fixedWidth={false} />
        </span>
      ) : null}
      <span className="kp-type-badge__label">{meta.label}</span>
    </span>
  );
}
