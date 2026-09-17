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

That first step worked and then stalled. The bulk quarantine of 2026-08-13 tagged
55 tests in one commit with one boilerplate comment — *"fails against current UI;
not yet triaged"* — repeated verbatim on almost every one. Nobody had looked at any
of them. Issue 92 is what that turned into: a gate covering about half the suite,
with no owner or date on the other half. This document is now the register of what
is still excluded and who owes what.

## How it works

CI runs:

```
pnpm --filter @echozedlabs/web test:e2e:ci
# => node tests/e2e/clean-db.js && playwright test --grep-invert @quarantine
```

That runs **every spec that is not tagged `@quarantine`**. The default is
"in the gate" — quarantine is opt-out and must be written down. When someone
repairs a quarantined spec, deleting the `quarantine(...)` options object is all it
takes to rejoin CI.

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

Use the `quarantine()` helper from `web/tests/e2e/quarantine.ts` as Playwright's
per-test options object. Do **not** write `@quarantine` into a title by hand; the
register guard rejects that, because a tag in a title carries no owner and no date.

```ts
import { quarantine } from './quarantine.js';

test(
  'reload after save shows the updated body',
  quarantine({
    owner: 'eric',
    category: 'app-bug',
    reason: 'The save path never resolves; see 10-edit-mode-sync.',
    expires: '2026-12-10',
    issue: 99,
  }),
  async ({ signedInPage }) => { /* ... */ },
);
```

`category` must be one of these three, and you must have taken the failure at
least that far before you quarantine it. Quarantining an unexamined failure is how
a real bug gets buried — which is precisely what the 2026-08-13 bulk quarantine did.

1. **`app-bug`** — the test is right, the product is wrong. Open an issue in the
   tracker and put its id in `issue`.
2. **`test-rot`** — the product is right, the test encodes an old UI. Fix the test.
3. **`unknown`** — nobody has looked yet. Say so, and give it a *short* expiry.

The tag lives in Playwright's `tag` field rather than in the title (supported since
1.42; this repo is on 1.59), so `--grep-invert @quarantine` keeps working while the
title stays readable.

### The fourth answer: delete it

`test-rot` has two endings, and the register spent a month pretending it had one.
A test whose surface still exists somewhere gets **ported** — re-pointed at the
route the behaviour moved to, and re-read to check it still asserts something.
A test whose surface was **removed on purpose** gets deleted. It is not a debt; it
is a deletion that has not happened yet, and carrying it in this file as "someone
should repair this one day" is a lie about the product.

The rule that keeps that from becoming an excuse: **delete it because the thing it
tested is gone on purpose, never because it fails.** Before deleting, say where
the capability went. If it went somewhere, the test goes with it.

### What enforces this

`web/tests/e2e/quarantine-register.spec.ts` runs inside the gate and is itself
un-quarantinable. It fails if:

- any test carries a hand-written `@quarantine` in its title;
- any `quarantine()` call is missing an owner, a valid category, a reason, or a
  `YYYY-MM-DD` expiry;
- any expiry has passed — **an expired quarantine breaks the build**, which is the
  only mechanism that has ever stopped this register from rotting;
- any quarantined test is missing from the register below;
- any spec file carrying a file-level `test.skip(true, ...)` is missing from the
  register below. A wholesale skip is an exclusion too, and it is the quieter one.

When an expiry lands, the answer is to fix the test, fix the product, or set a new
date *with a reason for the extension*. Silently bumping the date is how the debt
becomes permanent.

**Read this whole file before editing it.** On 2026-09-11 a section-replacement
edit ran to end-of-file and silently truncated three sections; the guard could not
catch it, because a register that is missing a section it never had a row for still
passes.

## Currently quarantined

**None, as of 2026-09-11.** When there is one, the title below has to come from a
`quarantine()` call in `web/tests/e2e/**`, and `quarantine-register.spec.ts` fails
the gate if it is missing here.

### ~~`admin-topics.spec.ts`~~ — un-quarantined 2026-09-11, issue **110** fixed

- lists existing topics from Admin and creates a topic in a modal

Re-diagnosed from `unknown` on 2026-09-11, then paid off the same day. Half the
failure was test rot — Admin left the sidebar for the user dropdown — and that half
was fixed first. The other half was the product: `/admin/topics` rendered `h1`
"Spaces", the sentence "Manage the Space catalog separately from article editing",
and a table labelled "Space catalog", while the sidebar, the topics index, the
landing pages, the Publish drawer, the browse filter chips, the route
(`/admin/topics`) and the API (`/api/v1/topics`) all said Topic.

