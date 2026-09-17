import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PinnedTopicCard } from './PinnedTopicCard.js';

describe('PinnedTopicCard', () => {
  it('renders both theme covers, the colour rule, the name and the description', () => {
    const { container } = render(
      <PinnedTopicCard
        name="AI"
        href="/topics/ai"
        description="Everything the team knows about AI."
        color="teal"
        cover="/assets/light.png"
        coverDark="/assets/dark.png"
        testId="pin"
      />,
    );
    const card = screen.getByTestId('pin');
    expect(card.tagName).toBe('ARTICLE');
    // Both variants are in the DOM and CSS chooses, so the swap happens with no
    // JavaScript and no flash — the mechanism SiteBrand uses for the logo.
    expect(card.querySelector('.kp-cover-light')?.getAttribute('src')).toBe('/assets/light.png');
    expect(card.querySelector('.kp-cover-dark')?.getAttribute('src')).toBe('/assets/dark.png');
    // Decorative: the name carries the meaning.
    expect(card.querySelector('.kp-cover-light')?.getAttribute('alt')).toBe('');
    expect(card.getAttribute('data-pin-color')).toBe('teal');
    expect(card.getAttribute('style')).toContain('var(--kp-pin-teal)');
    // The name is always TEXT, in an h3, so a colourblind reader and a
    // greyscale screenshot lose nothing when the colour does.
    expect(container.querySelector('h3')?.textContent).toBe('AI');
    expect(screen.getByRole('link', { name: 'AI' }).getAttribute('href')).toBe('/topics/ai');
    expect(screen.getByText('Everything the team knows about AI.')).toBeTruthy();
  });

  it('puts the cover in the thumbnail slot, not a band, and prefers it over the icon', () => {
    const { container } = render(
      <PinnedTopicCard name="AI" href="/topics/ai" cover="/assets/a.png" icon={<svg data-testid="glyph" />} />,
    );
    const thumb = container.querySelector('.kp-pin__thumb');
    expect(thumb?.getAttribute('data-thumb')).toBe('cover');
    expect(thumb?.querySelector('.kp-cover-light')).not.toBeNull();
    // The 16:9 band is gone for good (R2.5): topics are navigation.
    expect(container.querySelector('.kp-pin__band')).toBeNull();
    expect(screen.queryByTestId('glyph')).toBeNull();
  });

  it('renders a colour and an icon with no image as the icon on a tint, in the same slot', () => {
    const { container } = render(
      <PinnedTopicCard name="Widget Pro" href="/topics/widget-pro" color="ochre" icon={<svg data-testid="glyph" />} />,
    );
    const thumb = container.querySelector('.kp-pin__thumb');
    expect(thumb?.getAttribute('data-thumb')).toBe('icon');
    expect(thumb?.contains(screen.getByTestId('glyph'))).toBe(true);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('.kp-pin')?.getAttribute('data-pin-color')).toBe('ochre');
    expect(container.querySelector('h3')?.textContent).toBe('Widget Pro');
  });

  it('renders an image with no colour, inventing no fallback colour', () => {
    const { container } = render(<PinnedTopicCard name="Manufacturing" href="/topics/mfg" cover="/assets/m.png" />);
    expect(container.querySelector('.kp-pin__thumb')?.getAttribute('data-thumb')).toBe('cover');
    expect(container.querySelector('.kp-pin')?.getAttribute('data-pin-color')).toBeNull();
    expect(container.querySelector('.kp-pin')?.getAttribute('style')).toContain('var(--kp-border-subtle)');
  });

  it('renders with neither, which is still a perfectly good card — with the same slot', () => {
    const { container } = render(<PinnedTopicCard name="Ops" href="/topics/ops" />);
    // Never an empty frame and never a missing one: the neutral default glyph
    // keeps this card the same shape as a neighbour that has a cover.
    const thumb = container.querySelector('.kp-pin__thumb');
    expect(thumb?.getAttribute('data-thumb')).toBe('default');
    expect(thumb?.querySelector('svg')).not.toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('.kp-pin__desc')).toBeNull();
    expect(screen.getByRole('link', { name: 'Ops' })).toBeTruthy();
  });

  it('keeps the slot out of the accessibility tree, so the name is the only label', () => {
    const { container } = render(<PinnedTopicCard name="AI" href="/topics/ai" icon={<svg />} />);
    expect(container.querySelector('.kp-pin__thumb')?.getAttribute('aria-hidden')).toBe('true');
    // The slot precedes the body, so it sits on the leading edge.
    expect(container.querySelector('.kp-pin')?.firstElementChild?.className).toBe('kp-pin__thumb');
  });

  it('never lets a tenant string reach CSS', () => {
    // A colour outside the palette falls back to the neutral border rather than
    // being interpolated into a custom property.
    const { container } = render(
      <PinnedTopicCard name="Hex" href="/topics/hex" color="#ff0000; background: red" />,
    );
    const style = container.querySelector('.kp-pin')?.getAttribute('style') ?? '';
    expect(style).toContain('var(--kp-border-subtle)');
    expect(style).not.toContain('red');
  });

  it('falls the dark cover back to the light one when only one was given', () => {
    const { container } = render(<PinnedTopicCard name="One" href="/topics/one" cover="/assets/only.png" />);
    expect(container.querySelector('.kp-cover-dark')?.getAttribute('src')).toBe('/assets/only.png');
  });

  it('routes through renderLink so this package never imports a router', () => {
    render(
      <PinnedTopicCard
        name="AI"
        href="/topics/ai"
        renderLink={({ className, children }) => (
          <button type="button" className={className} data-testid="routed">
            {children}
          </button>
        )}
      />,
    );
    expect(screen.getByTestId('routed').className).toBe('kp-pin__titleLink');
  });
});
