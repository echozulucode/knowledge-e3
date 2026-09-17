import { describe, it, expect } from 'vitest';
import { schemaFor, templateFor } from '../src/schema.js';
import { CONTENT_TYPES } from '../src/registry.js';

describe('schemaFor', () => {
  it('starts with the base fields and only title is required', () => {
    const fields = schemaFor('Concept');
    expect(fields.map((f) => f.key)).toEqual(['title', 'description', 'tags', 'status', 'stale_after', 'authors']);
    expect(fields.filter((f) => f.required).map((f) => f.key)).toEqual(['title']);
    expect(fields.find((f) => f.key === 'stale_after')?.type).toBe('date');
  });

  it('appends the registry type fields as optional', () => {
    const fields = schemaFor('troubleshooting-guide');
    expect(fields.slice(6).map((f) => f.key)).toEqual(['symptoms', 'severity', 'product', 'component', 'owner']);
    expect(fields.slice(6).every((f) => f.required === false)).toBe(true);
  });

  it('falls back to base fields for unknown types', () => {
    expect(schemaFor('Custom Kind')).toEqual(schemaFor('Concept'));
  });
});

describe('templateFor', () => {
  it('returns the registry template', () => {
    const faq = CONTENT_TYPES.find((t) => t.key === 'faq')!;
    expect(templateFor('FAQ')).toBe(faq.template);
  });

  it('falls back to the Concept template', () => {
    const concept = CONTENT_TYPES.find((t) => t.key === 'concept')!;
    expect(templateFor('Custom Kind')).toBe(concept.template);
  });
});