The test asserted the plan's word. Rewriting it to assert "Spaces" would have made
the suite green by teaching it the stale term, which is how a UI inconsistency
becomes permanent — so it stayed quarantined as `app-bug` until the page agreed.
Eric chose Topic on 2026-09-11 and the copy pass landed; the `quarantine()` call is
gone and both tests in the file run in the gate.

Un-quarantining it surfaced two more rotten lines in the same test, neither about
vocabulary, both now fixed rather than worked around: it asserted that no button on
`/` is named "Topics" (the §3.4 sidebar has a durable Topics destination — the test
now clicks it and checks it lands on the public `/topics` index, which is the
distinction the line was reaching for), and it asked for a heading named exactly
"Admin" (the admin console's `h1` is "Admin console"). That is the ordinary cost of
a quarantine: a test nobody runs rots past the line that quarantined it.

## Wholesale skips

A file-level `test.skip(true, ...)` hides a whole suite from every run, local
included, and reports as "skipped" rather than as a debt. It needs a row here for
the same reason a quarantine does, and the register guard enforces that.

**There are none.** The only entry this section ever had —
`08-frontmatter-strip.spec.ts`, 20 tests — was deleted on 2026-09-11 along with the
component it tested. See "Retired on 2026-09-11" below.

## Skips that are not debt

For completeness, so the "skipped" count in a run is never mysterious. Three, all
told:

- `03-editor.spec.ts` (1) and `05-search.spec.ts` (1) are empty `test.skip`
  placeholders with no body — tombstones that keep the old scenario names
  greppable and point at where the coverage went. They assert nothing and they
  hide nothing.
- `large-library-scale.spec.ts` (1) is an opt-in scale gate, enabled with
  `LARGE_LIBRARY_BROWSER=1`. A conditional skip is a gate, not an exclusion.

`03-editor.spec.ts` used to carry two more tombstones, both pointing at
`08-frontmatter-strip.spec.ts`. They were deleted with it: a pointer to a deleted
file is worse than no pointer.

## Retired on 2026-09-11

The Compose consolidation (issues 103 and 104) removed three surfaces outright.
Every test below was excluded from the gate and is now **deleted**, because what it
asserted is gone on purpose. Each group says what the surface was and, where the
capability survived, where it went — the tests that went with it are listed under
"Ported", not here.

### The FrontmatterStrip suite — issue 103

`web/src/components/FrontmatterStrip.tsx` was deleted. The metadata surface it
described is Compose's Publish drawer, which `compose.spec.ts` covers. The four
components that only it used —
`web/src/components/frontmatter/{Fields,StatusPopover,TagsEditor,YamlEditor}.tsx` —
were deleted at the same time, verified orphaned by grep first.

- `08-frontmatter-strip.spec.ts` — 20 tests, the whole file (the wholesale skip).
- `12-frontmatter-always-visible.spec.ts` — 8 tests, the whole file: strip visible
  in hybrid / preview / WYSIWYG mode; title edit syncing to WYSIWYG; status change
  syncing to source-mode YAML; tags field editable in all modes; strip visible with
  long body content; frontmatter surviving mode cycles.

Also trimmed: `web/src/styles/dark-tailwind-compat.css` existed to remap the fixed
Tailwind colour utilities used by components that never adopted the design tokens.
Most of it is still load-bearing — `ConflictDialog`, `RenameDialog` and
`FrontmatterPanel` (still reached through the Publish drawer's Advanced section)
use those utilities heavily. Five selectors were only ever used by the four deleted
components and were removed: `.bg-blue-100`, `.hover\:bg-slate-100:hover`,
`.hover\:text-blue-900:hover`, `.text-blue-800`, `.text-green-600`. The patch layer
shrank; it did not go.

### The modal new-item composer — issue 104

Creation is a route now: `/new?type=<key>`, seeded from browse context.
`/browse?new=<type>` forwards there rather than opening a dialog.

- `new-item-composer.spec.ts` — the whole file (4 tests: composer create with
  metadata; explicit cancel; create failures shown in the dialog; category choices
  managed from settings, a `/browse?view=settings` screen that now redirects to
  `/profile`).
- `ui-data-entry-mvp.spec.ts` — 1 test, a smoke run through the composer. Its one
  irreplaceable assertion, the duplicate-title refusal, was ported.
- `topic-aware-create-edit.spec.ts` — 1 test. Drove the composer's topic default
  and `.kp-edit-topic-select`, neither of which exists.
- `next-wave-demo.spec.ts` — 1 test, a five-feature demo smoke. Every half of it
  that survived is covered by `copyable-content.spec.ts`,
  `topic-navigation.spec.ts` and `item-properties-default.spec.ts`; the composer
  and read-mode-properties halves are gone.

### PageView's inline edit shell — issue 104

`web/src/pages/PageView.tsx` is a read surface (1149 → 446 lines). Editing is
`/p/:slug/edit`, which renders Compose. `?edit=1` forwards there.

- `item-editor.spec.ts` — the whole file. Three tests asserted the retired shell
  itself (the "Edit knowledge item" heading, `.kp-edit-savebar`,
  `.kp-edit-editor-frame` geometry, and a wide-screen rule that the redesigned read
  page deliberately reverses by keeping a right rail). Two were ported.
- `editor-chrome-feedback.spec.ts` — the whole file (3 tests). Measured
  `.kp-edit-titlebar` / `.kp-edit-savebar` geometry inside that shell.
- `item-taxonomy-entry.spec.ts` — 1 test. It asserted that taxonomy is *not*
  editable from the editor. Compose's Publish drawer deliberately reverses that,
  and `compose.spec.ts` asserts the drawer instead.
- `item-properties-default.spec.ts` › *read mode hides item properties until
  explicitly toggled on* — the read page has no properties toggle; properties live
  in the right context pane. The editor half of that file was kept and ported.
- `item-title-heading.spec.ts` › *explains title metadata versus Markdown H1
  content in edit mode* — explanatory copy the shell carried and Compose does not.
- `taxonomy-dropdown-consistency.spec.ts` — the whole file. Test 1 was ported to
  the Publish drawer; test 2 asserted info-icon tooltips that only the composer had.
- `search-browse.spec.ts` › *one-command cards expose copy without triggering card
  navigation* — the browse card used to infer a command from a one-line body and
  render it as `.PageList__CommandPreview`. `extractCopyableEntries` now only
  yields explicit frontmatter `copy:` entries, which `copyable-content.spec.ts`
  covers on both the card and the read page.
- `item-linking.spec.ts` › the assertion that the editor carries **no** page
  search. Compose reverses that deliberately: the host toolbar's link search is
  how an author inserts an id-backed link at all, and the rest of that test
  follows exactly such a link through the backlink index. The test now asserts
  the control is present, and keeps the round-trip.
- `grouped-topic-browse.spec.ts` › the six-card preview cap and the "See all N
  Research items" button. The grouped layout replaced both with an
  infinite-scroll window; each group now states "Showing N of M items by current
  sort", which is the same promise made honestly, and the test asserts that.
- `grouped-browse-scrollspy.spec.ts` (was `main-page-search-scrollspy.spec.ts`) ›
  *search entry filters the main page instead of opening a result picker modal* —
  asserted that the Search control filters the page you are on. Search is a route
  now (§3.4); `search-page.spec.ts` covers what it does instead.
- `13-keyboard-help.spec.ts` › *top bar no longer shows Search and Help is a normal
  page* — asserted a header with no search control at all. The header keeps exactly
  one, the ⌘K jump pill, and §3.4 keeps it there on purpose. Replaced by a test
  that asserts there is still only one.
- `14-toolbar-responsive.spec.ts` — 4 tests, rewritten rather than repaired. They
  were built around a "More" overflow button the editor has never had, each one
  guarded behind `if (moreExists)` or a "best-effort" comment, so four of the five
  could not fail for any product reason. The file now names the two toolbars that
  actually exist (`me-toolbar` "Editor controls" and `me-wysiwyg-toolbar` "Rich
  text formatting controls" — the pair that tripped strict mode) and asserts what a
  375px author needs.

## Ported on 2026-09-11

Where a capability moved rather than vanished, the test moved with it. These are
in the gate, un-quarantined:

| behaviour | was | is now |
| --- | --- | --- |
| duplicate-title 409 | `ui-data-entry-mvp`, `item-save-validation` (pre-PUT block) | `item-save-validation.spec.ts` — Compose lets the server answer and `saveOutcome` classifies it; the test asserts the sentence, the instruction, that it is *not* a ConflictDialog, and that nothing was written |
| the save toast's Retry | `11-dirty-and-toast.spec.ts` | unchanged and already passing; the dirty *dot* went with the shell, so the two dirty tests now read the footer's words and the title bullet |
| window-level Esc and Cmd+S | `item-editor.spec.ts` (editor-scoped Ctrl+S) | `compose.spec.ts` — Ctrl+S from the writing area keeps the caret; Cmd+S from the *title field* saves, and Esc leaves for the read page |
| read-only-source refusal | nowhere (only the read page's withdrawn Edit) | `external-source.spec.ts` — arriving at `/p/:slug/edit` by URL is refused up front, with the upstream link and no editor |
| `?edit=1` redirecting | `title-edit-focus`, `item-save-validation` and others used it incidentally | `compose.spec.ts` › *the doors into Compose* — asserts the forward and that it `replace`s, so Back is not a trampoline |
| `/browse?new=X` redirecting | `new-item-composer.spec.ts` (as a dialog) | `compose.spec.ts` › *the doors into Compose* — including the sidebar's own New item button |
| taxonomy dropdowns match the catalog | `taxonomy-dropdown-consistency.spec.ts` | `compose.spec.ts` — the Publish drawer's Topic and Primary category options |
| create seeded from an empty search | `search-browse.spec.ts` (composer dialog) | `search-browse.spec.ts` — `/new?title=…&tag=…`, confirmed in the Publish drawer |
| a save failure next to the Save action | `item-editor.spec.ts` | `compose.spec.ts` |
| j/k scope, card semantics, filter chips, scrollspy, topic drawer, copyable content, URL restore | the item list on `/` | the same tests on `/browse` (and `/browse?view=grouped` for the scrollspy) |

## Where the gate stands, 2026-09-11

| | suite | gate | passed | skipped | failed |
| --- | --- | --- | --- | --- | --- |
| before the Compose consolidation (as recorded) | 191 | 139 | 115 | 25 | 0 |
| after it landed, measured | 191 | 140 | **89** | 25 | **26** |
| after this cleanup | 150 | 149 | **146** | 3 | **0** |
| after issue 110 un-quarantined the witness | 150 | 150 | **147** | 3 | **0** |

The middle row is the one that matters and it was not in any brief: the
consolidation landed 26 failures into a gate everyone believed was green, because
nobody had run it since. That is the same failure mode the register exists to
prevent, one level up — a gate is only a gate while somebody runs it.

The last row's six-failure full run is reconciled below; every one of them was the
same infrastructure flake, and all six pass on a clean re-run.

### The one flake, named

The final full run reported 6 failed. All six were `page.waitForURL` timeouts in
the sign-in fixture or `connect ECONNREFUSED ::1:3001` — the e2e API server
restarting *during* the run. Re-run file by file, all six pass. The cause is
issue 111: `playwright.config.ts` starts the API with `pnpm ... dev`, which is
`node --watch`, so any edit to the working tree while a run is in flight can
knock the fixture over. On this repo, worked on by several agents at once, that
is not a hypothetical. Copy the log and `web/test-results` before re-running (issue
95, lesson 66) — both runs' logs and artefacts were kept for this one.

## Primary categories became curated, mid-cleanup

Three `compose.spec.ts` tests that had been green went red during this work, and
none of them was rot: primary categories became a curated catalog the same day
(Eric, 2026-09-11). The Publish drawer now offers `?curated=1` — "what may I
publish into" — rather than the unfiltered list, which is "what exists" and
includes emergent terms an author must not be able to pick; it writes the
category **slug**, which is what the publish gate lints against; and a
`lint_failed` refusal names the drawer CONTROL ("Primary category") rather than
the raw frontmatter key. The tests were updated to match, and the shared
`ensureCategory` helper now returns the slug — seeding a display name produces an
item the gate then refuses, which reads as a UI bug and is not one.

## New coverage on 2026-09-11

`web/tests/e2e/search-page.spec.ts`, mapped to `features/10-grouped-search.feature`
— `/search` had none. Five tests: the query in the URL and Back/Forward; the
server's groups rendering with their "See all N in Browse" links; a content-type
chip narrowing and clearing; the empty state and its hint; and the doors to Browse
and to the tag view, which is how a reader reaches either now that both left the
sidebar.

`features/08-app-chrome-and-help.feature` was revised where it described chrome
that changed: the header's single jump-to-a-page control, and the product mark as
the sidebar's expand affordance.

## The navigation change (§3.4)

Browse and Tags are no longer sidebar entries and Search is a route rather than a
palette action, so three specs that asserted the old rail were fixed rather than
quarantined:

- `grouped-search.spec.ts` › *sidebar hub destinations* — now asserts the exact
  list, `['Home', 'Topics', 'Latest', 'Review', 'Sections', 'Search']`, and that
  Search navigates rather than opening the palette.
- `sources-admin.spec.ts` — dropped Browse and Tags from the labels it walks.
- `latest-feed.spec.ts` — Home's search box hands off to `/search`, not `/browse`.
- `list-card-semantics.spec.ts` — the card's edit pencil opens `/p/:slug/edit`.
  Several card tests also stopped clicking cards by pixel position: the pencil
  overlaps the old click point, so a positional click now lands in Compose. They
  drive the card's named "Open <title>" action instead, the way
  `list-card-semantics.spec.ts` always did.

## ~~The Topic / Space vocabulary~~ (issue 110) — RESOLVED 2026-09-11

Running the ported browse tests surfaced the same product inconsistency the
admin quarantine named, but wider than one page. The browse surface said
**Space** where the model, the API, the sidebar, the topic pages, the Publish
drawer and the plan all say **Topic**: the switcher chip read "Space:", its
drawer was the "Space directory" with "Search spaces", the active-filter chip
read "Space: X", the grouped scrollspy was headed "Spaces", the card footer fell
back to "Default space", and `/admin/topics` rendered "Spaces" over a
"Space catalog" — with a rename dialog whose heading said "Rename Topic" and
whose field said "Space name". The *code* in all of these said topic
(`routeTopic`, `activeTopic`, `topicForPage`, `topicDirectory`); only the copy
disagreed.

One test was quarantined as the witness (`admin-topics.spec.ts`, above). The
rest asserted the word the surface used, each with a comment pointing at issue
110, because quarantining a dozen tests over vocabulary would have cost the
browse coverage and bought nothing the witness did not already buy.

Eric chose **Topic everywhere** (2026-09-11) and the copy changed in one pass —
rendered text, `aria-label`, `title` and `placeholder` alike — across
`AdminTabs`, `AdminHome`, `TopicAdmin`, `TagGroupAdmin`, `SectionsAdmin`,
`OkfAdmin`, `Home`, `PageView`, `PageList`, `TopicSwitcher`, the header's
`SpaceSwitcher` (the component keeps its name; only what it renders changed),
`PublishDrawer` and `ItemEditorHostConfig`. Nothing structural moved: no API
field, database column, route, query param, component name, CSS class or test id
was touched, so `space_id`, `?space=`, the legacy `space:` frontmatter alias and
`SpaceSwitcher` all still read as they did. The witness is un-quarantined and the
specs that carried the "issue 110" comments — `grouped-browse-scrollspy`,
`grouped-topic-browse`, `search-filter-url`, `topic-navigation`, `okf-admin`,
`admin-topics` — assert the new word with the comments removed.

## De-quarantined on 2026-09-11

Four of the fifty-five passed on the first honest run and rejoined the gate,
each after three consecutive green runs:

- `03-editor.spec.ts` — "# " at line start becomes a heading-1; "- " at line
  start becomes a bullet list.
- `item-title-heading.spec.ts` — preserves an imported first H1 even when it
  matches the old metadata title; does not rewrite a manually authored first H1
  when title metadata changes.

All four had been tagged by the 2026-08-13 bulk quarantine with the same
boilerplate sentence: *"fails against current UI; not yet triaged."* They did not
fail against the current UI. Nobody had run them.

## ~~The OKF import round-trip~~ — FIXED and back in the gate, 2026-09-11

The only quarantine this work found by writing a new test rather than by running an
old one, and the only one that was the product's fault rather than the test's.
`OkfAdmin.runImport` read `result.conformance.conformant`; `POST /okf/import` has
never answered with a `conformance` field, so importing a bundle through Admin →
Data rendered "Cannot read properties of undefined (reading 'conformant')" where the
import result should be — while the import itself **succeeded**. The surface that
makes "your content is yours" operable told an operator their restore had crashed
when it had not, and had done so since 2026-08-13.

Fixed the same day the test found it (issue 105): the page reads the bundle gate's
three-tier `validation` report, optional-chained so that a door which does not run
the gate cannot turn a successful import into a failure a second time. A bundle that
genuinely fails the CONFORMANCE tier never reaches that code — it is refused whole
with 422 `bundle_not_conformant` — so what the page reports now is a policy finding:
the content imported and does not meet this instance's rules.

`okf-admin.spec.ts` "exports one space as a conformant bundle and re-imports it in
place" carries no quarantine and runs in the gate. **This is the register working as
intended**: a test written against what the page promises, quarantined honestly while
the product disagreed, and un-quarantined the moment it stopped.
