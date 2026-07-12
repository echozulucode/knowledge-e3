/**
 * StatusPopover — small popover with Draft/Published options.
 * NOT a <select> element — explicit buttons with check marks.
 */

import { useEffect, useRef } from 'react';

interface StatusPopoverProps {
  currentStatus: 'draft' | 'published';
  onSelect: (status: 'draft' | 'published') => void;
  onClose: () => void;
}

export function StatusPopover({
  currentStatus,
  onSelect,
  onClose,
}: StatusPopoverProps) {
  const popoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    // Esc dismisses the popover — standard popover affordance, and the
    // strip's keyboard contract relies on it (otherwise editingField stays
    // 'status' and the read-mode click target with title="Click to edit
    // status" never reappears).
    const handleKeydown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // Stop further window-level Esc handlers (notably PageView's
        // exit-edit-mode) from firing — Esc is "ours" while the popover is
        // open, and the bubble from document → window would otherwise
        // collapse the surrounding edit mode entirely.
        e.stopPropagation();
        onClose();
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKeydown);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeydown);
    };
  }, [onClose]);

  const handleSelect = (status: 'draft' | 'published') => {
    onSelect(status);
    onClose();
  };

  return (
    <div
      ref={popoverRef}
      className="absolute top-full left-0 mt-1 z-50 bg-white border border-slate-200 rounded shadow-lg overflow-hidden"
      style={{ minWidth: '150px' }}
    >
      <button
        onClick={() => handleSelect('draft')}
        className="w-full text-left px-3 py-2 text-sm hover:bg-slate-100 flex items-center justify-between"
      >
        <span>Draft</span>
        {currentStatus === 'draft' && <span className="text-green-600">✓</span>}
      </button>
      <button
        onClick={() => handleSelect('published')}
        className="w-full text-left px-3 py-2 text-sm hover:bg-slate-100 flex items-center justify-between border-t border-slate-200"
      >
        <span>Published</span>
        {currentStatus === 'published' && <span className="text-green-600">✓</span>}
      </button>
    </div>
  );
}
