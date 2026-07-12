/**
 * Top-level error boundary. Catches render errors, shows a calm fallback,
 * and surfaces the most-recent request id so the user (or maintainer)
 * can correlate with server logs.
 *
 * Wave E3: this is the first user-facing safety net for the trial cohort.
 */
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { getLastRequestId } from '../api.js';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // eslint-disable-next-line no-console
    console.error('[ErrorBoundary]', error, info);
  }

  private handleReload = (): void => {
    window.location.reload();
  };

  private handleReport = (): void => {
    const error = this.state.error;
    const requestId = getLastRequestId();
    const subject = encodeURIComponent('Bug report — render error');
    const body = encodeURIComponent(
      [
        `What I was doing:`,
        ``,
        ``,
        `--- Diagnostics (do not edit) ---`,
        `URL: ${window.location.href}`,
        `Request ID: ${requestId ?? '(none captured)'}`,
        `Error: ${error?.message ?? 'unknown'}`,
        `Stack:`,
        error?.stack ?? '(no stack)',
      ].join('\n'),
    );
    // No bug-report dialog UI exists in v0.1 yet; this is a graceful
    // fallback that opens a mailto with the diagnostics pre-filled. Wave F1
    // (trial-readiness-final) will replace this with an in-app dialog.
    window.location.href = `mailto:?subject=${subject}&body=${body}`;
  };

  override render(): ReactNode {
    if (!this.state.error) return this.props.children;

    const requestId = getLastRequestId();
    return (
      <div
        style={{
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '24px',
          backgroundColor: 'var(--kp-surface-canvas)',
        }}
      >
        <div
          style={{
            width: '100%',
            maxWidth: '512px',
            borderRadius: 'var(--kp-radius-lg)',
            border: '1px solid var(--kp-border-subtle)',
            backgroundColor: 'var(--kp-surface-raised)',
            padding: '32px',
            boxShadow: 'var(--kp-shadow-sm)',
          }}
        >
          <h1
            style={{
              marginBottom: '8px',
              fontSize: 'var(--kp-text-2xl)',
              fontWeight: 'var(--kp-weight-bold)',
              color: 'var(--kp-text-primary)',
            }}
          >
            Something went wrong
          </h1>
          <p
            style={{
              marginBottom: '16px',
              color: 'var(--kp-text-secondary)',
              fontSize: 'var(--kp-text-base)',
            }}
          >
            The page failed to render. Reloading usually clears it. If it keeps
            happening, file a bug report so we can fix it.
          </p>

          <details
            style={{
              marginBottom: '16px',
              borderRadius: 'var(--kp-radius-sm)',
              backgroundColor: 'var(--kp-surface-sunken)',
              padding: '12px',
              fontSize: 'var(--kp-text-sm)',
            }}
          >
            <summary style={{ cursor: 'pointer', fontWeight: 'var(--kp-weight-medium)', color: 'var(--kp-text-primary)' }}>
              Diagnostics
            </summary>
            <dl
              style={{
                marginTop: '8px',
                display: 'grid',
                gridTemplateColumns: 'auto 1fr',
                gap: '12px 12px 4px 4px',
                fontSize: 'var(--kp-text-xs)',
                color: 'var(--kp-text-secondary)',
              }}
            >
              <dt style={{ fontWeight: 'var(--kp-weight-medium)' }}>URL</dt>
              <dd style={{ wordBreak: 'break-all', fontFamily: 'var(--kp-font-mono)' }}>{window.location.href}</dd>
              <dt style={{ fontWeight: 'var(--kp-weight-medium)' }}>Request ID</dt>
              <dd style={{ fontFamily: 'var(--kp-font-mono)' }}>{requestId ?? '—'}</dd>
              <dt style={{ fontWeight: 'var(--kp-weight-medium)' }}>Error</dt>
              <dd style={{ fontFamily: 'var(--kp-font-mono)' }}>{this.state.error.message}</dd>
            </dl>
          </details>

          <div style={{ display: 'flex', gap: '12px' }}>
            <button
              type="button"
              onClick={this.handleReload}
              style={{
                borderRadius: 'var(--kp-radius-sm)',
                backgroundColor: 'var(--kp-accent)',
                color: 'var(--kp-accent-fg)',
                paddingLeft: '16px',
                paddingRight: '16px',
                paddingTop: '8px',
                paddingBottom: '8px',
                fontSize: 'var(--kp-text-sm)',
                fontWeight: 'var(--kp-weight-medium)',
                border: 'none',
                cursor: 'pointer',
              }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'var(--kp-accent-hover)';
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'var(--kp-accent)';
              }}
            >
              Reload page
            </button>
            <button
              type="button"
              onClick={this.handleReport}
              style={{
                borderRadius: 'var(--kp-radius-sm)',
                border: '1px solid var(--kp-border-subtle)',
                paddingLeft: '16px',
                paddingRight: '16px',
                paddingTop: '8px',
                paddingBottom: '8px',
                fontSize: 'var(--kp-text-sm)',
                fontWeight: 'var(--kp-weight-medium)',
                color: 'var(--kp-text-primary)',
                backgroundColor: 'transparent',
                cursor: 'pointer',
              }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'var(--kp-surface-sunken)';
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'transparent';
              }}
              aria-label="Report this error to the maintainer"
            >
              Report this
            </button>
          </div>
        </div>
      </div>
    );
  }
}
