import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ItemCard, ItemRow } from './ItemCard.js';
import { FreshnessBadge } from './FreshnessBadge.js';

describe('ItemCard', () => {
  it('renders cover, badges, title link, preview and a ·-separated meta line', () => {
    const { container } = render(
      <ItemCard
        title="Deploy Guide"
        href="/p/deploy-guide"
        cover="/assets/cover.png"
        preview="How we ship."
        badges={<FreshnessBadge displayState="needs-review" />}
        meta={['By Ada', 'Mar 3, 2026', '4 min read']}
        testId="feed-card"
      />,
    );
    const card = screen.getByTestId('feed-card');
    expect(card.tagName).toBe('ARTICLE');
    expect(card.querySelector('.kp-item-card__cover')?.getAttribute('src')).toBe('/assets/cover.png');
    // Decorative: the title, not the cover, carries the item's name.
    expect(card.querySelector('.kp-item-card__cover')?.getAttribute('alt')).toBe('');
    expect(screen.getByRole('link', { name: 'Deploy Guide' }).getAttribute('href')).toBe('/p/deploy-guide');
    expect(screen.getByText('How we ship.')).toBeTruthy();
    expect(screen.getByText('Needs review')).toBeTruthy();
    expect(container.querySelector('.kp-item-card__meta')?.textContent).toBe('By Ada·Mar 3, 2026·4 min read');
  });

  it('omits every optional block when the item has nothing to show', () => {
    const { container } = render(<ItemCard title="Bare" href="/p/bare" />);
    expect(container.querySelector('.kp-item-card__cover')).toBeNull();
    expect(container.querySelector('.kp-item-badges')).toBeNull();
    expect(container.querySelector('.kp-item-card__preview')).toBeNull();
    expect(container.querySelector('.kp-item-meta')).toBeNull();
    expect(container.querySelector('.kp-item-card__footer')).toBeNull();
  });

  it('defaults the title to h3 and lets a section-level grid ask for h2', () => {
    const { container, rerender } = render(<ItemCard title="Default" href="/p/a" />);
    expect(container.querySelector('h3.kp-item-card__title')).toBeTruthy();
    rerender(<ItemCard title="Section" href="/p/a" titleAs="h2" />);
    expect(container.querySelector('h2.kp-item-card__title')).toBeTruthy();
  });

  it('routes the title through renderLink so the package never owns navigation', () => {
    render(
      <ItemCard
        title="Routed"
        href="/p/routed"
        renderLink={({ href, className, children }) => (
          <button type="button" className={className} data-to={href}>
            {children}
          </button>
        )}
      />,
    );
    const link = screen.getByRole('button', { name: 'Routed' });
    expect(link.getAttribute('data-to')).toBe('/p/routed');
    expect(link.className).toBe('kp-item-card__titleLink');
  });

  it('drops empty meta entries instead of printing stray separators', () => {
    const { container } = render(<ItemCard title="T" href="/p/t" meta={['Only', null, undefined, '']} />);
    expect(container.querySelector('.kp-item-card__meta')?.textContent).toBe('Only');
  });
});

describe('ItemRow', () => {
  it('renders a list item with title, badges, preview and trailing slot', () => {
    const { container } = render(
      <ul>
        <ItemRow
          title="Essential Guide"
          href="/p/essential"
          preview="Recommended workflow."
          badges={<FreshnessBadge displayState="superseded" supersededBy="newer" />}
          trailing={<span data-testid="chevron">›</span>}
        />
      </ul>,
    );
    const row = container.querySelector('.kp-item-row');
    expect(row?.tagName).toBe('LI');
    expect(screen.getByRole('link', { name: 'Essential Guide' }).className).toBe('kp-item-row__title');
    expect(screen.getByText('Recommended workflow.')).toBeTruthy();
    expect(screen.getByText(/Superseded/)).toBeTruthy();
    expect(screen.getByTestId('chevron')).toBeTruthy();
  });

  it('keeps exactly one link for the row, so the stretched title is the only click target', () => {
    render(
      <ul>
        <ItemRow title="Only Link" href="/p/only" preview="Body." meta={['Updated today']} />
      </ul>,
    );
    expect(screen.getAllByRole('link')).toHaveLength(1);
  });

  it('omits the badge, preview and meta slots when empty', () => {
    const { container } = render(
      <ul>
        <ItemRow title="Bare" href="/p/bare" />
      </ul>,
    );
    expect(container.querySelector('.kp-item-row__badges')).toBeNull();
    expect(container.querySelector('.kp-item-row__preview')).toBeNull();
    expect(container.querySelector('.kp-item-meta')).toBeNull();
    expect(container.querySelector('.kp-item-row__trailing')).toBeNull();
  });

  it('appends a caller class without losing the component class', () => {
    const { container } = render(
      <ul>
        <ItemRow title="T" href="/p/t" className="TopicLanding__item" />
      </ul>,
    );
    expect(container.querySelector('li')?.className).toBe('kp-item-row TopicLanding__item');
  });
});
