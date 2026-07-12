/**
 * Toast — notification viewport and individual toast components
 *
 * ToastViewport consumes useToast hook and renders toasts in bottom-left corner.
 * Supports success, error, and info kinds with appropriate icons and roles.
 * Respects prefers-reduced-motion for accessibility.
 */

import { useEffect, useState } from 'react';
import { useToast, type Toast } from '../hooks/useToast.js';
import './Toast.css';

/**
 * Inline SVG icons for toast kinds
 */
function SuccessIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function ErrorIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="10" />
      <line x1="15" y1="9" x2="9" y2="15" />
      <line x1="9" y1="9" x2="15" y2="15" />
    </svg>
  );
}

function InfoIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="16" x2="12" y2="12" />
      <line x1="12" y1="8" x2="12.01" y2="8" />
    </svg>
  );
}

function DismissIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

/**
 * Individual toast item
 */
interface ToastItemProps {
  toast: Toast;
  onDismiss: (id: string) => void;
}

function ToastItem({ toast, onDismiss }: ToastItemProps) {
  const handleAction = () => {
    toast.onAction?.();
    onDismiss(toast.id);
  };

  const iconColor =
    toast.kind === 'success'
      ? 'var(--kp-success)'
      : toast.kind === 'error'
        ? 'var(--kp-danger)'
        : 'var(--kp-info)';

  return (
    <div
      className="kp-toast-item"
      role={toast.kind === 'error' ? 'alert' : 'status'}
      aria-live={toast.kind === 'error' ? 'assertive' : 'polite'}
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 'var(--kp-space-2)',
        padding: 'var(--kp-space-3) var(--kp-space-4)',
        background: 'var(--kp-surface-raised)',
        border: '1px solid var(--kp-border-subtle)',
        borderRadius: 'var(--kp-radius-md)',
        boxShadow: 'var(--kp-shadow-md)',
        fontSize: 'var(--kp-text-sm)',
        color: 'var(--kp-text-primary)',
        animation: 'kp-toast-in 200ms var(--kp-ease) forwards',
      }}
    >
      {/* Icon */}
      <div style={{ color: iconColor, flexShrink: 0, marginTop: '2px' }}>
        {toast.kind === 'success' && <SuccessIcon />}
        {toast.kind === 'error' && <ErrorIcon />}
        {toast.kind === 'info' && <InfoIcon />}
      </div>

      {/* Content */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 'var(--kp-space-2)' }}>
        <p style={{ margin: 0, fontWeight: 'var(--kp-weight-medium)' }}>{toast.message}</p>

        {/* Action button */}
        {toast.actionLabel && (
          <button
            onClick={handleAction}
            style={{
              alignSelf: 'flex-start',
              padding: '4px 8px',
              fontSize: 'var(--kp-text-xs)',
              fontWeight: 'var(--kp-weight-semibold)',
              color: 'var(--kp-accent)',
              background: 'transparent',
              border: 'none',
              borderRadius: 'var(--kp-radius-xs)',
              cursor: 'pointer',
              transition: 'all var(--kp-duration) var(--kp-ease)',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = 'var(--kp-accent-bg)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'transparent';
            }}
          >
            {toast.actionLabel}
          </button>
        )}
      </div>

      {/* Dismiss button */}
      <button
        onClick={() => onDismiss(toast.id)}
        aria-label="Close notification"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: '24px',
          height: '24px',
          padding: 0,
          background: 'transparent',
          border: 'none',
          color: 'var(--kp-text-secondary)',
          cursor: 'pointer',
          transition: 'color var(--kp-duration) var(--kp-ease)',
          flexShrink: 0,
          borderRadius: 'var(--kp-radius-xs)',
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.color = 'var(--kp-text-primary)';
          e.currentTarget.style.background = 'var(--kp-surface-sunken)';
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.color = 'var(--kp-text-secondary)';
          e.currentTarget.style.background = 'transparent';
        }}
      >
        <DismissIcon />
      </button>
    </div>
  );
}

/**
 * ToastViewport — renders all toasts in a fixed position
 * Can be mounted from Root (global) or PageView (page-scoped)
 */
export function ToastViewport() {
  const { toasts, dismiss } = useToast();
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);

  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    setPrefersReducedMotion(media.matches);

    const handleChange = () => setPrefersReducedMotion(media.matches);
    media.addEventListener('change', handleChange);
    return () => media.removeEventListener('change', handleChange);
  }, []);

  return (
    <div
      className="kp-toast-viewport"
      style={{
        position: 'fixed',
        bottom: 'var(--kp-space-6)',
        left: 'var(--kp-space-6)',
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--kp-space-3)',
        zIndex: 'var(--kp-z-toast)',
        pointerEvents: 'none',
        maxWidth: '100%',
      }}
    >
      {toasts.map((toast) => (
        <div
          key={toast.id}
          style={{
            pointerEvents: 'auto',
            animation: prefersReducedMotion ? 'none' : undefined,
          }}
        >
          <ToastItem toast={toast} onDismiss={dismiss} />
        </div>
      ))}
    </div>
  );
}
