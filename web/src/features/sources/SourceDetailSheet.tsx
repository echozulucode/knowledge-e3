/**
 * One source's detail sheet (`?source=<id>`, the admin UX review §4.4): the
 * header carries Sync now, Edit and the rest of the row's actions; the tabs are
 * Overview · Conflicts (n) · Change requests (review mode only — the only mode
 * that opens them) · Selection.
 *
 * The page owns the URL, the mutations and the Remove confirmation; this is
 * layout over panels that already existed as stacked sections below the table.
 */
import { OverflowMenu, type OverflowMenuItem } from '../../components/admin/OverflowMenu.js';
import { Sheet, type SheetTab } from '../../components/admin/Sheet.js';
import { StatusChip } from '../../components/admin/StatusChip.js';
import { Icon, appIcons } from '../../icons.js';
import { ConflictsPanel } from './ConflictsPanel.js';
import { ReviewsPanel } from './ReviewsPanel.js';
import { SourceOverviewPanel, SourceSelectionPanel } from './SourceDetailsPanel.js';
import { stateChipTitle } from './sourceModel.js';
import { openConflictCount, resolveTab, sourceStateChip, stateTone, type SheetTabId } from './sourcesAdminModel.js';
import type { SourceStatusView } from './types.js';

export interface SourceDetailSheetProps {
  source: SourceStatusView;
  tab: SheetTabId | null;
  onTabChange: (tab: SheetTabId) => void;
  onClose: () => void;
  onEdit: () => void;
  onSync: () => void;
  syncing: boolean;
  /** The `⋯` menu — the same items as the row's, minus Edit (it has its own button here). */
  menuItems: OverflowMenuItem[];
}

export function SourceDetailSheet({ source, tab, onTabChange, onClose, onEdit, onSync, syncing, menuItems }: SourceDetailSheetProps) {
  const chip = sourceStateChip(source);
  const conflicts = openConflictCount(source);
  const active = resolveTab(tab, source);

  const tabs: SheetTab[] = [
    {
      id: 'overview',
      label: 'Overview',
      content: <SourceOverviewPanel source={source} onShowConflicts={() => onTabChange('conflicts')} />,
    },
    { id: 'conflicts', label: 'Conflicts', badge: conflicts, content: <ConflictsPanel sourceId={source.id} /> },
    ...(source.mode === 'review'
      ? [{ id: 'reviews', label: 'Change requests', content: <ReviewsPanel sourceId={source.id} /> } satisfies SheetTab]
      : []),
    { id: 'selection', label: 'Selection', content: <SourceSelectionPanel source={source} /> },
  ];

  return (
    <Sheet
      title={source.id}
      width="lg"
      subtitle={
        <span className="Sources__sheetSubtitle">
          <StatusChip tone={stateTone(chip)} size="sm" label={chip.label} title={stateChipTitle(chip)} />
          <span className="Sources__mono">{source.remote_url ?? 'local only'}</span>
        </span>
      }
      headerActions={
        <>
          <button
            type="button"
            className="kp-admin-button"
            disabled={syncing || !source.remote_url}
            title={source.remote_url ? 'Fetch, merge and index now' : 'This source has no remote'}
            onClick={onSync}
          >
            <Icon icon={appIcons.clockRotateLeft} /> {syncing ? 'Syncing…' : 'Sync now'}
          </button>
          <button type="button" className="kp-admin-button" onClick={onEdit}>
            <Icon icon={appIcons.pencil} /> Edit
          </button>
          <OverflowMenu label={`More actions for ${source.id}`} items={menuItems} />
        </>
      }
      tabs={tabs}
      activeTab={active}
      onTabChange={(id) => onTabChange(id as SheetTabId)}
      onClose={onClose}
    />
  );
}
