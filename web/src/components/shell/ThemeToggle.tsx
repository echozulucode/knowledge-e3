/**
 * ThemeToggle — cycles through system → light → dark → system.
 */

import React from 'react';
import { useTheme } from '../../styles/theme.js';
import { Icon, appIcons } from '../../icons.js';

export const ThemeToggle: React.FC = () => {
  const { mode, cycleMode } = useTheme();
  const icon = mode === 'system' ? appIcons.desktop : mode === 'light' ? appIcons.sun : appIcons.moon;

  return (
    <button
      type="button"
      onClick={cycleMode}
      title={`Theme: ${mode} (click to cycle)`}
      aria-label={`Current theme: ${mode}. Click to toggle.`}
      className="kp-theme-toggle"
    >
      <Icon icon={icon} />
    </button>
  );
};
