/**
 * OkfAdmin — Admin → Data (`/admin/data`, the admin UX review §4.9):
 * the human-facing OKF data bridge, as three tabs in the URL (`?tab=`).
 *
 *   Import — a Choose → Review → Import stepper in one card (DataImportPanel).
 *   Export — a topic, a format, Download (DataExportPanel).
 *   Audit  — the library audit's single home (LibraryAuditPanel, `?topic=`);
 *            Content health's finding tiles link here (§6 decision 4).
 *
 * Re-importing an export updates items in place (matched on their embedded
 * e3_id), so this doubles as backup/restore and instance-to-instance transfer.
 */
import { useNavigate, useSearch } from '@tanstack/react-router';
import { AdminPageHeader } from '../components/admin/AdminPageHeader.js';
import { ViewSwitch, viewPanelId, viewTabId } from '../features/taxonomy-admin/ViewSwitch.js';
import { DataImportPanel } from '../features/okf/DataImportPanel.js';
import { DataExportPanel } from '../features/okf/DataExportPanel.js';
import { LibraryAuditPanel } from '../features/okf/LibraryAuditPanel.js';
import { DATA_TABS, DATA_TAB_LABELS, dataSearchToParams, readDataSearch, type DataSearch, type DataTab } from '../features/okf/dataAdminModel.js';
import { useTopics } from '../queries.js';
import './OkfAdmin.css';
import '../features/okf/DataAdmin.css';

const ID_BASE = 'data-admin';

export function OkfAdmin() {
  const navigate = useNavigate();
  const rawSearch = useSearch({ strict: false }) as Record<string, unknown> | undefined;
  const search = readDataSearch(rawSearch);
  const { data: topics = [] } = useTopics();

  const go = (next: DataSearch, replace = false) => {
    void navigate({ to: '/admin/data', search: dataSearchToParams(next) as never, replace });
  };

  return (
    <main className="OkfAdmin DataAdmin" aria-labelledby="okf-admin-title">
      <AdminPageHeader
        titleId="okf-admin-title"
        title="Data"
        description="Import and export the library as Open Knowledge Format bundles, and audit it against the format."
        learnMore={
          <details>
            <summary>How this works</summary>
            <p>
              Re-importing an export updates items in place (matched on their stable id), so nothing is duplicated. A
              directory of <code>.md</code> files is also produced by the git-of-record mirror and the{' '}
              <code>export:okf</code> CLI.
            </p>
          </details>
        }
      />

      <ViewSwitch<DataTab>
        label="Data views"
        idBase={ID_BASE}
        options={DATA_TABS.map((tab) => ({ value: tab, label: DATA_TAB_LABELS[tab] }))}
        value={search.tab}
        onChange={(tab) => go({ ...search, tab })}
      />

      <div className="DataAdmin__panel" role="tabpanel" id={viewPanelId(ID_BASE)} aria-labelledby={viewTabId(ID_BASE, search.tab)}>
        {search.tab === 'import' ? (
          <DataImportPanel />
        ) : search.tab === 'export' ? (
          <DataExportPanel topics={topics} />
        ) : (
          <LibraryAuditPanel topic={search.topic} topics={topics} onTopicChange={(topic) => go({ ...search, topic }, true)} />
        )}
      </div>
    </main>
  );
}
