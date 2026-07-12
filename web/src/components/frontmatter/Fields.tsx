/**
 * FrontmatterStripFields — renders the metadata fields in the strip.
 * Each field is text by default; clicking swaps to edit mode with contextual control.
 */

import { StatusPopover } from './StatusPopover.js';
import { TagsEditor } from './TagsEditor.js';

interface FieldsProps {
  frontmatter: Record<string, unknown>;
  editingField: string | null;
  onFieldClick: (field: string) => void;
  onTitleCommit: (title: string) => void;
  onStatusSelect: (status: 'draft' | 'published') => void;
  onTagsCommit: (tags: string[]) => void;
  onOwnerCommit: (owner: string) => void;
  onTypeCommit: (type: string) => void;
  onCancel: () => void;
  fieldError?: string | null;
  disabled?: boolean;
}

export function FrontmatterStripFields({
  frontmatter,
  editingField,
  onFieldClick,
  onTitleCommit,
  onStatusSelect,
  onTagsCommit,
  onOwnerCommit,
  onTypeCommit,
  onCancel,
  fieldError,
  disabled = false,
}: FieldsProps) {
  const title = (frontmatter.title as string) || 'Untitled';
  const status = (frontmatter.status as string) || 'draft';
  const tags = (frontmatter.tags as string[]) || [];
  const owner = (frontmatter.owner as string) || null;
  const type = (frontmatter.type as string) || null;
  const updatedAt = (frontmatter.updated_at as string) || null;

  const statusIcon = status === 'published' ? '🟢' : '⚫';
  const tagsLabel = tags.length > 0 ? tags.join(', ') : '';

  return (
    <div className="flex items-center gap-4 flex-wrap min-w-0">
      {/* Title (field) */}
      {editingField === 'title' ? (
        <input
          autoFocus
          type="text"
          defaultValue={title}
          placeholder="Title"
          onBlur={(e) => {
            onTitleCommit(e.currentTarget.value);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              onTitleCommit(e.currentTarget.value);
            } else if (e.key === 'Escape') {
              onCancel();
            }
          }}
          className="px-2 py-1 text-sm border border-slate-300 rounded bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 min-w-0"
          disabled={disabled}
        />
      ) : (
        <div
          onClick={() => !disabled && onFieldClick('title')}
          className={`text-sm font-medium text-slate-900 cursor-pointer hover:bg-slate-100 px-2 py-1 rounded transition ${
            disabled ? 'cursor-default' : ''
          }`}
          title="Click to edit title"
        >
          {title}
        </div>
      )}

      {/* Status popover */}
      {editingField === 'status' ? (
        <div className="relative inline-block">
          <div className="flex items-center gap-1 text-sm text-slate-600 px-2 py-1 rounded bg-slate-100">
            <span>{statusIcon}</span>
            <span className="capitalize">{status}</span>
          </div>
          <StatusPopover
            currentStatus={status as 'draft' | 'published'}
            onSelect={onStatusSelect}
            onClose={onCancel}
          />
        </div>
      ) : (
        <div
          onClick={() => !disabled && onFieldClick('status')}
          className={`flex items-center gap-1 text-sm text-slate-600 cursor-pointer hover:bg-slate-100 px-2 py-1 rounded transition ${
            disabled ? 'cursor-default' : ''
          }`}
          title="Click to edit status"
        >
          <span>{statusIcon}</span>
          <span className="capitalize">{status}</span>
        </div>
      )}

      {/* Tags */}
      {editingField === 'tags' ? (
        <TagsEditor
          tags={tags}
          onCommit={onTagsCommit}
          onCancel={onCancel}
          disabled={disabled}
        />
      ) : (
        <div
          onClick={() => !disabled && onFieldClick('tags')}
          className={`flex items-center gap-1 text-sm text-slate-600 cursor-pointer hover:bg-slate-100 px-2 py-1 rounded transition ${
            disabled ? 'cursor-default' : ''
          }`}
          title="Click to edit tags"
        >
          {tagsLabel ? (
            <>
              <span>🏷</span>
              <span className="truncate">{tagsLabel}</span>
            </>
          ) : (
            <>
              <span>🏷</span>
              <span className="text-slate-400">(none)</span>
            </>
          )}
        </div>
      )}

      {/* Type (section / OKF concept kind) */}
      {editingField === 'type' ? (
        <input
          autoFocus
          type="text"
          defaultValue={type || ''}
          placeholder="type (e.g. blog, faq)"
          onBlur={(e) => onTypeCommit(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onTypeCommit(e.currentTarget.value);
            else if (e.key === 'Escape') onCancel();
          }}
          className="px-2 py-1 text-sm border border-slate-300 rounded bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 min-w-0"
          disabled={disabled}
        />
      ) : (
        <div
          onClick={() => !disabled && onFieldClick('type')}
          className={`flex items-center gap-1 text-sm text-slate-600 cursor-pointer hover:bg-slate-100 px-2 py-1 rounded transition ${
            disabled ? 'cursor-default' : ''
          }`}
          title="Click to edit type (section)"
        >
          <span>📑</span>
          {type ? <span className="truncate">{type}</span> : <span className="text-slate-400">(type)</span>}
        </div>
      )}

      {/* Owner */}
      {editingField === 'owner' ? (
        <input
          autoFocus
          type="text"
          defaultValue={owner || ''}
          placeholder="owner"
          onBlur={(e) => {
            onOwnerCommit(e.currentTarget.value);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              onOwnerCommit(e.currentTarget.value);
            } else if (e.key === 'Escape') {
              onCancel();
            }
          }}
          className="px-2 py-1 text-sm border border-slate-300 rounded bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 min-w-0"
          disabled={disabled}
        />
      ) : owner ? (
        <div
          onClick={() => !disabled && onFieldClick('owner')}
          className={`flex items-center gap-1 text-sm text-slate-600 cursor-pointer hover:bg-slate-100 px-2 py-1 rounded transition ${
            disabled ? 'cursor-default' : ''
          }`}
          title="Click to edit owner"
        >
          <span>👤</span>
          <span>{owner}</span>
        </div>
      ) : null}

      {/* Updated timestamp */}
      {updatedAt && (
        <div className="flex items-center gap-1 text-xs text-slate-500 ml-auto">
          <span>📅</span>
          <span>{formatRelativeDate(updatedAt)}</span>
        </div>
      )}

      {/* Error inline if present */}
      {fieldError && (
        <div className="text-xs text-red-600 font-medium">{fieldError}</div>
      )}
    </div>
  );
}

function formatRelativeDate(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays === 0) return 'today';
  if (diffDays === 1) return 'yesterday';
  if (diffDays < 7) return `${diffDays}d ago`;
  if (diffDays < 30) return `${Math.floor(diffDays / 7)}w ago`;
  if (diffDays < 365) return `${Math.floor(diffDays / 30)}mo ago`;
  return `${Math.floor(diffDays / 365)}y ago`;
}
