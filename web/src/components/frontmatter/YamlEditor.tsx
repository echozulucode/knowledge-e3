/**
 * YamlEditor — raw YAML editing panel.
 * Auto-maintained fields are greyed out. Unknown keys are preserved.
 */

interface YamlEditorProps {
  rawYaml: string;
  onYamlChange: (yaml: string) => void;
  error?: string | null;
  autoMaintainedFields: string[];
  onCancel: () => void;
  onClose: () => void;
  disabled?: boolean;
}

export function YamlEditor({
  rawYaml,
  onYamlChange,
  error,
  autoMaintainedFields,
  onCancel,
  onClose,
  disabled = false,
}: YamlEditorProps) {
  return (
    <div className="border-b border-slate-200 bg-white px-4 py-3 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-900">Frontmatter (Raw YAML)</h3>
        <button
          onClick={onClose}
          className="text-sm px-3 py-1 bg-slate-100 text-slate-700 rounded hover:bg-slate-200 transition disabled:opacity-50"
          disabled={disabled}
        >
          Hide YAML
        </button>
      </div>

      {error && (
        <div className="p-3 bg-red-50 border border-red-200 rounded text-sm text-red-700">
          {error}
        </div>
      )}

      <textarea
        value={rawYaml}
        onChange={(e) => onYamlChange(e.currentTarget.value)}
        className="w-full font-mono text-sm p-3 border border-slate-200 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
        style={{ minHeight: '200px' }}
        spellCheck="false"
        disabled={disabled}
      />

      <div className="text-xs text-slate-500">
        <p>Auto-maintained fields (not editable): {autoMaintainedFields.join(', ')}</p>
      </div>
    </div>
  );
}
