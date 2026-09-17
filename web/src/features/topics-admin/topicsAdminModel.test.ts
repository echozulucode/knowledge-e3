import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TOPIC_ID,
  LANDING_MARKDOWN_MAX,
  archiveBlockedReason,
  createdMessage,
  draftFromTopic,
  filterTopics,
  isDraftDirty,
  makePublicConfirmation,
  markdownLength,
  missingPresentationChoices,
  presentationLabel,
  readTopicsSearch,
  sectionsOnLanding,
  sourceForTopic,
  startHereProblem,
  topicFilterCounts,
  updateBodyFromDraft,
  validateTopicDraft,
  writeTopicsSearch,
  type TopicRow,
} from './topicsAdminModel.js';

function topic(overrides: Partial<TopicRow> & { slug: string }): TopicRow {
  return {
    id: `space_${overrides.slug}`,
    name: overrides.slug,
    description: null,
    counts: { items: 0, published: 0, draft: 0 },
    ...overrides,
  };
}

const ops = topic({ slug: 'ops', name: 'Operations', description: 'Runbooks and on-call', visibility: 'private', counts: { items: 3, published: 2, draft: 1 } });
const arch = topic({ slug: 'arch', name: 'Architecture', counts: { items: 0, published: 0, draft: 0 } });
const hr = topic({ slug: 'hr', name: 'hr people', visibility: 'private' });

describe('presentation choices', () => {
  it('cover every profile the landing renders', () => {
    expect(missingPresentationChoices()).toEqual([]);
  });

  it('label a profile, falling back to Wiki for a topic that predates the field', () => {
    expect(presentationLabel('portal')).toBe('Portal');
    expect(presentationLabel(undefined)).toBe('Wiki');
  });
});

describe('list search and filters', () => {
  it('reads the URL, ignoring an unknown filter', () => {
    expect(readTopicsSearch({ q: 'ops', filter: 'private' })).toEqual({ q: 'ops', filter: 'private' });
    expect(readTopicsSearch({ filter: 'archived' })).toEqual({ q: '', filter: 'all' });
    expect(readTopicsSearch(undefined)).toEqual({ q: '', filter: 'all' });
  });

  it('writes only what is set', () => {
    expect(writeTopicsSearch({ q: '  ', filter: 'all' })).toEqual({});
    expect(writeTopicsSearch({ q: ' ops ', filter: 'empty' })).toEqual({ q: 'ops', filter: 'empty' });
  });

  it('filters Private and Empty, searches name, slug and description, and sorts by name', () => {
    const all = [ops, arch, hr];
    expect(filterTopics(all, { q: '', filter: 'all' }).map((t) => t.slug)).toEqual(['arch', 'hr', 'ops']);
    expect(filterTopics(all, { q: '', filter: 'private' }).map((t) => t.slug)).toEqual(['hr', 'ops']);
    expect(filterTopics(all, { q: '', filter: 'empty' }).map((t) => t.slug)).toEqual(['arch', 'hr']);
    expect(filterTopics(all, { q: 'ON-CALL', filter: 'all' }).map((t) => t.slug)).toEqual(['ops']);
    expect(filterTopics(all, { q: 'arch', filter: 'private' })).toEqual([]);
  });

  it('counts each chip over the whole catalog', () => {
    expect(topicFilterCounts([ops, arch, hr])).toEqual({ all: 3, private: 2, empty: 2 });
  });
});

describe('archiveBlockedReason', () => {
  it('blocks a topic with items, drafts included, naming how many', () => {
    expect(archiveBlockedReason(ops)).toBe('Has 3 items');
    expect(archiveBlockedReason(topic({ slug: 'one', counts: { items: 1, published: 0, draft: 1 } }))).toBe('Has 1 item');
  });

  it('blocks the default topic, and allows an empty one', () => {
    expect(archiveBlockedReason({ id: DEFAULT_TOPIC_ID, counts: { items: 0, published: 0, draft: 0 } })).toBe('The default topic cannot be archived');
    expect(archiveBlockedReason(arch)).toBeNull();
  });
});

describe('makePublicConfirmation', () => {
  it('names the topic and counts only published items', () => {
    const c = makePublicConfirmation(ops, 'public');
    expect(c.title).toBe('Make Operations public?');
    expect(c.consequences[0]).toBe('2 published items become readable by anonymous visitors.');
    expect(c.consequences).toHaveLength(3);
  });

  it('uses the singular, and says when nothing is published yet', () => {
    expect(makePublicConfirmation(topic({ slug: 'x', counts: { items: 1, published: 1, draft: 0 } }), 'public').consequences[0]).toBe(
      '1 published item becomes readable by anonymous visitors.',
    );
    expect(makePublicConfirmation(arch, 'public').consequences[0]).toMatch(/^No published items become readable yet/);
  });

  it('says nothing is exposed while the instance requires sign-in', () => {
    expect(makePublicConfirmation(ops, 'authenticated').consequences.at(-1)).toMatch(/requires signing in/);
  });
});

