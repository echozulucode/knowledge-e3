/**
 * Data → Audit: the library audit's single home (the admin UX review §6
 * decision 4). Content health's finding tiles link here with their topic.
 *
 * A read-only, three-tier check — hard conformance (the only tier that can
 * fail), this instance's policy, and v0.2 advisories — plus the trust tier and
 * freshness roll-up. Every finding is listed, grouped by rule with counts; the
 * old panel cut conformance at 50 and advisories at 100 and never listed policy.
 */
import { useState } from 'react';
import { DataTable } from '../../components/admin/DataTable.js';
import { EmptyState } from '../../components/admin/EmptyState.js';
import { Freshness } from '../../components/admin/Freshness.js';
import { StatusChip, type StatusTone } from '../../components/admin/StatusChip.js';
import type { ApiError } from '../../api.js';
import type { Topic } from '../../queries.js';
import { useLibraryAudit, type LibraryAuditResponse } from './auditQueries.js';
import { groupByRule, tierCountText, type AuditIssue, type RuleGroup } from './dataAdminModel.js';

const AUDIT_TIERS: readonly { key: 'conformance' | 'policy' | 'advisories'; label: string; meaning: string }[] = [
  { key: 'conformance', label: 'Conformance', meaning: 'The OKF rules. The only tier that makes the library non-conformant.' },
  { key: 'policy', label: 'Policy', meaning: 'This instance’s producer profile: recommended fields. Never rejects.' },
  { key: 'advisories', label: 'Advisories', meaning: 'OKF v0.2 best practice: provenance, trust and freshness. Never rejects.' },
];

const PAGE_SIZE = 50;

function severityTone(severity: string): StatusTone {
  if (severity === 'critical' || severity === 'error') return 'error';
  if (severity === 'warning') return 'warn';
  return 'info';
}

/** One rule's findings. The table mounts only once opened: a rule can hold every item in the library. */
function RuleFindings({ group, tier }: { group: RuleGroup; tier: string }) {
  const [open, setOpen] = useState(false);
  return (
    <details className="DataAudit__rule" data-rule={group.code} onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
      <summary>
        <code>{group.code}</code>
        <span className="DataAudit__ruleCount">
          {group.count.toLocaleString('en-US')} finding{group.count === 1 ? '' : 's'}
          {group.fileCount !== group.count ? ` in ${group.fileCount.toLocaleString('en-US')} files` : ''}
        </span>
        <StatusChip tone={severityTone(group.severity)} label={group.severity} size="sm" />
      </summary>
      {open ? (
        <DataTable<AuditIssue & { key: string }>
          rows={group.issues.map((issue, n) => ({ ...issue, key: `${issue.path}-${n}` }))}
          rowKey={(row) => row.key}
          caption={`${tier} findings for ${group.code}`}
          pageSize={PAGE_SIZE}
          columns={[
            { id: 'path', header: 'File', primary: true, sortValue: (r) => r.path, cell: (r) => <code>{r.path}</code> },
            { id: 'message', header: 'Message', cell: (r) => r.message },
          ]}
        />
      ) : null}
    </details>
  );
}

function AuditReport({ audit }: { audit: LibraryAuditResponse }) {
  const s = audit.signals;
  return (
    <>
      <p className="DataAudit__verdict" data-testid="audit-verdict">
        <StatusChip tone={audit.conformant ? 'ok' : 'error'} label={audit.conformant ? 'Conformant' : 'Not conformant'} />{' '}
        <strong>{s.total.toLocaleString('en-US')}</strong> concept{s.total === 1 ? '' : 's'} audited ·{' '}
        {audit.conformance.length.toLocaleString('en-US')} conformance · {audit.policy.length.toLocaleString('en-US')} policy ·{' '}
        {audit.advisories.length.toLocaleString('en-US')} advisory
      </p>
      <dl className="DataAudit__rollup" aria-label="Trust and freshness roll-up">
        <div>
          <dt>Trust</dt>
          <dd>
            {s.byTrustTier['human-reviewed']} human-reviewed · {s.byTrustTier['machine-confirmed']} machine-confirmed · {s.byTrustTier.unverified} unverified
          </dd>
        </div>
        <div>
          <dt>Freshness</dt>
          <dd>
            {s.byFreshness.fresh} fresh · {s.byFreshness.stale} stale
          </dd>
        </div>
        <div>
          <dt>Provenance</dt>
          <dd>
            {s.withSources} with sources · {s.withGenerated} with <code>generated</code>
          </dd>
        </div>
      </dl>
      {AUDIT_TIERS.map((tier) => {
        const groups = groupByRule(audit[tier.key]);
        return (
          <section key={tier.key} className="DataAudit__tier" data-tier={tier.key} aria-labelledby={`data-audit-${tier.key}`}>
            <h3 id={`data-audit-${tier.key}`}>
              {tier.label} <span className="DataAudit__tierCount">— {tierCountText(groups)}</span>
            </h3>
            <p className="DataAudit__meaning">{tier.meaning}</p>
            {groups.map((group) => (
              <RuleFindings key={group.code} group={group} tier={tier.label} />
            ))}
          </section>
        );
      })}
    </>
  );
}

export function LibraryAuditPanel({
  topic,
  topics,
  onTopicChange,
}: {
  topic: string;
  topics: readonly Topic[];
  onTopicChange: (topic: string) => void;
}) {
  const audit = useLibraryAudit(topic);
  const error = audit.error as ApiError | null;

  return (
    <section className="OkfAdmin__panel DataAudit" aria-labelledby="data-audit-title">
      <div className="DataAdmin__panelHead">
        <h2 id="data-audit-title">Library audit</h2>
        <Freshness verb="audited" updatedAt={audit.dataUpdatedAt || null} onRefresh={() => void audit.refetch()} refreshing={audit.isFetching} />
      </div>
      <p className="DataAdmin__lead">Conformance, policy and advisory findings for the library or one topic, with its trust and freshness. Nothing is modified.</p>
      <label className="DataAdmin__field">
        <span>Topic</span>
        <select value={topic} onChange={(e) => onTopicChange(e.target.value)} aria-label="Audit topic">
          <option value="">All topics</option>
          {topics.map((t) => (
            <option key={t.id} value={t.slug}>
              {t.name.trim() || t.slug}
            </option>
          ))}
        </select>
      </label>
      {audit.isLoading ? (
        <p className="OkfAdmin__muted" role="status">
          Auditing…
        </p>
      ) : audit.isError || !audit.data ? (
        <div role="alert" className="DataAdmin__alert">
          <p className="OkfAdmin__error">{error?.statusCode === 403 ? 'Admin access required.' : error?.message || 'The audit could not be run.'}</p>
          <button type="button" className="kp-admin-button" onClick={() => void audit.refetch()}>
            Try again
          </button>
        </div>
      ) : audit.data.signals.total === 0 ? (
        <EmptyState title="Nothing to audit" body={topic ? 'This topic holds no concepts yet.' : 'The library holds no concepts yet.'} />
      ) : (
        <AuditReport audit={audit.data} />
      )}
    </section>
  );
}
