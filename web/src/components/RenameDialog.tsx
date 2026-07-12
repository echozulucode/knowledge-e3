/**
 * Rename consent dialog shown when title changes and N ≥ 1 backlinks exist.
 *
 * Spec §6.4: "N pages link to the old title. [Update all N] [Skip — leave broken] [Cancel]"
 *
 * Three actions:
 * 1. "Update all N links" - calls POST /pages/:id/rename with link_action='update_all'
 * 2. "Skip — leave them broken" - calls POST /pages/:id/rename with link_action='skip'
 * 3. "Cancel" - discards rename
 */

import { Modal } from './Modal.js';

interface RenameDialogProps {
  oldTitle: string;
  newTitle: string;
  affectedCount: number;
  onUpdateAll: () => void;
  onSkip: () => void;
  onCancel: () => void;
  isLoading?: boolean;
}

export function RenameDialog({
  oldTitle,
  newTitle,
  affectedCount,
  onUpdateAll,
  onSkip,
  onCancel,
  isLoading = false,
}: RenameDialogProps) {
  return (
    <Modal
      onClose={() => { if (!isLoading) onCancel(); }}
      labelledBy="rename-dialog-title"
      closeOnBackdrop={!isLoading}
      className="bg-white rounded-lg max-w-md w-full shadow-lg"
    >
      <div>
        <div className="p-6 border-b border-slate-200">
          <h2 id="rename-dialog-title" className="text-lg font-bold text-slate-900">Rename this page?</h2>
        </div>

        <div className="p-6">
          <div className="mb-6 p-4 bg-slate-50 rounded border border-slate-200">
            <div className="grid grid-cols-2 gap-4 text-sm">
              <div>
                <p className="text-slate-500 text-xs mb-1">From</p>
                <p className="font-semibold text-slate-900">{oldTitle}</p>
              </div>
              <div>
                <p className="text-slate-500 text-xs mb-1">To</p>
                <p className="font-semibold text-slate-900">{newTitle}</p>
              </div>
            </div>
          </div>

          <div className="mb-6 p-4 bg-blue-50 rounded border border-blue-200">
            <p className="text-sm font-medium text-blue-900">
              {affectedCount === 1
                ? '1 page links to the old title.'
                : `${affectedCount} pages link to the old title.`}
            </p>
            <p className="text-xs text-blue-700 mt-2">What should happen to those links?</p>
          </div>

          <div className="space-y-3">
            <button
              onClick={onUpdateAll}
              disabled={isLoading}
              className="w-full px-4 py-3 text-left font-medium bg-green-50 border border-green-200 rounded-lg hover:bg-green-100 transition disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <p className="text-green-900">{isLoading ? 'Updating...' : `Update all ${affectedCount}`}</p>
              <p className="text-xs text-green-700 mt-1">Rewrite links in all affected pages</p>
            </button>

            <button
              onClick={onSkip}
              disabled={isLoading}
              className="w-full px-4 py-3 text-left font-medium bg-orange-50 border border-orange-200 rounded-lg hover:bg-orange-100 transition disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <p className="text-orange-900">Skip — leave them broken</p>
              <p className="text-xs text-orange-700 mt-1">Only rename this page, leave broken links</p>
            </button>

            <button
              onClick={onCancel}
              disabled={isLoading}
              className="w-full px-4 py-3 text-left font-medium bg-slate-100 border border-slate-300 rounded-lg hover:bg-slate-200 transition disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <p className="text-slate-900">Cancel</p>
              <p className="text-xs text-slate-600 mt-1">Don't rename</p>
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
