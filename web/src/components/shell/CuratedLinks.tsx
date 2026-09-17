/**
 * `<CuratedLinks>` — the curator's own links on the front page (reader plan §4,
 * R2.4): "custom news, updates and links to sections from the main page".
 *
 * The items on the front page were always curatable (Sections as slots,
 * `homepage_until`, `featured_until`, a Topic in the `blog` profile for news).
 * What no surface could carry was an *arbitrary* link — to a Section, to a
 * runbook, to a team's wiki. This renders those, from `links:` in the topic
 * bundle's own `index.md`, so the curation is committed beside the content.
 *
 * Renders nothing at all when a topic has no links, which is every topic until
 * someone curates one — absence is the signal, as with the freshness badges.
 */
import React from 'react';
import { Link } from '@tanstack/react-router';
import { Icon, appIcons } from '../../icons.js';
import type { SiteLink } from './siteBranding.js';
import './CuratedLinks.css';

interface CuratedLinksProps {
  links: SiteLink[] | undefined;
  /** Heading above the row; omit for none. */
  heading?: string;
}

export const CuratedLinks: React.FC<CuratedLinksProps> = ({ links, heading = 'Quick links' }) => {
  if (!links || links.length === 0) return null;

  return (
    <section className="CuratedLinks" aria-label={heading}>
      <h2 className="CuratedLinks__heading">
        <Icon icon={appIcons.compass} fixedWidth={false} /> {heading}
      </h2>
      <ul className="CuratedLinks__row">
        {links.map((link) => (
          <li key={`${link.label}:${link.to ?? link.href}`}>
            {link.to ? (
              // An in-app route: a real router link, so it keeps Back, prefetch
              // and scroll restoration like every other navigation.
              <Link to={link.to as never} className="CuratedLinks__link">
                <span className="CuratedLinks__label">{link.label}</span>
                {link.description ? <span className="CuratedLinks__desc">{link.description}</span> : null}
              </Link>
            ) : (
              // Leaving the instance: new tab, and `noreferrer` so an intranet
              // URL never learns which internal page sent the reader.
              <a
                href={link.href}
                className="CuratedLinks__link"
                target="_blank"
                rel="noopener noreferrer"
              >
                <span className="CuratedLinks__label">
                  {link.label}{' '}
                  <Icon icon={appIcons.arrowRight} fixedWidth={false} />
                </span>
                {link.description ? <span className="CuratedLinks__desc">{link.description}</span> : null}
              </a>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
};
