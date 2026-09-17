/**
 * `<SiteFooter>` — the product's own attribution, at the bottom of the page.
 *
 * Eric's fourth requirement: "Knowledge x 10^3 and tag line should be removed
 * since we want to focus on the company configuration. We should put that
 * subtle at the bottom." The tenant's identity takes the top; ours is the
 * colophon.
 *
 * Two decisions worth stating:
 *
 * - **The literal is its own string, not `brand.name`.** They happen to share a
 *   default value today, and conflating them is exactly how an Acme-branded
 *   instance ends up saying "Powered by Acme". This line is ours; `brand.name`
 *   is the tenant's.
 * - **Unconditional.** It renders whether or not a tenant configured a name,
 *   which is the point of moving it down here rather than deleting it: the
 *   attribution does not participate in `usingDefaultName`.
 *
 * Where it sits is Home's business, not this component's: the page is a flex
 * column and gives the footer `margin-top: auto`, so it is flush against the
 * bottom of the viewport when the content is short and follows the last block
 * when it is long (Eric, 2026-09-12).
 *
 * The `× 10³` superscript treatment is the product's own typography, in the
 * product's own colophon, which is the one place it is unambiguously ours.
 */
import React from 'react';
import './SiteFooter.css';

export const SiteFooter: React.FC = () => (
  <footer className="SiteFooter">
    <span className="SiteFooter__colophon">
      Powered by Knowledge × 10<sup>3</sup>
    </span>
  </footer>
);
