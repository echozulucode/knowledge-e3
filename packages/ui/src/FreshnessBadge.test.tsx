import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { FreshnessBadge } from './FreshnessBadge.js';

describe('FreshnessBadge', () => {
  it('renders nothing for plain published or unknown state', () => {
    const { container, rerender } = render(<FreshnessBadge displayState="published" />);
    expect(container.innerHTML).toBe('');
    rerender(<FreshnessBadge displayState={undefined} />);
    expect(container.innerHTML).toBe('');
  });

  it('renders Needs review as a warning status with the stale date as title', () => {
    render(<FreshnessBadge displayState="needs-review" staleAfter="2026-06-01" />);
    const badge = screen.getByRole('status');
    expect(badge.textContent).toBe('Needs review');
    expect(badge.getAttribute('data-tone')).toBe('needs-review');
    expect(badge.getAttribute('title')).toBe('Stale after 2026-06-01');
    expect(badge.className).toBe('kp-badge');
  });

  it('renders Superseded with the successor slug as plain text by default', () => {
    const { container } = render(<FreshnessBadge displayState="superseded" supersededBy="new-runbook" />);
    const badge = container.querySelector('.kp-badge');
    expect(badge?.textContent).toBe('Superseded → new-runbook');
    expect(badge?.getAttribute('role')).toBeNull();
    expect(badge?.querySelector('a')).toBeNull();
  });

  it('renders the successor through renderLink when provided', () => {
    const { container } = render(
      <FreshnessBadge
        displayState="superseded"
        supersededBy="new-runbook"
        renderLink={(slug) => <a href={`/p/${slug}`}>{slug}</a>}
      />,
    );
    const link = container.querySelector('a');
    expect(link?.getAttribute('href')).toBe('/p/new-runbook');
    expect(link?.textContent).toBe('new-runbook');
  });

  it('renders Superseded alone when no successor is known', () => {
    const { container } = render(<FreshnessBadge displayState="superseded" />);
    expect(container.querySelector('.kp-badge')?.textContent).toBe('Superseded');
  });

  it('renders Archived and Draft', () => {
    const { container, rerender } = render(<FreshnessBadge displayState="archived" />);
    expect(container.querySelector('.kp-badge')?.textContent).toBe('Archived');
    expect(container.querySelector('.kp-badge')?.getAttribute('data-tone')).toBe('archived');
    rerender(<FreshnessBadge displayState="draft" className="extra" />);
    expect(container.querySelector('.kp-badge')?.textContent).toBe('Draft');
    expect(container.querySelector('.kp-badge')?.className).toBe('kp-badge extra');
  });
});

describe('FreshnessBadge in-review', () => {
  it('renders In review with the info tone and no link when no change url is known', () => {
    const { container } = render(<FreshnessBadge displayState="in-review" canOpenReview />);
    const badge = container.querySelector('.kp-badge');
    expect(badge?.textContent).toBe('In review');
    expect(badge?.getAttribute('data-tone')).toBe('in-review');
    expect(badge?.getAttribute('role')).toBeNull();
    expect(badge?.querySelector('a')).toBeNull();
  });

  /**
   * Plan §6, R4.2: the link is opt-in, so a list surface — a search row, a feed
   * card, a topic landing — states the fact and offers a reader no door they
   * cannot open.
   */
  it('renders the state as plain text when the reader cannot act on the change', () => {
    const { container } = render(<FreshnessBadge displayState="in-review" reviewUrl="https://git.example/pr/1" />);
    expect(container.querySelector('.kp-badge')?.textContent).toBe('In review');
    expect(container.querySelector('a')).toBeNull();
  });

  it('links to the change without naming the plumbing when the reader may act', () => {
    const { container } = render(
      <FreshnessBadge displayState="in-review" reviewUrl="https://git.example/pr/7" canOpenReview />,
    );
    const link = container.querySelector('a');
    expect(container.querySelector('.kp-badge')?.textContent).toBe('In review · View the change');
    expect(link?.getAttribute('href')).toBe('https://git.example/pr/7');
    expect(link?.getAttribute('target')).toBe('_blank');
  });

  it('renders the change request through renderReviewLink when provided', () => {
    const { container } = render(
      <FreshnessBadge
        displayState="in-review"
        reviewUrl="https://git.example/pr/1"
        canOpenReview
        renderReviewLink={(url) => <a href={url}>Open the change</a>}
      />,
    );
    expect(container.querySelector('a')?.textContent).toBe('Open the change');
  });

  it('ignores reviewUrl for other states', () => {
    const { container } = render(<FreshnessBadge displayState="draft" reviewUrl="https://git.example/pr/1" canOpenReview />);
    expect(container.querySelector('.kp-badge')?.textContent).toBe('Draft');
    expect(container.querySelector('a')).toBeNull();
  });
});
