/**
 * Sign-in page: POST /api/v1/auth/login
 *
 * Wave J redesign: centered card, Apple-professional layout with full dark mode support.
 * Wave E3 polish: friendly status-code mapping (401/429/5xx/network),
 * field values retained on error, accessible error live region.
 */

import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useLogin } from '../queries.js';
import type { ApiError } from '../api.js';
import './SignIn.css';

function describeError(err: unknown): string {
  const e = err as ApiError | undefined;
  if (!e) return 'Sign in failed.';
  if (e.network_error) {
    return "Couldn't reach the server. Check your connection or try again.";
  }
  if (e.statusCode === 401) {
    return 'Username or password is incorrect.';
  }
  if (e.statusCode === 429) {
    const secs = e.retry_after_seconds ?? 0;
    const mins = Math.max(1, Math.ceil(secs / 60));
    return `Too many failed attempts. Try again in ${mins} minute${mins === 1 ? '' : 's'}.`;
  }
  if (e.statusCode >= 500) {
    return "The server hit an error. We're looking at it — try again in a moment.";
  }
  return e.message ?? 'Sign in failed.';
}

export function SignIn() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();
  const login = useLogin();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    try {
      await login.mutateAsync({ username, password });
      navigate({ to: '/' });
    } catch (err) {
      // Field values are retained — no setUsername('') here.
      setError(describeError(err));
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      handleSubmit(e as unknown as React.FormEvent);
    }
  };

  return (
    <div className="kp-signin">
      <div className="kp-signin-card">
        <div className="kp-signin-wordmark">Knowledge</div>
        <div className="kp-signin-divider" />

        <h1 className="kp-signin-title">Sign in</h1>

        {error && (
          <div
            className="kp-signin-error"
            role="alert"
            aria-live="polite"
          >
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="kp-signin-form">
          <div className="kp-signin-field-group">
            <label htmlFor="username" className="kp-signin-label">
              Username
            </label>
            <input
              id="username"
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              onKeyDown={handleKeyDown}
              required
              autoComplete="username"
              className="kp-signin-input"
              placeholder="Enter your username"
            />
          </div>

          <div className="kp-signin-field-group">
            <label htmlFor="password" className="kp-signin-label">
              Password
            </label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={handleKeyDown}
              required
              autoComplete="current-password"
              className="kp-signin-input"
              placeholder="Enter your password"
            />
          </div>

          <button
            type="submit"
            disabled={login.isPending}
            className="kp-signin-submit"
          >
            {login.isPending ? 'Signing in...' : 'Sign in'}
          </button>
        </form>

        <div className="kp-signin-footer">
          <a href="#" className="kp-signin-help-link">
            Need help? ↗
          </a>
        </div>
      </div>
    </div>
  );
}
