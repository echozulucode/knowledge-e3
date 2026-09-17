/**
 * The quarantine convention (issue 92).
 *
 * A quarantined test is excluded from the CI gate
 * (`playwright test --grep-invert @quarantine`). That exclusion is a debt, so
 * it has to carry a name, a diagnosis, and a date it stops being acceptable —
 * otherwise the register drifts back into "55 tests nobody has looked at",
 * which is exactly what this convention replaced.
 *
 * Use it as Playwright's per-test options object (supported since 1.42; this
 * repo is on 1.59):
 *
 * ```ts
 * test(
 *   'reload after save shows the updated body',
 *   quarantine({
 *     owner: 'eric',
 *     category: 'app-bug',
 *     reason: 'The save path never resolves; see 10-edit-mode-sync.',
 *     expires: '2026-12-10',
 *     issue: 99,
 *   }),
 *   async ({ signedInPage }) => { ... },
 * );
 * ```
 *
 * The tag goes in the `tag` field rather than in the title, so `--grep-invert
 * @quarantine` keeps matching (Playwright greps title *and* tags) while the
 * title stays readable. `quarantine-register.spec.ts` enforces the rest: no
 * hand-written `@quarantine` in a title, every field filled in, and an expiry
 * that has not passed.
 */

/**
 * Which of the three diagnoses this is. Never quarantine a failure you have not
 * taken at least this far — an unexamined failure is how a real bug gets buried.
 *
 *  - `app-bug`   the test is right and the product is wrong. File the bug.
 *  - `test-rot`  the product is right and the test encodes an old UI. Fix the test.
 *  - `unknown`   nobody has looked yet. Say so, and give it a short expiry.
 */
export type QuarantineCategory = 'app-bug' | 'test-rot' | 'unknown';

export interface QuarantineInput {
  /** Who is accountable for clearing it. A person, not a team. */
  owner: string;
  category: QuarantineCategory;
  /** What is wrong and what would un-quarantine it. One or two sentences. */
  reason: string;
  /** `YYYY-MM-DD`. Past this date the register guard fails the gate. */
  expires: string;
  /** The tracker id of the issue following it, where one exists. */
  issue?: number;
}

/** Playwright per-test options carrying the tag and the accountability record. */
export function quarantine(input: QuarantineInput): {
  tag: string[];
  annotation: { type: string; description: string }[];
} {
  return {
    tag: ['@quarantine'],
    annotation: [
      { type: 'quarantine-owner', description: input.owner },
      { type: 'quarantine-category', description: input.category },
      { type: 'quarantine-reason', description: input.reason },
      { type: 'quarantine-expires', description: input.expires },
      ...(input.issue === undefined
        ? []
        : [{ type: 'quarantine-issue', description: `issue #${input.issue}` }]),
    ],
  };
}
