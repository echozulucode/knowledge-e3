/**
 * ThemeToggle — cycles through system → light → dark → system.
 *
 * `variant="row"` renders it as a drawer row (icon + "Theme: …" label). On a
 * phone the header has no room for the icon button beside the topic switcher,
 * search and account controls, so the header hides it and the navigation
 * drawer shows this row instead (GlobalHeader.css, Sidebar.css) — the control
 * moves rather than shrinking below a usable tap target.
 */

import React from 'react';
import { useTheme } from '../../styles/theme.js';
import { Icon, appIcons } from '../../icons.js';

interface ThemeToggleProps {
  variant?: 'icon' | 'row';
  className?: string;
}

const MODE_LABEL = { system: 'System', light: 'Light', dark: 'Dark' } as const;

export const ThemeToggle: React.FC<ThemeToggleProps> = ({ variant = 'icon', className }) => {
  const { mode, cycleMode } = useTheme();
  const icon = mode === 'system' ? appIcons.desktop : mode === 'light' ? appIcons.sun : appIcons.moon;

  if (variant === 'row') {
    return (
      <button
        type="button"
        onClick={cycleMode}
        title={`Theme: ${mode} (click to cycle)`}
        aria-label={`Current theme: ${mode}. Click to toggle.`}
        className={className}
      >
        <span className="kp-sidebar-icon"><Icon icon={icon} /></span>
        <span className="kp-sidebar-label">Theme: {MODE_LABEL[mode]}</span>
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={cycleMode}
      title={`Theme: ${mode} (click to cycle)`}
      aria-label={`Current theme: ${mode}. Click to toggle.`}
      className={className ? `kp-theme-toggle ${className}` : 'kp-theme-toggle'}
    >
      <Icon icon={icon} />
    </button>
  );
};
