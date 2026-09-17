import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ContentTypeBadge, ContentTypesProvider, resolveContentTypeMeta, type ContentTypeEntry } from './ContentTypeBadge.js';

const TYPES: ContentTypeEntry[] = [
  { key: 'concept', label: 'Concept', group: 'Reference', icon: 'book' },
  { key: 'blog-post', label: 'Blog Post', group: 'Publishing', icon: 'penNib' },
  { key: 'faq', label: 'FAQ', group: 'Support', icon: 'circleQuestion' },
];

describe('resolveContentTypeMeta', () => {
  it('matches by label case-insensitively and maps the group to its key', () => {
    expect(resolveContentTypeMeta('blog post', TYPES)).toEqual({
      label: 'Blog Post',
      group: 'Publishing',
      groupKey: 'publishing',
      icon: 'penNib',
    });
  });

  it('matches by slugified key', () => {
    expect(resolveContentTypeMeta('Blog-Post', TYPES)?.groupKey).toBe('publishing');
  });

  it('renders unknown types neutrally instead of dropping them', () => {
    expect(resolveContentTypeMeta('Weird Kind', TYPES)).toEqual({
      label: 'Weird Kind',
      group: 'Other',
      groupKey: 'default',
      icon: 'tag',
    });
  });

  it('returns null for empty input', () => {
    expect(resolveContentTypeMeta(null, TYPES)).toBeNull();
    expect(resolveContentTypeMeta('   ', TYPES)).toBeNull();
  });
});

describe('ContentTypeBadge', () => {
  it('renders the kp-type-badge chip with group, size and title from the provided registry', () => {
    const { container } = render(
      <ContentTypesProvider types={TYPES}>
        <ContentTypeBadge type="FAQ" size="sm" />
      </ContentTypesProvider>,
    );
    const badge = container.querySelector('.kp-type-badge');
    expect(badge).not.toBeNull();
    expect(badge?.getAttribute('data-group')).toBe('support');
    expect(badge?.getAttribute('data-size')).toBe('sm');
    expect(badge?.getAttribute('title')).toBe('FAQ · Support');
    expect(badge?.querySelector('.kp-type-badge__label')?.textContent).toBe('FAQ');
  });

  it('defaults to size md and renders the icon through renderIcon', () => {
    const { container } = render(
      <ContentTypesProvider types={TYPES} renderIcon={(key) => <i data-icon={key} />}>
        <ContentTypeBadge type="Concept" />
      </ContentTypesProvider>,
    );
    const badge = container.querySelector('.kp-type-badge');
    expect(badge?.getAttribute('data-size')).toBe('md');
    const icon = badge?.querySelector('.kp-type-badge__icon');
    expect(icon?.getAttribute('aria-hidden')).toBe('true');
    expect(icon?.querySelector('i')?.getAttribute('data-icon')).toBe('book');
  });

  it('omits the icon span when showIcon is false or no renderer is provided', () => {
    const { container, rerender } = render(
      <ContentTypesProvider types={TYPES} renderIcon={(key) => <i data-icon={key} />}>
        <ContentTypeBadge type="Concept" showIcon={false} />
      </ContentTypesProvider>,
    );
    expect(container.querySelector('.kp-type-badge__icon')).toBeNull();
    rerender(<ContentTypeBadge type="Concept" />);
    expect(container.querySelector('.kp-type-badge__icon')).toBeNull();
    expect(screen.getByText('Concept')).toBeTruthy();
  });

  it('falls back to the default group without a provider', () => {
    const { container } = render(<ContentTypeBadge type="Concept" />);
    expect(container.querySelector('.kp-type-badge')?.getAttribute('data-group')).toBe('default');
  });

  it('renders nothing for a missing type', () => {
    const { container } = render(<ContentTypeBadge type={null} />);
    expect(container.innerHTML).toBe('');
  });
});
