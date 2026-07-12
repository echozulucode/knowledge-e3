/**
 * TagsEditor — inline chip editor.
 * Existing tags are removable pills; a thin input at the end accepts new tags on Enter.
 */

import { useState, useRef, useEffect } from 'react';

interface TagsEditorProps {
  tags: string[];
  onCommit: (tags: string[]) => void;
  onCancel: () => void;
  disabled?: boolean;
}

export function TagsEditor({
  tags: initialTags,
  onCommit,
  onCancel,
  disabled = false,
}: TagsEditorProps) {
  const [tags, setTags] = useState(initialTags);
  const [inputValue, setInputValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleRemoveTag = (index: number) => {
    setTags(tags.filter((_, i) => i !== index));
  };

  const handleAddTag = () => {
    const trimmed = inputValue.trim();
    if (trimmed && !tags.includes(trimmed)) {
      setTags([...tags, trimmed]);
      setInputValue('');
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleAddTag();
    } else if (e.key === 'Escape') {
      onCancel();
    }
  };

  const handleBlur = () => {
    // Commit on blur
    onCommit(tags);
  };

  return (
    <div
      className="flex items-center gap-1 text-sm bg-slate-50 border border-slate-300 rounded px-2 py-1 flex-wrap"
      onClick={(e) => e.stopPropagation()}
    >
      {tags.map((tag, i) => (
        <div
          key={i}
          className="flex items-center gap-1 bg-blue-100 text-blue-800 px-2 py-0.5 rounded text-xs font-medium"
        >
          <span>{tag}</span>
          <button
            // Prevent the input's blur from firing before this click handler:
            // mousedown → blur → mouseup → click. handleBlur commits the
            // closure-stale `tags` array, which would re-add the tag we're
            // about to remove. preventDefault on mousedown keeps the input
            // focused, so blur never fires until the click actually mutates.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => handleRemoveTag(i)}
            className="hover:text-blue-900 font-bold text-xs leading-none"
            disabled={disabled}
          >
            ×
          </button>
        </div>
      ))}

      <input
        ref={inputRef}
        type="text"
        value={inputValue}
        onChange={(e) => setInputValue(e.currentTarget.value)}
        onKeyDown={handleKeyDown}
        onBlur={handleBlur}
        placeholder={tags.length === 0 ? 'add tags...' : ''}
        className="border-0 outline-none bg-transparent text-sm min-w-0 flex-1 focus:ring-0"
        disabled={disabled}
      />
    </div>
  );
}
