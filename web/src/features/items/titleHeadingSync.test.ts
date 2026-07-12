import { describe, expect, it } from 'vitest';
import { buildItemDraftMarkdown, syncFirstHeadingWithTitle } from './titleHeadingSync.js';

describe('title / first heading sync policy', () => {
  it('seeds new item drafts without duplicating the metadata title as a body H1', () => {
    expect(buildItemDraftMarkdown({ title: 'Operations Runbook' })).toBe([
      '## Overview',
      '',
      'Capture the purpose, context, and next action for this item.',
      '',
      '## Notes',
      '',
      '- Add details here.',
    ].join('\n'));
  });

  it('does not add a second Notes heading when composer body notes already start with a heading', () => {
    expect(buildItemDraftMarkdown({
      title: 'UX smoke test item',
      summary: 'Fresh-user authoring smoke test summary.',
      body: '## Notes\n- Verify create flow preselects the active Topic.',
    })).toBe([
      '## Overview',
      '',
      'Fresh-user authoring smoke test summary.',
      '',
      '## Notes',
      '- Verify create flow preselects the active Topic.',
    ].join('\n'));
  });

  it('preserves the normal Notes scaffold when composer body notes are plain text', () => {
    expect(buildItemDraftMarkdown({
      title: 'Plain body item',
      summary: 'Summary text.',
      body: 'Capture acceptance criteria and first thoughts here.',
    })).toBe([
      '## Overview',
      '',
      'Summary text.',
      '',
      '## Notes',
      '',
      'Capture acceptance criteria and first thoughts here.',
    ].join('\n'));
  });

  it('preserves an existing matching first H1 as authored body content when metadata title changes', () => {
    const markdown = ['---', 'title: Old Title', '---', '# Old Title', '', 'Body text.'].join('\n');

    expect(syncFirstHeadingWithTitle(markdown, 'Old Title', 'New Title')).toEqual({
      markdown: ['---', 'title: New Title', '---', '# Old Title', '', 'Body text.'].join('\n'),
      didSync: false,
      reason: 'first-heading-preserved',
    });
  });

  it('leaves manually edited first H1 content untouched when title metadata changes', () => {
    const markdown = ['---', 'title: Old Title', '---', '# Handwritten Heading', '', 'Body text.'].join('\n');

    expect(syncFirstHeadingWithTitle(markdown, 'Old Title', 'New Title')).toEqual({
      markdown: ['---', 'title: New Title', '---', '# Handwritten Heading', '', 'Body text.'].join('\n'),
      didSync: false,
      reason: 'first-heading-differs-from-title',
    });
  });
});
