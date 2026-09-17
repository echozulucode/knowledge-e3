/**
 * Topic icon tokens -> glyphs (home plan R2.5). The token list is closed and
 * shared (`PIN_ICONS` in @echozedlabs/ui and on the server); an unknown token
 * renders the neutral default rather than nothing, so a stale config costs a
 * topic its icon, never its card.
 */
import React from 'react';
import { PIN_ICONS, type PinIcon } from '@echozedlabs/ui';
import { Icon, appIcons } from '../../icons.js';

export function isPinIcon(token: unknown): token is PinIcon {
  return typeof token === 'string' && (PIN_ICONS as readonly string[]).includes(token);
}

export const TopicIcon: React.FC<{ token?: string | null }> = ({ token }) => (
  <Icon icon={isPinIcon(token) ? appIcons[token] : appIcons.layerGroup} fixedWidth={false} />
);