describe('markdownLength', () => {
  it('counts against the server limit', () => {
    expect(markdownLength('hello')).toMatchObject({ count: 5, max: LANDING_MARKDOWN_MAX, over: false, error: null, label: '5 / 20,000 characters' });
  });

  it('is over by the exact amount past the limit, and exactly at the limit is fine', () => {
    expect(markdownLength('a'.repeat(LANDING_MARKDOWN_MAX)).over).toBe(false);
    const over = markdownLength('a'.repeat(LANDING_MARKDOWN_MAX + 2));
    expect(over.over).toBe(true);
    expect(over.error).toBe('2 characters over the limit. Shorten the landing text to save.');
  });
});

describe('draft', () => {
  it('starts from the topic with defaults for absent fields', () => {
    expect(draftFromTopic(arch)).toEqual({ name: 'Architecture', description: '', visibility: 'public', presentation: 'wiki', start_here: '', landing_markdown: '' });
  });

  it('is dirty only when a field differs', () => {
    const initial = draftFromTopic(ops);
    expect(isDraftDirty(initial, { ...initial })).toBe(false);
    expect(isDraftDirty(initial, { ...initial, presentation: 'portal' })).toBe(true);
    expect(isDraftDirty(null, initial)).toBe(false);
  });

  it('requires a name and a landing text within the limit', () => {
    const draft = draftFromTopic(ops);
    expect(validateTopicDraft(draft)).toEqual({});
    expect(validateTopicDraft({ ...draft, name: '  ', landing_markdown: 'a'.repeat(LANDING_MARKDOWN_MAX + 1) })).toEqual({
      name: 'Enter a name.',
      landing_markdown: '1 character over the limit. Shorten the landing text to save.',
    });
  });

  it('sends every field trimmed, so an emptied description or start here is cleared', () => {
    expect(updateBodyFromDraft({ name: ' Ops ', description: '  ', visibility: 'public', presentation: 'docs', start_here: ' ', landing_markdown: '  # Hi\n' })).toEqual({
      name: 'Ops',
      description: '',
      visibility: 'public',
      presentation: 'docs',
      start_here: '',
      landing_markdown: '  # Hi\n',
    });
  });
});

describe('sectionsOnLanding', () => {
  it('keeps the sections naming this topic by slug or id, in order', () => {
    const sections = [
      { slug: 'b', name: 'B', space: 'ops', order: 20 },
      { slug: 'front', name: 'Front' },
      { slug: 'a', name: 'A', space: 'space_ops', order: 10 },
      { slug: 'other', name: 'Other', space: 'arch', order: 1 },
      { slug: 'c', name: 'C', space: 'ops' },
    ];
    expect(sectionsOnLanding(sections, ops).map((s) => s.slug)).toEqual(['a', 'b', 'c']);
  });
});

describe('startHereProblem', () => {
  it('is quiet for no choice, a loading item and a published item in this topic', () => {
    expect(startHereProblem('', { item: undefined, missing: false }, ops)).toBeNull();
    expect(startHereProblem('guide', { item: undefined, missing: false }, ops)).toBeNull();
    expect(startHereProblem('guide', { item: { status: 'published', space_id: 'space_ops' }, missing: false }, ops)).toBeNull();
  });

  it('warns about a missing item, a draft, and another topic’s item', () => {
    expect(startHereProblem('gone', { item: undefined, missing: true }, ops)).toMatch(/No item uses the slug “gone”/);
    expect(startHereProblem('d', { item: { status: 'draft', space_id: 'space_ops' }, missing: false }, ops)).toMatch(/draft/);
    expect(startHereProblem('o', { item: { status: 'published', space_id: 'space_arch' }, missing: false }, ops)).toBe('This item belongs to another topic.');
  });
});

describe('sourceForTopic', () => {
  it('finds the bound source by topic id, else by its topic:<slug> id', () => {
    const sources = [
      { id: 'main', space_id: null },
      { id: 'topic:ops', space_id: 'space_ops' },
      { id: 'topic:arch', space_id: null },
    ];
    expect(sourceForTopic(sources, ops)?.id).toBe('topic:ops');
    expect(sourceForTopic(sources, arch)?.id).toBe('topic:arch');
    expect(sourceForTopic(sources, hr)).toBeUndefined();
    expect(sourceForTopic(undefined, hr)).toBeUndefined();
  });
});

describe('createdMessage', () => {
  it('names the repository binding when there is one', () => {
    expect(createdMessage('Ops', '', true)).toBe('Topic created: Ops');
    expect(createdMessage('Ops', 'git@h:o/r.git', true)).toBe('Topic created: Ops (bound to a dedicated repository, pulling its content)');
    expect(createdMessage('Ops', 'git@h:o/r.git', false)).toBe('Topic created: Ops (bound to a dedicated repository)');
  });
});
