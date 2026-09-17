import { describe, expect, it } from 'vitest';
import { itemPreview } from './itemPreview.js';

describe('itemPreview', () => {
  it('prefers description — the Publish drawer is the most deliberate statement', () => {
    expect(itemPreview({ description: 'Ship it safely.', summary: 'Old summary', body: 'Body prose.' })).toBe(
      'Ship it safely.',
    );
  });

  it('falls back to summary, so OKF imports and older items still say something', () => {
    expect(itemPreview({ summary: 'Imported summary', body: 'Body prose.' })).toBe('Imported summary');
  });

  it('treats blank and whitespace-only fields as absent', () => {
    expect(itemPreview({ description: '   ', summary: '', body: 'Body prose.' })).toBe('Body prose.');
    expect(itemPreview({ description: '  Trimmed  ' })).toBe('Trimmed');
  });

  it('falls back to the first body paragraph, skipping headings, fences and images', () => {
    const body = [
      '# Title',
      '',
      '![cover](/assets/x.png)',
      '',
      '```ts',
      'const x = 1;',
      '```',
      '',
      'The actual lead paragraph.',
      'Still the same paragraph.',
      '',
      'A second paragraph nobody should see.',
    ].join('\n');
    expect(itemPreview({ body })).toBe('The actual lead paragraph. Still the same paragraph.');
  });

  it('unwraps links, wiki-links and emphasis rather than showing their punctuation', () => {
    const body = 'See **the [runbook](/p/runbook)** and [[Deploy Guide|the guide]] first.';
    expect(itemPreview({ body })).toBe('See the runbook and the guide first.');
  });

  it('cuts a long body at a sentence boundary', () => {
    const sentence = 'This sentence is exactly long enough to matter. ';
    const preview = itemPreview({ body: sentence.repeat(8) })!;
    expect(preview.length).toBeLessThanOrEqual(220);
    expect(preview.endsWith('.')).toBe(true);
    expect(preview.endsWith('…')).toBe(false);
  });

  it('falls back to a word boundary with an ellipsis when there is no sentence end', () => {
    const preview = itemPreview({ body: 'word '.repeat(80) })!;
    expect(preview.length).toBeLessThanOrEqual(221);
    expect(preview.endsWith('…')).toBe(true);
    expect(preview).not.toMatch(/wor…$/);
  });

  it('returns null when the item has nothing to say', () => {
    expect(itemPreview({ body: '' })).toBeNull();
    expect(itemPreview({})).toBeNull();
    expect(itemPreview(null)).toBeNull();
    expect(itemPreview({ body: '# Heading only' })).toBeNull();
  });
});
