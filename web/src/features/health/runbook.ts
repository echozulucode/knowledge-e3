/**
 * Pointers from an admin alert to the section of `docs/operations-runbook.md`
 * that answers it (plan B5).
 *
 * The runbook is organised by symptom and is already the right answer to most
 * of what these two pages show; the product simply never said so. Each entry
 * below names one section — number, heading, and the anchor the heading gets —
 * so an operator reads "this is §3.1" instead of grepping 900 lines.
 *
 * **Why these are not `<a href>`s.** Nothing serves the runbook: it is a file in
 * the repository, the container image does not copy `docs/`, and every non-API
 * GET falls through to the SPA (`bootstrap.ts`). A link to a URL that resolves
 * to the app's own not-found page is worse than the address itself, and the
 * plan's own words for B5 — "a link to the wrong section is worse than no link"
 * — apply to a link to no section at all. So the address is rendered as text,
 * exactly as it would be typed into an editor or appended to a repository URL.
 * If a deployment ever serves `docs/`, these entries become hrefs in one edit.
 *
 * `runbook.test.ts` checks every anchor here against the real document, so a
 * renamed heading fails a test rather than misleading an operator.
 */

export interface RunbookSection {
  /** Section number as the document writes it — `3.1`, `3.5(b)`. */
  number: string;
  /** The heading, verbatim enough to recognise in the document. */
  title: string;
  /** The GitHub-style anchor for that heading. */
  anchor: string;
}

export const RUNBOOK_DOC = 'docs/operations-runbook.md';

export const RUNBOOK = {
  mirrorStuck: {
    number: '3.1',
    title: 'Content is indexed but not reaching git',
    anchor: '31-content-is-indexed-but-not-reaching-git',
  },
  sourceConflict: {
    number: '3.2',
    title: 'A source is in conflict, or stuck ahead / behind',
    anchor: '32-a-source-is-in-conflict-or-stuck-ahead--behind',
  },
  reviewHostUnconfigured: {
    number: '3.3',
    title: 'A change request will not open — review_host_unconfigured',
    anchor: '33-a-change-request-will-not-open--review_host_unconfigured',
  },
  importFlagged: {
    number: '3.5(b)',
    title: 'Imported, then flagged — lint_failed_inbound',
    anchor: 'b-imported-then-flagged--lint_failed_inbound',
  },
  restoreFromBackup: {
    number: '3.8',
    title: 'Restoring from backup',
    anchor: '38-restoring-from-backup',
  },
  // §1 and §4 are chapters of unnumbered headings; the chapter number is the
  // honest "§" for them — inventing 4.3 would name a section the document lacks.
  whereThingsAre: {
    number: '1',
    title: 'Where things are',
    anchor: 'where-things-are',
  },
  rotateHostToken: {
    number: '4',
    title: 'Rotate a host token',
    anchor: 'rotate-a-host-token',
  },
  upgrade: {
    number: '4',
    title: 'Upgrade',
    anchor: 'upgrade',
  },
} as const satisfies Record<string, RunbookSection>;

/**
 * The runbook section for each System health check (review §4.9), keyed by the
 * server's stable check id (`SYSTEM_CHECK_IDS` in
 * `server/src/system-health/system-health.types.ts`).
 *
 * Unlike QUEUE_RUNBOOK this is TOTAL: every check is an operational question,
 * so every one has somewhere to read next. `checkRunbook.test.ts` reads the
 * server's id list and fails when a new check arrives without an entry here.
 * The pairing is by remedy, not by name — a corrupt database and a failed drill
 * both end at "restore from backup", a missing table at "migrations run on
 * start-up" (Upgrade), a missing token at rotating one.
 */
export const CHECK_RUNBOOK: Readonly<Record<string, RunbookSection>> = {
  database: RUNBOOK.restoreFromBackup,
  schema: RUNBOOK.upgrade,
  content_root: RUNBOOK.whereThingsAre,
  disk: RUNBOOK.whereThingsAre,
  sources: RUNBOOK.sourceConflict,
  secrets: RUNBOOK.rotateHostToken,
  git_outbox: RUNBOOK.mirrorStuck,
  mirror_state: RUNBOOK.mirrorStuck,
  conflicts: RUNBOOK.sourceConflict,
  restore_drill: RUNBOOK.restoreFromBackup,
};

/** The section for a check id, or null for an id this client does not know (a newer server). */
export function checkRunbook(checkId: string): RunbookSection | null {
  return Object.prototype.hasOwnProperty.call(CHECK_RUNBOOK, checkId) ? CHECK_RUNBOOK[checkId]! : null;
}

/**
 * The fix-it queues the runbook has a section for. Deliberately partial: most
 * queues are content decisions with no operational remedy, and a pointer at the
 * nearest-looking section would be a wrong answer rather than a missing one.
 */
export const QUEUE_RUNBOOK: Partial<Record<string, RunbookSection>> = {
  lint_failed_inbound: RUNBOOK.importFlagged,
};

/** `docs/operations-runbook.md#31-content-is-indexed-but-not-reaching-git`. */
export function runbookAddress(section: RunbookSection): string {
  return `${RUNBOOK_DOC}#${section.anchor}`;
}

/** One line naming the section, for a chip's `title` where there is no room to render it. */
export function runbookHint(section: RunbookSection, lead?: string): string {
  const head = `What to do: runbook §${section.number} — ${section.title}.`;
  return `${lead ? `${lead} ` : ''}${head} ${runbookAddress(section)}`;
}
