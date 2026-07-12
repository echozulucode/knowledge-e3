/**
 * Theme system — system / light / dark.
 *
 * Persists the choice both in localStorage ('kp-theme', the offline fallback)
 * and, for signed-in users, server-side via /me/prefs so it follows the account
 * across devices. Applied via the `data-theme` attribute on <html>; tokens.css
 * handles the rest.
 */

import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { apiClient } from '../api.js';

export type ThemeMode = 'system' | 'light' | 'dark';

interface ThemeContextValue {
  mode: ThemeMode;
  setMode: (mode: ThemeMode) => void;
  /** Cycle: system → light → dark → system. Used by the header toggle. */
  cycleMode: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

const STORAGE_KEY = 'kp-theme';

function readInitialMode(): ThemeMode {
  if (typeof window === 'undefined') return 'system';
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === 'light' || stored === 'dark' || stored === 'system') return stored;
  } catch {
    // localStorage may be unavailable (privacy mode); fall through
  }
  return 'system';
}

export const ThemeProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [mode, setModeState] = useState<ThemeMode>(readInitialMode);

  // Apply mode to <html> data-theme attribute
  useEffect(() => {
    const root = document.documentElement;
    root.setAttribute('data-theme', mode);
  }, [mode]);

  // For a signed-in user, hydrate the theme from their server-side preference
  // once on mount so it follows the account across devices. Unauthenticated or
  // offline requests fail quietly and we keep the localStorage value.
  useEffect(() => {
    let cancelled = false;
    apiClient
      .get<{ prefs: Record<string, unknown> }>('/me/prefs')
      .then((res) => {
        if (cancelled) return;
        const serverTheme = res.prefs?.['theme'];
        if (serverTheme === 'light' || serverTheme === 'dark' || serverTheme === 'system') {
          setModeState(serverTheme);
          try {
            window.localStorage.setItem(STORAGE_KEY, serverTheme);
          } catch {
            /* ignore */
          }
        }
      })
      .catch(() => {
        /* not signed in / offline — keep the local value */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const setMode = useCallback((next: ThemeMode) => {
    setModeState(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // ignore — non-critical
    }
    // Best-effort server sync; ignore failures (e.g. signed out).
    void apiClient.put('/me/prefs', { key: 'theme', value: next }).catch(() => {});
  }, []);

  const cycleMode = useCallback(() => {
    setMode(mode === 'system' ? 'light' : mode === 'light' ? 'dark' : 'system');
  }, [mode, setMode]);

  return (
    <ThemeContext.Provider value={{ mode, setMode, cycleMode }}>
      {children}
    </ThemeContext.Provider>
  );
};

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    throw new Error('useTheme must be used inside <ThemeProvider>');
  }
  return ctx;
}
