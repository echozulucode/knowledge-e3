import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import type { ItemSourceRef } from '@echozedlabs/knowledge-types';
import { SourceBadge } from './SourceBadge.js';

const REFERENCE: ItemSourceRef = {
  id: 'topic:platform-docs',
  role: 'reference',
  mode: 'read-only',
  path: 'concepts/retry-budget.md',
  url: 'https://github.com/other-team/docs/blob/main/concepts/retry-budget.md',
};

describe('SourceBadge', () => {
  it('renders nothing without a source, or for an ordinary authoritative one', () => {
    const { container, rerender } = render(<SourceBadge source={null} />);
    expect(container.innerHTML).toBe('');
    rerender(<SourceBadge source={undefined} />);
    expect(container.innerHTML).toBe('');
    rerender(<SourceBadge source={{ id: 'main', role: 'authoritative', mode: 'direct' }} />);
    expect(container.innerHTML).toBe('');
  });

  it('says only that the page is maintained elsewhere, and offers the original', () => {
    const { container } = render(<SourceBadge source={REFERENCE} />);
    const badges = Array.from(container.querySelectorAll('.kp-badge'));
    expect(badges.map((badge) => badge.textContent)).toEqual(['Maintained elsewhere']);
    expect(badges[0]?.getAttribute('data-tone')).toBe('external');
    const link = container.querySelector('a');
    expect(link?.textContent).toBe('View the original');
    expect(link?.getAttribute('href')).toBe(REFERENCE.url);
    expect(link?.getAttribute('target')).toBe('_blank');
    expect(link?.getAttribute('rel')).toBe('noopener noreferrer');
  });

  /**
   * The regression this badge exists to prevent (plan §6, R4.1): the registry
   * id and the repo-relative path used to be in the tooltip, which put the
   * instance's plumbing on an article and made one corpus read as several.
   */
  it('names neither the source id nor the file path anywhere a reader can see', () => {
    const { container } = render(<SourceBadge source={REFERENCE} />);
    const visible = [
      container.textContent ?? '',
      ...Array.from(container.querySelectorAll('[title], [aria-label]')).flatMap((el) => [
        el.getAttribute('title') ?? '',
        el.getAttribute('aria-label') ?? '',
      ]),
    ].join(' ');
    expect(visible).not.toContain(REFERENCE.id);
    expect(visible).not.toContain(REFERENCE.path);
    expect(visible).not.toMatch(/repositor|repo\b|upstream|sync|mirror/i);
  });

  it('keeps the badge and offers no link when the remote yields no url', () => {
    const { container } = render(<SourceBadge source={{ ...REFERENCE, url: null }} />);
    expect(container.querySelector('[data-tone="external"]')?.textContent).toBe('Maintained elsewhere');
    expect(container.querySelector('a')).toBeNull();
  });

  it('renders the same claim for an authoritative source nobody publishes to', () => {
    const { container } = render(
      <SourceBadge source={{ id: 'main', role: 'authoritative', mode: 'read-only', path: 'main/a.md', url: null }} />,
    );
    const badges = Array.from(container.querySelectorAll('.kp-badge'));
    expect(badges.map((badge) => badge.textContent)).toEqual(['Maintained elsewhere']);
    expect(badges[0]?.getAttribute('data-tone')).toBe('read-only');
    expect(badges[0]?.getAttribute('title')).toBe('This page is maintained elsewhere and kept up to date automatically.');
  });

  it('renders for a reference source that is still writable', () => {
    const { container } = render(<SourceBadge source={{ ...REFERENCE, mode: 'direct' }} />);
    expect(Array.from(container.querySelectorAll('.kp-badge')).map((b) => b.textContent)).toEqual(['Maintained elsewhere']);
  });

  it('renders the link to the original through renderOriginalLink when provided', () => {
    const { container } = render(
      <SourceBadge source={REFERENCE} renderOriginalLink={(url) => <a href={url}>Open the original</a>} />,
    );
    expect(container.querySelector('a')?.textContent).toBe('Open the original');
  });

  it('passes className through alongside the wrapper class', () => {
    const { container } = render(<SourceBadge source={REFERENCE} className="extra" />);
    expect(container.querySelector('.kp-source')?.className).toBe('kp-source extra');
  });
});
