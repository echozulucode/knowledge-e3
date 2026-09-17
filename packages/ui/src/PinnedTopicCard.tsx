/**
 * PinnedTopicCard — a topic the tenant featured on the home page, with an
 * optional cover image, icon and colour (home-prototype plan §3.3, §4, R2.5).
 *
 * Four rules this component exists to hold, all of them learned elsewhere in
 * this codebase rather than invented here:
 *
 * - **The name always carries the meaning.** `ContentTypeBadge` renders icon +
 *   label + colour and never colour alone, because a colour-only signal fails a
 *   colourblind reader, fails in a greyscale screenshot pasted into a ticket,
 *   and fails in the terminal-rendered screenshots this project's own specs
 *   produce. So the topic name is an always-present `<h3>` in body-text colour
 *   on the card surface, and the colour is a 3px rule on the leading edge —
 *   decoration that helps recognition on the fifth visit, never the only thing
 *   distinguishing two cards. No text is ever rendered on a tenant-chosen
 *   colour, which is also why a tenant cannot make their front page unreadable.
 *
 * - **Every card is the same shape** (R2.5). A square thumbnail slot sits on the
 *   leading edge of every card, at the same size and position, and holds — in
 *   order of preference — the cover, else the topic's icon on a quiet tint of
 *   its colour, else a neutral default glyph. The first design review read one
 *   card with a 16:9 cover band beside three without as "a failed image": the
 *   fault was one card being a different component from its neighbours, not the
 *   image. A slot that is always there cannot be missing.
 *
 * - **The cover is a thumbnail beside the label, never a backdrop behind it.**
 *   Both theme variants are in the DOM and CSS chooses (`kp-cover-light` /
 *   `kp-cover-dark`, the same mechanism `SiteBrand` uses for the logo, which
 *   works with no JavaScript and no flash). The structural defence matters more
 *   than the swap: a tenant who uploads a white-background product shot gets a
 *   bright square on a dark card, and nothing becomes unreadable — compare a
 *   hero with the title overlaid, where the same upload erases the topic name.
 *
 * - **This package never routes, and ships no icon set.** The title goes
 *   through `renderLink`, the same escape hatch `ItemCard` and `FreshnessBadge`
 *   use, so `@echozedlabs/ui` stays free of `@tanstack/react-router`; the icon
 *   arrives already rendered, so it stays free of the web app's `appIcons` too.
 */
import type { ReactNode } from 'react';
import type { RenderItemLink } from './ItemCard.js';

/** The fixed palette; mirrors `PIN_COLORS` on the server and `--kp-pin-*` in tokens.css. */
export const PIN_COLORS = ['teal', 'ochre', 'green', 'violet', 'slate', 'plum'] as const;
export type PinColor = (typeof PIN_COLORS)[number];

/**
 * The closed list of topic icon tokens (home plan R2.5); mirrors `PIN_ICONS` on
 * the server. Token names are `appIcons` keys in the web app, which maps them to
 * glyphs — this package ships no icon set, so the card takes a rendered node.
 */
export const PIN_ICONS = ['book', 'bookOpen', 'compass', 'diagramProject', 'circleNodes', 'layerGroup', 'gear', 'wrench', 'shieldHalved', 'key', 'users', 'boltLightning', 'gaugeHigh', 'desktop', 'scaleBalanced', 'listCheck', 'star', 'tag'] as const;
export type PinIcon = (typeof PIN_ICONS)[number];

export interface PinnedTopicCardProps {
  /** Topic name. Always rendered; this is what identifies the card. */
  name: ReactNode;
  /** Destination, e.g. `/topics/ai`. */
  href: string;
  /** Router-aware link renderer; a plain `<a>` when omitted. */
  renderLink?: RenderItemLink;
  /** One line about the topic, clamped to two lines. */
  description?: string | null;
  /** A palette name. Anything else is ignored rather than trusted into CSS. */
  color?: string | null;
  /** Cover image URL. Decorative: the name carries the meaning. */
  cover?: string | null;
  /** Dark-theme cover; the server already falls this back to `cover`. */
  coverDark?: string | null;
  /** The topic's icon, already rendered (see `PIN_ICONS`). Shown in the thumbnail slot when there is no cover. */
  icon?: ReactNode;
  className?: string;
  /** Playwright hook. */
  testId?: string;
}

const defaultRenderLink: RenderItemLink = ({ href, className, children }) => (
  <a href={href} className={className}>
    {children}
  </a>
);

function isPinColor(value: string | null | undefined): value is PinColor {
  return typeof value === 'string' && (PIN_COLORS as readonly string[]).includes(value);
}

/**
 * The neutral default for a card with neither cover nor icon: a plain folder
 * outline, drawn inline because this package carries no icon set. Generic on
 * purpose — it says "a topic", and the name beside it says which.
 */
function DefaultTopicGlyph() {
  return (
    <svg className="kp-pin__glyph" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4.3l2 2.2h8.7A1.5 1.5 0 0 1 21 8.7v8.8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z" />
    </svg>
  );
}

export function PinnedTopicCard({
  name,
  href,
  renderLink = defaultRenderLink,
  description,
  color,
  cover,
  coverDark,
  icon,
  className,
  testId,
}: PinnedTopicCardProps) {
  // An unknown colour renders as the neutral border colour rather than being
  // interpolated into a custom property — a tenant string never reaches CSS.
  const accent = isPinColor(color) ? `var(--kp-pin-${color})` : 'var(--kp-border-subtle)';
  // What the slot holds, exposed for styling and for tests: the one fact that
  // varies between cards whose shape must not.
  const thumb = cover ? 'cover' : icon ? 'icon' : 'default';
  return (
    <article
      className={className ? `kp-pin ${className}` : 'kp-pin'}
      data-testid={testId}
      data-pin-color={isPinColor(color) ? color : undefined}
      style={{ ['--kp-pin-accent' as string]: accent }}
    >
      {/* Decorative in every state: the name carries the meaning. */}
      <div className="kp-pin__thumb" data-thumb={thumb} aria-hidden="true">
        {cover ? (
          <>
            <img className="kp-pin__cover kp-cover-light" src={cover} alt="" loading="lazy" />
            <img className="kp-pin__cover kp-cover-dark" src={coverDark ?? cover} alt="" loading="lazy" />
          </>
        ) : icon ? (
          <span className="kp-pin__icon">{icon}</span>
        ) : (
          <DefaultTopicGlyph />
        )}
      </div>
      <div className="kp-pin__body">
        <h3 className="kp-pin__title">
          {renderLink({ href, className: 'kp-pin__titleLink', children: name })}
        </h3>
        {description ? <p className="kp-pin__desc">{description}</p> : null}
      </div>
    </article>
  );
}
