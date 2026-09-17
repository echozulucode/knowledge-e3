import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Article, ArticleHeader } from './Article.js';
import { ContentTypeBadge } from './ContentTypeBadge.js';

describe('ArticleHeader', () => {
  it('renders cover, badges, the single h1, description, status and meta', () => {
    const { container } = render(
      <ArticleHeader
        title="Deploy Guide"
        cover="/assets/hero.png"
        badges={<ContentTypeBadge type="how-to" />}
        description="How we ship."
        status="published"
        meta={['By Ada', 'Mar 3, 2026', '4 min read']}
      />,
    );
    expect(container.querySelector('.kp-article-header__cover')?.getAttribute('src')).toBe('/assets/hero.png');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Deploy Guide');
    expect(container.querySelectorAll('h1')).toHaveLength(1);
    expect(screen.getByText('How we ship.')).toBeTruthy();
    expect(screen.getByText('Published').getAttribute('data-status')).toBe('published');
    expect(container.querySelector('.kp-article-header__meta')?.textContent).toBe(
      'Published·By Ada·Mar 3, 2026·4 min read',
    );
  });

  it('renders no header markup for facts the item does not carry', () => {
    const { container } = render(<ArticleHeader title="Bare" />);
    expect(container.querySelector('.kp-article-header__cover')).toBeNull();
    expect(container.querySelector('.kp-item-badges')).toBeNull();
    expect(container.querySelector('.kp-article-header__description')).toBeNull();
    expect(container.querySelector('.kp-article-header__meta')).toBeNull();
    expect(container.querySelector('.kp-article-header__notice')).toBeNull();
  });

  it('keeps a draft quiet and omits the pill entirely when status is null', () => {
    const { container, rerender } = render(<ArticleHeader title="T" status="draft" />);
    expect(screen.getByText('Draft').getAttribute('data-status')).toBe('draft');
    rerender(<ArticleHeader title="T" status={null} meta={['Updated today']} />);
    expect(container.querySelector('.kp-article-header__status')).toBeNull();
    expect(container.querySelector('.kp-article-header__meta')?.textContent).toBe('·Updated today');
  });

  it('renders a notice above the title as a note', () => {
    render(<ArticleHeader title="Mirrored" notice="Edits are made in the source repository." />);
    expect(screen.getByRole('note').textContent).toBe('Edits are made in the source repository.');
  });
});

describe('Article', () => {
  it('wraps header, aside and body in one article element, in reading order', () => {
    const { container } = render(
      <Article header={<ArticleHeader title="Deploy Guide" />} aside={<div data-testid="copyable" />}>
        <p>Body prose.</p>
      </Article>,
    );
    const article = container.querySelector('article.kp-article');
    expect(article).toBeTruthy();
    expect(article?.children[0]?.className).toContain('kp-article-header');
    expect(article?.children[1]?.getAttribute('data-testid')).toBe('copyable');
    expect(article?.children[2]?.className).toBe('kp-article__body');
    expect(screen.getByText('Body prose.')).toBeTruthy();
  });

  it('renders the body wrapper even with no children, so layout does not shift', () => {
    const { container } = render(<Article />);
    expect(container.querySelector('.kp-article__body')).toBeTruthy();
  });
});
