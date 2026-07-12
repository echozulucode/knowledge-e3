import type { EditorMode, FrontmatterPropertySchema } from '@echozedlabs/react';
export {
  createItemEditorHostServices,
  itemToLinkSuggestion,
  searchItemLinkSuggestions,
  uploadImageAsset,
  type CreateItemHostServicesOptions,
  type ItemLinkSearchResult,
} from './itemHostServices.js';

export const knowledgeItemPropertySchema: FrontmatterPropertySchema[] = [
  {
    key: 'title',
    type: 'text',
    label: 'Title',
    icon: 'title',
    required: true,
    order: 10,
  },
  {
    key: 'status',
    type: 'text',
    label: 'Status',
    icon: 'status',
    defaultValue: 'draft',
    allowedValues: ['draft', 'published'],
    order: 20,
  },
  {
    key: 'topic',
    type: 'text',
    label: 'Space',
    icon: 'space',
    defaultValue: 'Default topic',
    order: 30,
  },
  {
    key: 'tags',
    type: 'tags',
    label: 'Tags',
    icon: 'tag',
    defaultValue: [],
    order: 40,
  },
  {
    key: 'categories',
    type: 'tags',
    label: 'Categories',
    icon: 'category',
    defaultValue: [],
    order: 50,
  },
  {
    key: 'groups',
    type: 'tags',
    label: 'Groups',
    icon: 'group',
    defaultValue: [],
    order: 60,
  },
  {
    key: 'aliases',
    type: 'tags',
    label: 'Aliases',
    icon: 'alias',
    defaultValue: [],
    order: 70,
  },
];

export interface KnowledgeItemPropertySchemaOptions {
  topics?: string[];
  tags?: string[];
  categories?: string[];
  groups?: string[];
}

export function buildKnowledgeItemPropertySchema(options: KnowledgeItemPropertySchemaOptions = {}): FrontmatterPropertySchema[] {
  const allowedValuesByKey: Record<string, string[] | undefined> = {
    topic: normalizeAllowedValues(options.topics),
    tags: normalizeAllowedValues(options.tags),
    categories: normalizeAllowedValues(options.categories),
    groups: normalizeAllowedValues(options.groups),
  };

  return knowledgeItemPropertySchema.map((property) => {
    const allowedValues = allowedValuesByKey[property.key];
    return allowedValues && allowedValues.length > 0 ? { ...property, allowedValues } : { ...property };
  });
}

function normalizeAllowedValues(values: string[] | undefined): string[] | undefined {
  if (!values) return undefined;
  const normalized = Array.from(new Set(values.map((value) => value.trim()).filter(Boolean))).sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: 'base' }),
  );
  return normalized.length > 0 ? normalized : undefined;
}

export function getDefaultItemEditorModes(readOnly = false): EditorMode[] {
  return readOnly ? ['preview'] : ['hybrid', 'wysiwyg', 'markdown', 'preview'];
}
