/**
 * FrontmatterStrip — Confluence-style metadata strip (Style B).
 *
 * Displays frontmatter as a thin, metadata-styled strip above the body editor.
 * Each field is shown as text by default; clicking enters inline edit mode with
 * the appropriate control (text input, popover, chip editor, etc.).
 *
 * Contract:
 * - Renders outside the center body column (above it)
 * - NEVER looks like a form; always a strip
 * - Click-to-edit per field with contextual control
 * - "Show YAML" toggle reveals raw YAML; editing preserves unknown keys
 * - Validation: title 1–500 chars; status ∈ {draft, published}
 * - onTitleRename callback routes through RenameDialog if backlinks exist
 */

import { useState, useEffect } from 'react';
import { stringify, parse as parseYaml } from 'yaml';
import { FrontmatterStripFields } from './frontmatter/Fields.js';
import { YamlEditor } from './frontmatter/YamlEditor.js';

export interface FrontmatterStripProps {
  frontmatter: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
  disabled?: boolean;
  onTitleRename?: (newTitle: string) => Promise<void>;
  showYamlToggle?: boolean;
}

const AUTO_MAINTAINED_FIELDS = ['created_at', 'updated_at', 'authors', 'slug'];

export function FrontmatterStrip({
  frontmatter,
  onChange,
  disabled = false,
  onTitleRename,
  showYamlToggle = true,
}: FrontmatterStripProps) {
  // Editing state
  const [editingField, setEditingField] = useState<string | null>(null);
  const [showYaml, setShowYaml] = useState(false);
  const [rawYaml, setRawYaml] = useState(() => stringify(frontmatter));
  const [yamlError, setYamlError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);

  // Update rawYaml when frontmatter changes externally
  useEffect(() => {
    if (!showYaml) {
      setRawYaml(stringify(frontmatter));
    }
  }, [frontmatter, showYaml]);

  // Field editing: title, status, tags, owner
  const handleFieldChange = (field: string, value: any) => {
    setFieldError(null);

    // Validate based on field type
    if (field === 'title' && typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed.length === 0) {
        setFieldError('Title cannot be empty');
        return;
      }
      if (trimmed.length > 500) {
        setFieldError('Title cannot exceed 500 characters');
        return;
      }
    }

    if (field === 'status' && !['draft', 'published'].includes(value)) {
      setFieldError('Status must be "draft" or "published"');
      return;
    }

    const updated = { ...frontmatter, [field]: value };
    onChange(updated);

    // If it's a title change, call onTitleRename callback
    if (field === 'title' && onTitleRename) {
      onTitleRename(value).catch((err) => {
        setFieldError(err.message || 'Failed to rename');
      });
    }
  };

  const handleTitleCommit = (newTitle: string) => {
    const trimmed = newTitle.trim();
    if (!trimmed) {
      setFieldError('Title cannot be empty');
      setEditingField(null);
      return;
    }
    if (trimmed.length > 500) {
      setFieldError('Title cannot exceed 500 characters');
      setEditingField(null);
      return;
    }

    handleFieldChange('title', trimmed);
    setEditingField(null);
  };

  const handleStatusSelect = (status: 'draft' | 'published') => {
    handleFieldChange('status', status);
    setEditingField(null);
  };

  const handleTagsCommit = (tags: string[]) => {
    handleFieldChange('tags', tags.length > 0 ? tags : undefined);
    setEditingField(null);
  };

  const handleOwnerCommit = (owner: string) => {
    const trimmed = owner.trim();
    handleFieldChange('owner', trimmed || undefined);
    setEditingField(null);
  };

  const handleTypeCommit = (type: string) => {
    const trimmed = type.trim();
    handleFieldChange('type', trimmed || undefined);
    setEditingField(null);
  };

  const handleYamlChange = (yaml: string) => {
    setRawYaml(yaml);
    setYamlError(null);

    try {
      const parsed = parseYaml(yaml) as Record<string, unknown>;

      // Check for attempts to edit auto-maintained fields
      for (const field of AUTO_MAINTAINED_FIELDS) {
        if (field in parsed && parsed[field] !== frontmatter[field]) {
          setYamlError(`${field} is auto-maintained and cannot be edited`);
          return;
        }
      }

      setYamlError(null);
      onChange(parsed);
    } catch (err) {
      setYamlError(`Invalid YAML: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const handleCancelEdit = () => {
    setEditingField(null);
    setFieldError(null);
    setRawYaml(stringify(frontmatter));
    setYamlError(null);
  };

  if (showYaml) {
    return (
      <YamlEditor
        rawYaml={rawYaml}
        onYamlChange={handleYamlChange}
        error={yamlError}
        autoMaintainedFields={AUTO_MAINTAINED_FIELDS}
        onCancel={handleCancelEdit}
        onClose={() => setShowYaml(false)}
        disabled={disabled}
      />
    );
  }

  // Render the metadata strip.
  // `data-strip-active` lets the page-level Esc handler detect that an inline
  // edit (title input, status popover, tags chip editor) is open and skip its
  // own "exit edit mode" behavior. See web/src/pages/PageView.tsx.
  return (
    <div
      className="px-6 py-4 sm:px-8 sm:py-5 md:px-10 md:py-6"
      style={{ background: 'var(--kp-surface-base)' }}
      data-strip-active={editingField !== null || showYaml ? 'true' : 'false'}
    >
      <div className="flex items-center justify-between gap-4">
        {/* Left: metadata fields */}
        <FrontmatterStripFields
          frontmatter={frontmatter}
          editingField={editingField}
          onFieldClick={setEditingField}
          onTitleCommit={handleTitleCommit}
          onStatusSelect={handleStatusSelect}
          onTagsCommit={handleTagsCommit}
          onOwnerCommit={handleOwnerCommit}
          onTypeCommit={handleTypeCommit}
          onCancel={handleCancelEdit}
          fieldError={fieldError}
          disabled={disabled}
        />

        {/* Right: overflow menu with YAML toggle */}
        <div className="flex items-center gap-2">
          {showYamlToggle && !disabled && (
            <button
              onClick={() => setShowYaml(true)}
              style={{
                padding: '0.25rem 0.5rem',
                fontSize: '0.75rem',
                color: 'var(--kp-text-secondary)',
                background: 'transparent',
                border: 'none',
                borderRadius: '4px',
                cursor: 'pointer',
                transition: 'all 150ms',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.color = 'var(--kp-text-primary)';
                e.currentTarget.style.background = 'var(--kp-surface-sunken)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.color = 'var(--kp-text-secondary)';
                e.currentTarget.style.background = 'transparent';
              }}
              title="Show raw YAML"
            >
              ⋯
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
