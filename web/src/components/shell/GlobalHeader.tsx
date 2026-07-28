/**
 * GlobalHeader — top bar with logo, theme toggle, user menu
 * 56px tall, sticky at top.
 */

import React, { useState } from 'react';
import { useMe, useLogout } from '../../queries.js';
import { useNavigate } from '@tanstack/react-router';
import { ThemeToggle } from './ThemeToggle.js';
import { SpaceSwitcher } from './SpaceSwitcher.js';
import { Icon, appIcons } from '../../icons.js';
import './GlobalHeader.css';

interface GlobalHeaderProps {
  onOpenPalette?: () => void;
  onOpenNav?: () => void;
}

export const GlobalHeader: React.FC<GlobalHeaderProps> = ({ onOpenPalette, onOpenNav }) => {
  const { data: user } = useMe();
  const navigate = useNavigate();
  const logout = useLogout();
  const [userMenuOpen, setUserMenuOpen] = useState(false);

  const handleLogout = async () => {
    setUserMenuOpen(false);
    await logout.mutateAsync();
    navigate({ to: '/login' });
  };

  return (
    <header className="kp-header">
      <div className="kp-header-content">
        {/* Breadcrumb / space switcher */}
        <div className="kp-header-start">
          {onOpenNav && (
            <button
              type="button"
              className="kp-header-hamburger"
              onClick={onOpenNav}
              aria-label="Open navigation"
              title="Menu"
            >
              <Icon icon={appIcons.bars} />
            </button>
          )}
          <SpaceSwitcher />
        </div>

        {/* Center search trigger (opens the command palette) */}
        {onOpenPalette ? (
          <button
            type="button"
            className="kp-palette-trigger kp-header-search"
            onClick={onOpenPalette}
            aria-label="Jump to a page (Command or Control + K)"
          >
            <Icon icon={appIcons.magnifyingGlass} />
            <span>Jump to a page…</span>
            <kbd>⌘K</kbd>
          </button>
        ) : (
          <div className="kp-header-spacer" />
        )}

        {/* Compact search (mobile, when the full trigger is hidden) */}
        {onOpenPalette && (
          <button
            type="button"
            className="kp-header-search-mobile"
            onClick={onOpenPalette}
            aria-label="Jump to a page"
            title="Jump to a page"
          >
            <Icon icon={appIcons.magnifyingGlass} />
          </button>
        )}

        {/* Theme Toggle */}
        <ThemeToggle />

        {/* User Menu */}
        {user && (
          <div className="kp-user-menu-container">
            <button
              type="button"
              onClick={() => setUserMenuOpen(!userMenuOpen)}
              className="kp-user-chip"
              aria-label={`User menu for ${user.username}`}
              title={`${user.username}`}
            >
              <Icon icon={appIcons.user} />
              <span className="kp-user-name">{user.username}</span>
              <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.5" fill="none" />
              </svg>
            </button>

            {/* User Dropdown Menu */}
            {userMenuOpen && (
              <div className="kp-user-dropdown">
                <button
                  type="button"
                  onClick={() => {
                    setUserMenuOpen(false);
                    navigate({ to: '/profile' });
                  }}
                  className="kp-user-dropdown-item kp-user-dropdown-item--icon"
                >
                  <Icon icon={appIcons.user} />
                  <span>Profile</span>
                </button>
                {user.role === 'admin' && (
                  <button
                    type="button"
                    onClick={() => {
                      setUserMenuOpen(false);
                      navigate({ to: '/admin' });
                    }}
                    className="kp-user-dropdown-item kp-user-dropdown-item--icon"
                  >
                    <Icon icon={appIcons.gear} />
                    <span>Admin</span>
                  </button>
                )}
                <button
                  type="button"
                  onClick={handleLogout}
                  disabled={logout.isPending}
                  className="kp-user-dropdown-item kp-user-dropdown-item--icon"
                >
                  <Icon icon={appIcons.rightFromBracket} />
                  <span>Sign out</span>
                </button>
              </div>
            )}
          </div>
        )}

        {/* Sign Out Button (Old style, for backwards compat) */}
        {!user && (
          <button
            className="kp-header-cta"
            onClick={() => navigate({ to: '/login' })}
          >
            Sign In
          </button>
        )}
      </div>
    </header>
  );
};
