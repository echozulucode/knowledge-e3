import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { TrustBadge, isMachineActor } from './TrustBadge.js';

describe('TrustBadge', () => {
  it('renders Human-reviewed with the verification date', () => {
    const { container } = render(<TrustBadge tier="human-reviewed" verifiedAt="2026-08-14T09:30:00.000Z" />);
    const badge = container.querySelector('.kp-badge');
    expect(badge?.textContent).toBe('Human-reviewed · 2026-08-14');
    expect(badge?.getAttribute('data-tone')).toBe('human-reviewed');
  });

  it('renders Human-reviewed without a date when none is known', () => {
    render(<TrustBadge tier="human-reviewed" />);
    expect(screen.getByText('Human-reviewed')).toBeTruthy();
  });

  it('renders Machine-confirmed', () => {
    const { container } = render(<TrustBadge tier="machine-confirmed" verifiedAt="2026-08-14" />);
    expect(container.querySelector('.kp-badge')?.textContent).toBe('Machine-confirmed');
  });

  it('renders Unverified', () => {
    const { container } = render(<TrustBadge tier="unverified" />);
    expect(container.querySelector('.kp-badge')?.textContent).toBe('Unverified');
    expect(screen.queryByText('AI-generated')).toBeNull();
  });

  it('adds the AI-generated chip only while unverified and machine-generated', () => {
    const { container, rerender } = render(<TrustBadge tier="unverified" generatedBy="process:okf-import" />);
    expect(screen.getByText('AI-generated').getAttribute('data-tone')).toBe('ai-generated');
    expect(container.querySelectorAll('.kp-badge')).toHaveLength(2);

    rerender(<TrustBadge tier="unverified" generatedBy="agent:claude" />);
    expect(screen.getByText('AI-generated')).toBeTruthy();

    rerender(<TrustBadge tier="unverified" generatedBy="user:eric" />);
    expect(screen.queryByText('AI-generated')).toBeNull();

    rerender(<TrustBadge tier="machine-confirmed" generatedBy="agent:claude" />);
    expect(screen.queryByText('AI-generated')).toBeNull();

    rerender(<TrustBadge tier="human-reviewed" generatedBy="process:okf-import" />);
    expect(screen.queryByText('AI-generated')).toBeNull();
  });

  it('appends className to the wrapper', () => {
    const { container } = render(<TrustBadge tier="unverified" className="extra" />);
    expect(container.firstElementChild?.className).toBe('kp-trust extra');
  });
});

describe('isMachineActor', () => {
  it('recognises process: and agent: prefixes only', () => {
    expect(isMachineActor('process:x')).toBe(true);
    expect(isMachineActor('agent:x')).toBe(true);
    expect(isMachineActor('user:x')).toBe(false);
    expect(isMachineActor(null)).toBe(false);
    expect(isMachineActor(undefined)).toBe(false);
  });

  describe('variant="mark" (index surfaces)', () => {
    it('renders nothing for an unverified item, including an AI-generated one', () => {
      const { container, rerender } = render(<TrustBadge variant="mark" tier="unverified" />);
      expect(container.innerHTML).toBe('');
      rerender(<TrustBadge variant="mark" tier="unverified" generatedBy="agent:claude" />);
      expect(container.innerHTML).toBe('');
    });

    it('renders a labelled mark for verified tiers', () => {
      render(<TrustBadge variant="mark" tier="human-reviewed" verifiedAt="2026-08-14" />);
      expect(screen.getByRole('img', { name: 'Human-reviewed · 2026-08-14' })).toBeTruthy();
    });
  });

  describe('variant="inline" (article byline)', () => {
    it('always states the tier, including unverified, and discloses an explanation', () => {
      render(<TrustBadge variant="inline" tier="unverified" />);
      const toggle = screen.getByRole('button', { name: /Unverified/ });
      expect(toggle.getAttribute('aria-expanded')).toBe('false');
      const note = screen.getByRole('note', { hidden: true });
      expect(note.hidden).toBe(true);
      fireEvent.click(toggle);
      expect(toggle.getAttribute('aria-expanded')).toBe('true');
      expect(note.hidden).toBe(false);
      expect(note.textContent).toMatch(/Nobody has reviewed/);
    });

    it('keeps the AI-generated chip on the article', () => {
      render(<TrustBadge variant="inline" tier="unverified" generatedBy="process:okf-import" />);
      expect(screen.getByText('AI-generated')).toBeTruthy();
    });
  });
});
