/**
 * Conflict resolution dialog shown on PUT 409 (Conflict).
 *
 * Three actions per spec §3.1:
 * 1. "View their changes" - fetches current page, shows side-by-side diff
 * 2. "Overwrite with mine" - refetches version token, retries save
 * 3. "Cancel" - discards local edit
 */

import { useState } from 'react';
import type { Page } from '../queries.js';
import { SideBySideDiff } from './diff/SideBySideDiff.js';
import { Modal } from './Modal.js';

interface ConflictDialogProps {
  yourVersion: string;
  theirVersion: string;
  theirPage: Page;
  onOverwrite: () => void;
  onCancel: () => void;
  isLoading?: boolean;
  yourUpdatedAt?: string;  // your version timestamp (usually now)
  theirUpdatedAt?: string; // their version timestamp (from server)
}

export function ConflictDialog({
  yourVersion,
  theirVersion,
  theirPage,
  onOverwrite,
  onCancel,
  isLoading = false,
  yourUpdatedAt,
  theirUpdatedAt,
}: ConflictDialogProps) {
  const [showDiff, setShowDiff] = useState(false);

  // Format relative time for version timestamps
  function formatRelativeTime(isoString?: string): string {
    if (!isoString) return 'Unknown time';
    try {
      const date = new Date(isoString);
      const now = new Date();
      const diffMs = now.getTime() - date.getTime();
      const diffSecs = Math.floor(diffMs / 1000);
      const diffMins = Math.floor(diffSecs / 60);
      const diffHours = Math.floor(diffMins / 60);
      const diffDays = Math.floor(diffHours / 24);

      if (diffSecs < 60) return 'just now';
      if (diffMins < 60) return `${diffMins}m ago`;
      if (diffHours < 24) return `${diffHours}h ago`;
      if (diffDays < 7) return `${diffDays}d ago`;
      return date.toLocaleDateString();
    } catch {
      return 'Unknown time';
    }
  }

  return (
    <Modal
      onClose={() => { if (!isLoading) onCancel(); }}
      labelledBy="conflict-dialog-title"
      closeOnBackdrop={!isLoading}
      className="bg-white rounded-lg max-w-2xl w-full max-h-[90vh] overflow-auto"
    >
      <div>
        <div className="p-6 border-b border-slate-200">
          <h2 id="conflict-dialog-title" className="text-xl font-bold text-slate-900">Edit conflict</h2>
          <p className="text-sm text-slate-600 mt-2">
            This page was edited by someone else while you were working. Choose what to do:
          </p>
        </div>

        {showDiff ? (
          <div className="p-6">
            <div className="mb-4">
              <h3 className="font-semibold text-slate-900 mb-2">Changes since you started editing</h3>
              <div className="text-sm text-slate-600 space-y-1 mb-4">
                <p>Server saved at {formatRelativeTime(theirUpdatedAt)}</p>
                <p>You edited from {formatRelativeTime(yourUpdatedAt)}</p>
              </div>
            </div>

            <SideBySideDiff
              left={theirVersion}
              right={yourVersion}
            />

            <div className="mt-6 flex gap-3">
              <button
                onClick={() => setShowDiff(false)}
                className="px-4 py-2 bg-slate-100 text-slate-700 rounded hover:bg-slate-200 text-sm font-medium"
              >
                Hide differences
              </button>
            </div>
          </div>
        ) : (
          <div className="p-6">
            <div className="mb-6 p-4 bg-slate-50 rounded border border-slate-200">
              <p className="text-sm font-medium text-slate-900">Page information</p>
              <div className="mt-3 grid grid-cols-2 gap-4 text-sm">
                <div>
                  <p className="text-slate-500">Title</p>
                  <p className="font-medium text-slate-900">{theirPage.title}</p>
                </div>
                <div>
                  <p className="text-slate-500">Server version timestamp</p>
                  <p className="font-medium text-slate-900">{formatRelativeTime(theirUpdatedAt)}</p>
                  <p className="text-xs text-slate-600 mt-1">{new Date(theirPage.updated_at).toLocaleString()}</p>
                </div>
              </div>
            </div>

            <div className="space-y-3">
              <button
                onClick={() => setShowDiff(true)}
                className="w-full px-4 py-3 text-left bg-blue-50 border border-blue-200 rounded-lg hover:bg-blue-100 transition"
              >
                <p className="font-semibold text-blue-900">View their changes</p>
                <p className="text-sm text-blue-700 mt-1">See a side-by-side diff of the changes</p>
              </button>

              <button
                onClick={onOverwrite}
                disabled={isLoading}
                className="w-full px-4 py-3 text-left bg-orange-50 border border-orange-200 rounded-lg hover:bg-orange-100 transition disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <p className="font-semibold text-orange-900">
                  {isLoading ? 'Saving...' : 'Overwrite with mine'}
                </p>
                <p className="text-sm text-orange-700 mt-1">Replace their version with your changes</p>
              </button>

              <button
                onClick={onCancel}
                disabled={isLoading}
                className="w-full px-4 py-3 text-left bg-slate-100 border border-slate-300 rounded-lg hover:bg-slate-200 transition disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <p className="font-semibold text-slate-900">Cancel</p>
                <p className="text-sm text-slate-600 mt-1">Discard your edits</p>
              </button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
