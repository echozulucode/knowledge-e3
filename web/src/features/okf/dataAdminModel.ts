/**
 * Pure helpers behind Admin → Data (the admin UX review §4.9):
 * the tab and topic in the URL, the Import stepper's state machine, what a
 * chosen set of files is, what an import would change, and the library audit
 * grouped by rule. Free of React and the network so each is unit-tested.
 */
import { importReadiness, type BundleValidateResponse } from './bundleReportModel.js';

/* ------------------------------------------------------------------ URL state */

export const DATA_TABS = ['import', 'export', 'audit'] as const;
export type DataTab = (typeof DATA_TABS)[number];

export const DATA_TAB_LABELS: Record<DataTab, string> = { import: 'Import', export: 'Export', audit: 'Audit' };

export interface DataSearch {
  tab: DataTab;
  /** Topic slug the Audit tab is scoped to; '' is the whole library. */
  topic: string;
}

/** The page's state from the query string; an unknown tab reads as Import, the first. */
export function readDataSearch(search: Record<string, unknown> | undefined): DataSearch {
  const s = search ?? {};
  const tab = typeof s['tab'] === 'string' && (DATA_TABS as readonly string[]).includes(s['tab']) ? (s['tab'] as DataTab) : 'import';
  const topic = typeof s['topic'] === 'string' ? s['topic'].trim() : typeof s['topic'] === 'number' ? String(s['topic']) : '';
  return { tab, topic };
}

/**
 * The query string for a state, defaults dropped. `topic` only travels with the
 * Audit tab — it is that tab's filter, and a stale one on Import would be
 * carried into a shared link for no reason.
 */
export function dataSearchToParams(state: DataSearch): Record<string, string> {
  const out: Record<string, string> = {};
  if (state.tab !== 'import') out['tab'] = state.tab;
  if (state.tab === 'audit' && state.topic) out['topic'] = state.topic;
  return out;
}

/* ------------------------------------------------------------ choosing files */

/** One picked or dropped file, as the classifier needs it. */
export interface ChosenFile {
  name: string;
  /** Path relative to a chosen folder (`webkitRelativePath`), else the name. */
  path: string;
}

export type BundleChoice =
  | { kind: 'archive'; index: number }
  | { kind: 'json'; index: number }
  | { kind: 'markdown'; indices: number[]; label: string }
  | { kind: 'invalid'; message: string };

const isArchive = (name: string) => /\.(tar\.gz|tgz|gz)$/i.test(name);
const isJson = (name: string) => /\.json$/i.test(name);
const isMarkdown = (f: ChosenFile) => /\.md$/i.test(f.name) && !f.path.split('/').includes('.git');

/**
 * What the admin chose, from the ONE drop zone that replaced three file inputs:
 * a `.tar.gz` archive (recommended — it carries assets), a `.json` envelope, or
 * `.md` concept files (a folder). Mixed or multiple bundles are refused with a
 * sentence rather than guessed at: importing the wrong half of a drop is worse
 * than asking again.
 */
export function classifyBundleChoice(files: readonly ChosenFile[]): BundleChoice {
  if (files.length === 0) return { kind: 'invalid', message: 'Nothing was chosen.' };
  const archives = files.flatMap((f, i) => (isArchive(f.name) ? [i] : []));
  const jsons = files.flatMap((f, i) => (isJson(f.name) ? [i] : []));
  const markdown = files.flatMap((f, i) => (isMarkdown(f) ? [i] : []));
  const bundles = archives.length + jsons.length + (markdown.length > 0 ? 1 : 0);
  if (bundles > 1) {
    return { kind: 'invalid', message: 'Choose one bundle at a time: a single .tar.gz archive, a single .json file, or .md files.' };
  }
  if (archives.length === 1) return { kind: 'archive', index: archives[0]! };
  if (jsons.length === 1) return { kind: 'json', index: jsons[0]! };
  if (markdown.length > 0) {
    const first = files[markdown[0]!]!;
    const folder = first.path.includes('/') ? first.path.split('/')[0]! : 'files';
    return { kind: 'markdown', indices: markdown, label: `${folder} (${markdown.length} .md file${markdown.length === 1 ? '' : 's'})` };
  }
  return { kind: 'invalid', message: 'Unrecognized file — expected a .tar.gz archive, a .json bundle, or .md concept files.' };
}

/* ------------------------------------------------------------ import stepper */

export type ImportStep = 'choose' | 'review' | 'import';

export const IMPORT_STEPS: readonly { step: ImportStep; label: string }[] = [
  { step: 'choose', label: 'Choose' },
  { step: 'review', label: 'Review' },
  { step: 'import', label: 'Import' },
];

