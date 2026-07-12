/**
 * Frontmatter panel with two modes:
 * 1. Form mode (default): inputs for title, status, tags, owner
 * 2. Raw YAML mode: textarea with auto-maintained fields greyed out
 *
 * v0.1 User-facing fields: title, status, tags, owner
 * Auto-maintained (read-only): created_at, updated_at, authors, slug
 *
 * Validation:
 * - title: non-empty, 1-500 characters
 * - status: 'draft' | 'published'
 */

import { useState, useCallback, useEffect } from 'react';
import { stringify, parse as parseYaml } from 'yaml';
import type { Frontmatter } from '@echozedlabs/codec';

interface FrontmatterPanelProps {
  frontmatter: Frontmatter;
  onFrontmatterChange: (frontmatter: Frontmatter) => void;
  errors?: Record<string, string>;
}

const AUTO_MAINTAINED_FIELDS = ['created_at', 'updated_at', 'authors', 'slug'];

export function FrontmatterPanel({ frontmatter, onFrontmatterChange, errors = {} }: FrontmatterPanelProps) {
  const [showRaw, setShowRaw] = useState(false);
  const [rawYaml, setRawYaml] = useState(() => stringify(frontmatter));
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});

  // Update rawYaml when frontmatter changes (e.g., on page load)
  useEffect(() => {
    setRawYaml(stringify(frontmatter));
  }, [frontmatter]);

  const handleFormChange = useCallback(
    (field: string, value: any) => {
      const updated = { ...frontmatter, [field]: value };
      onFrontmatterChange(updated);
      // Clear errors for this field on change
      setFormErrors({ ...formErrors, [field]: '' });
    },
    [frontmatter, onFrontmatterChange, formErrors]
  );

  const handleRawYamlChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const yaml = e.currentTarget.value;
      setRawYaml(yaml);

      try {
        const parsed = parseYaml(yaml) as Frontmatter;

        // Check for attempts to edit auto-maintained fields
        for (const field of AUTO_MAINTAINED_FIELDS) {
          if (field in parsed && parsed[field] !== frontmatter[field]) {
            setFormErrors({
              [field]: `${field} is auto-maintained and cannot be edited`,
            });
            return;
          }
        }

        setFormErrors({});
        onFrontmatterChange(parsed);
      } catch (err) {
        // YAML parse error; show in field
        setFormErrors({ yaml: `Invalid YAML: ${err instanceof Error ? err.message : String(err)}` });
      }
    },
    [frontmatter, onFrontmatterChange]
  );

  const handleTagsChange = useCallback(
    (tagsStr: string) => {
      const tags = tagsStr
        .split(',')
        .map((t) => t.trim())
        .filter((t) => t.length > 0);
      handleFormChange('tags', tags.length > 0 ? tags : undefined);
    },
    [handleFormChange]
  );

  if (showRaw) {
    return (
      <div className="border border-slate-200 rounded-lg bg-white p-4">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-semibold text-slate-900">Frontmatter (Raw YAML)</h3>
          <button
            onClick={() => setShowRaw(false)}
            className="text-sm px-3 py-1 bg-slate-100 text-slate-700 rounded hover:bg-slate-200"
          >
            Form view
          </button>
        </div>

        {formErrors.yaml && (
          <div className="mb-3 p-3 bg-red-50 border border-red-200 rounded text-sm text-red-700">{formErrors.yaml}</div>
        )}

        <textarea
          value={rawYaml}
          onChange={handleRawYamlChange}
          className="w-full font-mono text-sm p-3 border border-slate-200 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
          style={{ minHeight: '300px' }}
          spellCheck="false"
        />

        <div className="mt-3 text-xs text-slate-500">
          <p>Auto-maintained fields (not editable): {AUTO_MAINTAINED_FIELDS.join(', ')}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="border border-slate-200 rounded-lg bg-white p-4">
      <div className="flex items-center justify-between mb-4">
        <h3 className="font-semibold text-slate-900">Frontmatter</h3>
        <button
          onClick={() => setShowRaw(true)}
          className="text-sm px-3 py-1 bg-slate-100 text-slate-700 rounded hover:bg-slate-200"
        >
          Raw YAML
        </button>
      </div>

      <div className="space-y-4">
        {/* Title */}
        <div>
          <label htmlFor="fm-title" className="block text-sm font-medium text-slate-700 mb-1">
            Title <span className="text-red-500">*</span>
          </label>
          <input
            id="fm-title"
            type="text"
            value={frontmatter.title || ''}
            onChange={(e) => handleFormChange('title', e.target.value || undefined)}
            maxLength={500}
            className={`w-full px-3 py-2 border rounded focus:outline-none focus:ring-2 focus:ring-blue-500 ${
              formErrors.title ? 'border-red-400 bg-red-50' : 'border-slate-200'
            }`}
            placeholder="Page title"
          />
          {formErrors.title && <p className="mt-1 text-xs text-red-600">{formErrors.title}</p>}
          <p className="mt-1 text-xs text-slate-500">
            {frontmatter.title?.length || 0}/500 characters
          </p>
        </div>

        {/* Status */}
        <div>
          <label htmlFor="fm-status" className="block text-sm font-medium text-slate-700 mb-1">Status</label>
          <select
            id="fm-status"
            value={frontmatter.status || 'draft'}
            onChange={(e) => handleFormChange('status', e.target.value as 'draft' | 'published')}
            className={`w-full px-3 py-2 border rounded focus:outline-none focus:ring-2 focus:ring-blue-500 ${
              formErrors.status ? 'border-red-400 bg-red-50' : 'border-slate-200'
            }`}
          >
            <option value="draft">Draft</option>
            <option value="published">Published</option>
          </select>
          {formErrors.status && <p className="mt-1 text-xs text-red-600">{formErrors.status}</p>}
        </div>

        {/* Tags */}
        <div>
          <label htmlFor="fm-tags" className="block text-sm font-medium text-slate-700 mb-1">Tags</label>
          <input
            id="fm-tags"
            type="text"
            value={(frontmatter.tags || []).join(', ')}
            onChange={(e) => handleTagsChange(e.target.value)}
            className="w-full px-3 py-2 border border-slate-200 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
            placeholder="tag1, tag2, tag3"
          />
          <p className="mt-1 text-xs text-slate-500">Comma-separated list</p>
        </div>

        {/* Owner */}
        <div>
          <label htmlFor="fm-owner" className="block text-sm font-medium text-slate-700 mb-1">Owner</label>
          <input
            id="fm-owner"
            type="text"
            value={frontmatter.owner || ''}
            onChange={(e) => handleFormChange('owner', e.target.value || undefined)}
            className="w-full px-3 py-2 border border-slate-200 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
            placeholder="username"
          />
        </div>

        {/* Auto-maintained fields (read-only) */}
        <div className="pt-4 border-t border-slate-200">
          <p className="text-xs font-semibold text-slate-500 mb-3">Auto-maintained fields (read-only)</p>
          <div className="space-y-2 text-sm">
            {frontmatter.created_at && (
              <div>
                <p className="text-slate-500">Created</p>
                <p className="text-slate-400 font-mono text-xs">{frontmatter.created_at}</p>
              </div>
            )}
            {frontmatter.updated_at && (
              <div>
                <p className="text-slate-500">Updated</p>
                <p className="text-slate-400 font-mono text-xs">{frontmatter.updated_at}</p>
              </div>
            )}
            {frontmatter.authors && frontmatter.authors.length > 0 && (
              <div>
                <p className="text-slate-500">Authors</p>
                <p className="text-slate-400 font-mono text-xs">{frontmatter.authors.join(', ')}</p>
              </div>
            )}
            {frontmatter.slug && (
              <div>
                <p className="text-slate-500">Slug</p>
                <p className="text-slate-400 font-mono text-xs">{frontmatter.slug}</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
