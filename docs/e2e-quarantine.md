# e2e quarantine

## Why this exists

The Playwright suite was never run in CI — `test.yml` ran `pnpm -r test`, which is
unit tests only. Over time the app changed and the specs did not, so a large part
of the suite encoded UI that no longer exists. By the time anyone looked, the
failures were dense enough that "just fix the suite" was a multi-day job, which is
exactly how a test suite stays broken forever.

The way out is not to fix everything at once. It is to make a known-good subset
**gate CI immediately**, so it can never rot again, and to mark the rest explicitly
as known-broken with a reason. A quarantined test is a debt with a name on it; a
test suite nobody runs is a debt with nobody's name on it.

## How it works

CI runs:

```
pnpm --filter @echozedlabs/web test:e2e:ci
# => node tests/e2e/clean-db.js && playwright test --grep-invert @quarantine
```

That runs **every spec that is not tagged `@quarantine`**. The default is
"in the gate" — quarantine is opt-out and must be written down. When someone
repairs a quarantined spec, deleting the tag is all it takes to rejoin CI.

Locally, `pnpm test:e2e` still runs the *entire* suite, quarantined tests included.
That is deliberate: the full picture stays one command away.

## Always clean the database

`pnpm test:e2e` and `test:e2e:ci` both run `clean-db.js` first. Running
`npx playwright test` directly **skips it** and reuses a dirty database, which
produces failures that look real but are not — most visibly `409` conflicts, since
duplicate titles in a topic are now rejected (`assertTitleAvailableInSpace`).

If you see unexplained 409s, you almost certainly bypassed `clean-db.js`.
Use `KEEP_DB=1` only when you deliberately want the previous state.

## Quarantining a test

Add the tag to the title, plus a comment saying *why* and what would fix it:

```ts
// @quarantine — editor save hangs (pre-existing app bug, not test rot).
// Un-quarantine once the save path resolves; see 10-edit-mode-sync.
test('reload after save shows the updated body @quarantine', async ({ ... }) => {
```

A quarantine comment must say which of these it is:

1. **App bug** — the test is right, the product is wrong. Fix the product.
2. **Test rot** — the product is right, the test encodes an old UI. Fix the test.
3. **Unknown** — nobody has looked yet. Say so honestly.

Never quarantine a failure you have not diagnosed to at least that granularity.
Quarantining an unexamined failure is how a real bug gets buried.

## Currently quarantined

See `git grep '@quarantine' web/tests/e2e` for the live list — this document does
not duplicate it, because a hand-maintained list would drift out of date, which is
the same failure mode that produced this document.

The main cluster is the **editor save/sync** specs (`03-editor` input rules,
`10-edit-mode-sync`, `11-dirty-and-toast`, `12-frontmatter-always-visible`). These
point at a known save-path bug that predates this work, so they are category 1
above: the tests are likely correct and the product needs the fix.