/** What a finished import reported, as the outcome renders it. */
export interface ImportOutcome {
  created: number;
  updated: number;
  assetsImported: number;
  assetsFailed: number;
  /** Items that imported below this instance's content rules (listed in Content health). */
  policyErrors: number;
}

export interface ImportState {
  step: ImportStep;
  /**
   * Bumped on every new choice, so a validation that resolves after the admin
   * has already chosen something else cannot paint its report onto the new bundle.
   */
  selection: number;
  label: string | null;
  phase: 'idle' | 'validating' | 'importing';
  /** The dry-run report for the current choice; Import needs it conformant. */
  report: BundleValidateResponse | null;
  /** A failure to read, validate or import, in words. */
  error: string | null;
  /** The report a refused import came back with (422 `bundle_not_conformant`). */
  refusal: BundleValidateResponse | null;
  outcome: ImportOutcome | null;
}

export type ImportEvent =
  /** `selection` is the component's token for this choice; the validation that answers it carries the same one. */
  | { type: 'choose'; label: string; selection: number }
  | { type: 'chooseFailed'; message: string }
  | { type: 'validated'; selection: number; report: BundleValidateResponse }
  | { type: 'validationFailed'; selection: number; message: string }
  | { type: 'continue' }
  | { type: 'back' }
  | { type: 'importStarted' }
  | { type: 'imported'; outcome: ImportOutcome }
  | { type: 'importFailed'; message: string; refusal: BundleValidateResponse | null }
  | { type: 'reset' };

export const INITIAL_IMPORT_STATE: ImportState = {
  step: 'choose',
  selection: 0,
  label: null,
  phase: 'idle',
  report: null,
  error: null,
  refusal: null,
  outcome: null,
};

/** A fresh Choose step that still invalidates any validation in flight. */
function restart(state: ImportState, error: string | null = null): ImportState {
  return { ...INITIAL_IMPORT_STATE, selection: state.selection + 1, error };
}

/**
 * The stepper. Choose → (validate, automatically: nothing is written) Review →
 * Continue, only when conformant → Import → the outcome, in the same card.
 *
 * A failed validation or a non-conformant bundle STAYS on Review — the report is
 * the point of that step. A refused import stays on Import with its 422 report,
 * and Import is then unavailable until a bundle is chosen again: the preview no
 * longer describes what the server thinks of it.
 */
export function importReducer(state: ImportState, event: ImportEvent): ImportState {
  switch (event.type) {
    case 'choose':
      return { ...INITIAL_IMPORT_STATE, selection: event.selection, step: 'review', label: event.label, phase: 'validating' };
    case 'chooseFailed':
      return restart(state, event.message);
    case 'validated':
      if (event.selection !== state.selection) return state;
      return { ...state, phase: 'idle', report: event.report, error: null };
    case 'validationFailed':
      if (event.selection !== state.selection) return state;
      return { ...state, phase: 'idle', report: null, error: event.message };
    case 'continue':
      return canContinue(state) ? { ...state, step: 'import', error: null } : state;
    case 'back':
      if (state.phase !== 'idle') return state;
      if (state.step === 'import' && !state.outcome && !state.refusal) return { ...state, step: 'review', error: null };
      return restart(state);
    case 'importStarted':
      return canImport(state) ? { ...state, phase: 'importing', error: null, refusal: null } : state;
    case 'imported':
      return { ...state, phase: 'idle', outcome: event.outcome, error: null };
    case 'importFailed':
      return { ...state, phase: 'idle', report: null, refusal: event.refusal, error: event.message };
    case 'reset':
      return restart(state);
  }
}

/** Review → Import: a validated, importable bundle, nothing in flight. */
export function canContinue(state: ImportState): boolean {
  return state.step === 'review' && state.phase === 'idle' && !!state.report && importReadiness(state.report).canImport;
}

/** The Import button: on the Import step, validated and importable, not yet imported or refused. */
export function canImport(state: ImportState): boolean {
  return (
    state.step === 'import' &&
    state.phase === 'idle' &&
    !!state.report &&
    importReadiness(state.report).canImport &&
    !state.outcome &&
    !state.refusal
  );
}

/** The step an `<ol>` stepper marks as done / current / to come. */
export function stepStatus(current: ImportStep, step: ImportStep): 'done' | 'current' | 'upcoming' {
  const order = IMPORT_STEPS.map((s) => s.step);
  const a = order.indexOf(current);
  const b = order.indexOf(step);
  return b < a ? 'done' : b === a ? 'current' : 'upcoming';
}

