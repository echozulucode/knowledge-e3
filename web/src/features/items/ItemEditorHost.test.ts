import { describe, expect, it, vi } from 'vitest';
import {
  buildKnowledgeItemPropertySchema,
  createItemEditorHostServices,
  getDefaultItemEditorModes,
  knowledgeItemPropertySchema,
} from './ItemEditorHostConfig.js';

describe('ItemEditorHost integration boundary', () => {
  it('defaults to reusable editor modes including WYSIWYG instead of the old app-specific editor', () => {
    expect(getDefaultItemEditorModes()).toEqual(['hybrid', 'wysiwyg', 'markdown', 'preview']);
    expect(getDefaultItemEditorModes(true)).toEqual(['preview']);
  });

  it('defines Knowledge E3 item properties through the reusable editor schema API', () => {
    expect(knowledgeItemPropertySchema.map((property) => property.key)).toEqual([
      'title',
      'status',
      'topic',
      'tags',
      'categories',
      'groups',
      'aliases',
    ]);
    expect(knowledgeItemPropertySchema.find((property) => property.key === 'title')).toMatchObject({
      required: true,
      type: 'text',
    });
    expect(knowledgeItemPropertySchema.find((property) => property.key === 'tags')).toMatchObject({
      type: 'tags',
    });
  });

  it('builds item property picker schemas from existing Admin taxonomy values', () => {
    const schema = buildKnowledgeItemPropertySchema({
      tags: ['mvp', 'agent'],
      groups: ['operators'],
      categories: ['architecture'],
    });

    expect(schema.find((property) => property.key === 'tags')).toMatchObject({
      type: 'tags',
      allowedValues: ['agent', 'mvp'],
    });
    expect(schema.find((property) => property.key === 'groups')).toMatchObject({
      type: 'tags',
      allowedValues: ['operators'],
    });
    expect(schema.find((property) => property.key === 'categories')).toMatchObject({
      type: 'tags',
      allowedValues: ['architecture'],
    });
    expect(knowledgeItemPropertySchema.find((property) => property.key === 'tags')?.allowedValues).toBeUndefined();
  });

  it('maps Knowledge E3 item services onto markdown-editor host services without editor internals', async () => {
    const searchItems = vi.fn(async () => [
      { id: 'item-1', label: 'Runbook', insertText: '[Runbook](<item-1>)' },
    ]);
    const navigateToItem = vi.fn();
    const resolveItemLink = vi.fn((target: string) => `/items/${target}`);

    const services = createItemEditorHostServices({ searchItems, navigateToItem, resolveItemLink });

    await expect(services.searchLinks?.('run')).resolves.toEqual([
      { id: 'item-1', label: 'Runbook', insertText: '[Runbook](<item-1>)' },
    ]);
    expect(services.resolveWikiLink?.('runbook')).toBe('/items/runbook');

    services.navigateLink?.('/items/runbook');
    expect(navigateToItem).toHaveBeenCalledWith('/items/runbook');
  });
});
