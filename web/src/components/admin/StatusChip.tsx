/**
 * StatusChip — the ONE status vocabulary for admin (the admin UX review §3.2),
 * replacing the four ad-hoc ones (badges, coloured dots, bold words, emoji).
 *
 * Use it for the state of a thing: a source's sync, a section's match count, a
 * health verdict, a token's expiry. Pick the tone by what the admin should do:
 *   ok      - fine, nothing to do            info  - neutral fact worth noticing
 *   pending - in progress / waiting          warn  - works, but look at it
 *   error   - broken, act now
 *
 * Rule (§3.3): status is never colour alone - every chip carries an icon AND a
 * text label, so it reads in greyscale, for colour-blind admins and to screen
 * readers (the icon is decorative; the label is the accessible text). `title`
 * adds the longer explanation on hover but must never be the only place a
 * meaning lives.
 */
import type { ReactNode } from 'react';
import './StatusChip.css';

export type StatusTone = 'ok' | 'info' | 'pending' | 'warn' | 'error';

export interface StatusChipProps {
  tone: StatusTone;
  label: string;
  title?: string;
  size?: 'sm' | 'md';
}

const ICON_PATHS: Record<StatusTone, ReactNode> = {
  ok: <polyline points="20 6 9 17 4 12" />,
  info: (
    <>
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="16" x2="12" y2="11" />
      <line x1="12" y1="8" x2="12.01" y2="8" />
    </>
  ),
  pending: (
    <>
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 7 12 12 15 14" />
    </>
  ),
  warn: (
    <>
      <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </>
  ),
  error: (
    <>
      <circle cx="12" cy="12" r="10" />
      <line x1="15" y1="9" x2="9" y2="15" />
      <line x1="9" y1="9" x2="15" y2="15" />
    </>
  ),
};

export function StatusIcon({ tone }: { tone: StatusTone }): JSX.Element {
  return (
    <svg className="kp-status-chip__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {ICON_PATHS[tone]}
    </svg>
  );
}

export function StatusChip({ tone, label, title, size = 'md' }: StatusChipProps): JSX.Element {
  return (
    <span className="kp-status-chip" data-tone={tone} data-size={size} title={title}>
      <StatusIcon tone={tone} />
      <span className="kp-status-chip__label">{label}</span>
    </span>
  );
}