/* ------------------------------------------------------------ what will change */

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

/** "Would create 2 items and update 1." — or null when the server did not say. */
export function wouldChangeText(report: Pick<BundleValidateResponse, 'would_create' | 'would_update'>): string | null {
  const create = report.would_create;
  const update = report.would_update;
  if (typeof create !== 'number' || typeof update !== 'number') return null;
  if (create === 0 && update === 0) return 'Would change nothing: the bundle holds no concept documents.';
  const parts = [create > 0 ? `create ${plural(create, 'item')}` : null, update > 0 ? `update ${plural(update, 'existing item')}` : null].filter(Boolean);
  return `Would ${parts.join(' and ')}.`;
}

/**
 * The plain statement of what pressing Import writes (review §4.9, step 3) —
 * the consequences listed before the button, not discovered after it.
 */
export function importStatement(report: BundleValidateResponse): string[] {
  const lines: string[] = [];
  const change = wouldChangeText(report);
  lines.push(
    change
      ? `${change.replace(/^Would /, 'Import will ').replace(/\.$/, '')}, matching concepts on their embedded id, then on title within their topic.`
      : 'Import writes every concept in the bundle: an existing item is updated in place (matched on its embedded id, then on title within its topic); anything else is created.',
  );
  if (report.assets) lines.push(`Up to ${plural(report.assets, 'image or attachment', 'images and attachments')} will be restored.`);
  if (!report.summary.meetsPolicy) {
    lines.push(`${plural(report.summary.policyErrorCount, 'policy error')} will not block it; the affected items are listed in Content health afterwards.`);
  }
  lines.push('Items are saved like any other edit, and the import is recorded in the audit log.');
  return lines;
}

/** "Imported: 1 created, 2 updated · 3 asset(s) restored." with the policy note when it applies. */
export function importOutcomeText(outcome: ImportOutcome): string {
  const assets = outcome.assetsImported ? ` · ${outcome.assetsImported} asset(s) restored` : '';
  const failed = outcome.assetsFailed ? ` (${outcome.assetsFailed} asset(s) skipped)` : '';
  const flagged =
    outcome.policyErrors > 0
      ? ` ${plural(outcome.policyErrors, 'item')} did not meet the content-model rules and ${outcome.policyErrors === 1 ? 'is' : 'are'} listed in Content health.`
      : '';
  return `Imported: ${outcome.created} created, ${outcome.updated} updated${assets}${failed}.${flagged}`;
}

/* ------------------------------------------------------------- library audit */

export interface AuditIssue {
  path: string;
  /** Stable rule id; older servers may omit it. */
  code?: string;
  severity: string;
  message: string;
}

export interface RuleGroup {
  code: string;
  /** The most severe severity among the group's issues. */
  severity: string;
  count: number;
  fileCount: number;
  issues: AuditIssue[];
}

const SEVERITY_ORDER = ['critical', 'error', 'warning', 'info'];
const rank = (severity: string) => {
  const i = SEVERITY_ORDER.indexOf(severity);
  return i === -1 ? SEVERITY_ORDER.length : i;
};

/**
 * One tier's findings grouped by rule, most severe rule first, then the rule
 * with the most findings, then by id. Every issue is kept — the old panel cut
 * conformance at 50 and advisories at 100 — and within a group files are in
 * path order so a long list is scannable.
 */
export function groupByRule(issues: readonly AuditIssue[]): RuleGroup[] {
  const groups = new Map<string, AuditIssue[]>();
  for (const issue of issues) {
    const code = issue.code?.trim() || '(no rule id)';
    const list = groups.get(code) ?? [];
    list.push(issue);
    groups.set(code, list);
  }
  return [...groups.entries()]
    .map(([code, list]) => {
      const sorted = [...list].sort((a, b) => a.path.localeCompare(b.path));
      const severity = sorted.reduce((worst, i) => (rank(i.severity) < rank(worst) ? i.severity : worst), sorted[0]!.severity);
      return { code, severity, count: sorted.length, fileCount: new Set(sorted.map((i) => i.path)).size, issues: sorted };
    })
    .sort((a, b) => rank(a.severity) - rank(b.severity) || b.count - a.count || a.code.localeCompare(b.code));
}

/** "12 findings across 3 rules", "No findings". */
export function tierCountText(groups: readonly RuleGroup[]): string {
  const findings = groups.reduce((sum, g) => sum + g.count, 0);
  if (findings === 0) return 'No findings';
  return `${plural(findings, 'finding')} across ${plural(groups.length, 'rule')}`;
}
