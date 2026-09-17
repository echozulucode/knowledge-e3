import { describe, expect, it } from 'vitest';
import { drawerFieldLabel, saveOutcome } from './saveErrors.js';

const EXISTING = { hasItem: true };
const NEW = { hasItem: false };

describe('saveOutcome', () => {
  it('treats a bare 409 on an existing item as a version conflict', () => {
    expect(saveOutcome({ statusCode: 409, message: 'Version conflict' }, EXISTING)).toEqual({ kind: 'version-conflict' });
  });

  it('separates the duplicate-title 409 from the version conflict and says what to do', () => {
    expect(saveOutcome({ statusCode: 409, message: 'An item titled "Retry budgets" already exists in this topic' }, EXISTING)).toEqual({
      kind: 'duplicate-title',
      message: 'An item titled "Retry budgets" already exists in this topic. Choose a unique title before saving.',
    });
  });

  it('reports the duplicate title on the very first save too, where there is no version to conflict with', () => {
    expect(saveOutcome({ statusCode: 409, message: 'An item titled "Retry budgets" already exists in this topic' }, NEW).kind).toBe(
      'duplicate-title',
    );
  });

  it('never reports a version conflict while the item has not been created yet', () => {
    expect(saveOutcome({ statusCode: 409, message: 'Conflict' }, NEW)).toEqual({
      kind: 'failed',
      message: 'Save failed: Conflict',
    });
  });

  it('maps changed_on_disk to its own outcome, not to the version conflict', () => {
    const outcome = saveOutcome(
      { statusCode: 409, reason: 'changed_on_disk', message: 'The file for this item changed on disk since it was last indexed (main/a.md)' },
      EXISTING,
    );
    expect(outcome.kind).toBe('changed-upstream');
    expect(outcome).toHaveProperty('message', expect.stringContaining('changed outside the app'));
  });

  /**
   * Plan §6, R4.3: the server's sentence names the registry id and reaches for
   * Git vocabulary. That belongs in the log and in Admin → Sources; an author
   * gets a sentence about the page.
   */
  it('states source_read_only in reader words, never the server registry id', () => {
    expect(saveOutcome({ statusCode: 403, reason: 'source_read_only', message: 'Source topic:vendor is read-only; edits belong upstream' }, EXISTING)).toEqual({
      kind: 'read-only-source',
      message: 'This page is maintained by another team, so it cannot be edited here.',
    });
  });

  it('states review_unsupported_operation in reader words too', () => {
    expect(
      saveOutcome({ statusCode: 409, reason: 'review_unsupported_operation', message: 'topic move is not yet supported in a review-mode source (topic:docs)' }, EXISTING),
    ).toEqual({
      kind: 'review-unsupported',
      message: 'This kind of change cannot be made to this page yet.',
    });
  });

  it('says the same thing when the reasoned refusal carries no message at all', () => {
    expect(saveOutcome({ statusCode: 403, reason: 'source_read_only' }, EXISTING)).toEqual({
      kind: 'read-only-source',
      message: 'This page is maintained by another team, so it cannot be edited here.',
    });
    expect(saveOutcome({ statusCode: 409, reason: 'review_unsupported_operation', message: '  ' }, EXISTING)).toEqual({
      kind: 'review-unsupported',
      message: 'This kind of change cannot be made to this page yet.',
    });
  });

  it('maps lint_failed to a fixable list, keeping each diagnostic and its frontmatter key', () => {
    const outcome = saveOutcome(
      {
        statusCode: 422,
        reason: 'lint_failed',
        message: 'This item cannot be published until 2 content-model error(s) are fixed',
        diagnostics: [
          { code: 'type.missing', severity: 'error', message: 'Frontmatter `type` is required', path: 'type' },
          { code: 'description.missing', severity: 'error', message: '`description` is required to publish', path: 'description' },
        ],
      },
      EXISTING,
    );
    expect(outcome).toEqual({
      kind: 'lint-failed',
      message: 'This item cannot be published until 2 content-model error(s) are fixed',
      diagnostics: [
        { code: 'type.missing', message: 'Frontmatter `type` is required', path: 'type' },
        { code: 'description.missing', message: '`description` is required to publish', path: 'description' },
      ],
    });
  });

  it('keeps a lint_failed diagnostic that names no frontmatter key, and drops malformed entries', () => {
    const outcome = saveOutcome(
      {
        statusCode: 422,
        reason: 'lint_failed',
        message: 'Nope',
        diagnostics: [{ code: 'category.missing', severity: 'error', message: 'Exactly one primary category is required' }, null, { code: 7 }, 'boom'],
      },
      EXISTING,
    );
    expect(outcome).toEqual({
      kind: 'lint-failed',
      message: 'Nope',
      diagnostics: [{ code: 'category.missing', message: 'Exactly one primary category is required' }],
    });
  });

  it('falls back to its own sentence when lint_failed carries no body', () => {
    expect(saveOutcome({ statusCode: 422, reason: 'lint_failed' }, NEW)).toEqual({
      kind: 'lint-failed',
      message: 'This item cannot be published until its content-model errors are fixed.',
      diagnostics: [],
    });
  });

  it('classifies a reasoned refusal even before the item exists', () => {
    expect(saveOutcome({ statusCode: 403, reason: 'source_read_only', message: 'Source main is read-only' }, NEW).kind).toBe(
      'read-only-source',
    );
  });

  it('ignores a reason it does not know', () => {
    expect(saveOutcome({ statusCode: 409, reason: 'something_new', message: 'Nope' }, EXISTING)).toEqual({
      kind: 'version-conflict',
    });
  });

  it('names the Publish-drawer control a diagnostic points at', () => {
    // The refusal renders as a fixable list; naming the control beats naming a
    // YAML key the author may never have typed. `categories` matters most now
    // that primary categories are curated (Eric, 2026-09-11): both
    // `category.missing` and `category.unknown` are fixed at the same picker.
    expect(drawerFieldLabel('categories')).toBe('Primary category');
    expect(drawerFieldLabel('e3_categories')).toBe('Primary category');
    expect(drawerFieldLabel('description')).toBe('Description');
    expect(drawerFieldLabel('type')).toBe('Content type');
    // Unmapped keys fall back to the raw path at the call site.
    expect(drawerFieldLabel('body')).toBeUndefined();
    expect(drawerFieldLabel(undefined)).toBeUndefined();
  });

  it('reports anything else as a failure, with or without a message', () => {
    expect(saveOutcome({ statusCode: 400, message: 'invalid taxonomy' }, EXISTING)).toEqual({
      kind: 'failed',
      message: 'Save failed: invalid taxonomy',
    });
    expect(saveOutcome({ statusCode: 500 }, EXISTING)).toEqual({ kind: 'failed', message: 'Save failed. Please try again.' });
    expect(saveOutcome(undefined, EXISTING)).toEqual({ kind: 'failed', message: 'Save failed. Please try again.' });
    expect(saveOutcome('boom', EXISTING)).toEqual({ kind: 'failed', message: 'Save failed. Please try again.' });
  });
});
