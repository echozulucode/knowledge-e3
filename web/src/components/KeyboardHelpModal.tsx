/**
 * Keyboard help modal: global shortcut listing.
 * Triggered by `?` outside of any input/contenteditable.
 * Closes on Esc; traps focus; has a clearly-labelled close button.
 *
 * Wave E3.
 */
import { useEffect, useRef } from 'react';

interface Shortcut {
  keys: string;
  description: string;
}

const NAVIGATION_SHORTCUTS: Shortcut[] = [
  { keys: 'Cmd/Ctrl + K', description: 'Open command palette' },
  { keys: 'Cmd/Ctrl + ?', description: 'Open keyboard shortcuts' },
  { keys: 'Cmd/Ctrl + S', description: 'Save page' },
  { keys: 'Esc', description: 'Cancel / close dialog' },
];

const EDITOR_MODE_SHORTCUTS: Shortcut[] = [
  { keys: 'Cmd/Ctrl + Shift + M', description: 'Cycle edit mode (Source / Hybrid / WYSIWYG)' },
];

const FORMATTING_SHORTCUTS: Shortcut[] = [
  { keys: 'Cmd/Ctrl + B', description: 'Bold' },
  { keys: 'Cmd/Ctrl + I', description: 'Italic' },
  { keys: 'Cmd/Ctrl + E', description: 'Inline code' },
  { keys: 'Cmd/Ctrl + `', description: 'Inline code (alternate)' },
  { keys: 'Cmd/Ctrl + 1', description: 'Heading 1' },
  { keys: 'Cmd/Ctrl + 2', description: 'Heading 2' },
  { keys: 'Cmd/Ctrl + 3', description: 'Heading 3' },
  { keys: 'Cmd/Ctrl + 0', description: 'Paragraph' },
  { keys: 'Cmd/Ctrl + Shift + 7', description: 'Numbered list' },
  { keys: 'Cmd/Ctrl + Shift + 8', description: 'Bulleted list' },
  { keys: 'Cmd/Ctrl + Shift + L', description: 'Bulleted list (alternate)' },
  { keys: 'Cmd/Ctrl + Shift + S', description: 'Strikethrough' },
];

const MARKDOWN_SHORTCUTS: Shortcut[] = [
  { keys: '**text**', description: 'Bold in Markdown' },
  { keys: '*text*', description: 'Italic in Markdown' },
  { keys: '`code`', description: 'Inline code in Markdown' },
  { keys: '# heading', description: 'Heading shortcut' },
  { keys: '- item', description: 'Bulleted-list shortcut' },
  { keys: '1. item', description: 'Numbered-list shortcut' },
  { keys: '- [ ] task', description: 'Task-list shortcut' },
  { keys: '> quote', description: 'Blockquote shortcut' },
];

const WIKI_SHORTCUTS: Shortcut[] = [
  { keys: '[[', description: 'Open page autocomplete (wikilink)' },
];

export function KeyboardHelpModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}): JSX.Element | null {
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    closeButtonRef.current?.focus();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 'var(--kp-z-modal)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: 'var(--kp-surface-overlay)',
        padding: '16px',
      }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="kbd-help-title"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        style={{
          width: '100%',
          maxWidth: '448px',
          borderRadius: 'var(--kp-radius-lg)',
          backgroundColor: 'var(--kp-surface-raised)',
          padding: '24px',
          boxShadow: 'var(--kp-shadow-lg)',
        }}
      >
        <div style={{ marginBottom: '16px', display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
          <h2
            id="kbd-help-title"
            style={{
              fontSize: 'var(--kp-text-lg)',
              fontWeight: 'var(--kp-weight-semibold)',
              color: 'var(--kp-text-primary)',
            }}
          >
            Keyboard shortcuts
          </h2>
          <button
            ref={closeButtonRef}
            type="button"
            onClick={onClose}
            aria-label="Close keyboard help"
            style={{
              borderRadius: 'var(--kp-radius-sm)',
              padding: '4px',
              backgroundColor: 'transparent',
              color: 'var(--kp-text-muted)',
              border: 'none',
              cursor: 'pointer',
              fontSize: '16px',
            }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'var(--kp-surface-sunken)';
              (e.currentTarget as HTMLButtonElement).style.color = 'var(--kp-text-primary)';
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'transparent';
              (e.currentTarget as HTMLButtonElement).style.color = 'var(--kp-text-muted)';
            }}
          >
            ✕
          </button>
        </div>

        <Section title="Navigation" shortcuts={NAVIGATION_SHORTCUTS} />
        <Section title="Editor modes" shortcuts={EDITOR_MODE_SHORTCUTS} />
        <Section title="Formatting (WYSIWYG)" shortcuts={FORMATTING_SHORTCUTS} />
        <Section title="Markdown shortcuts (WYSIWYG / Source / Hybrid)" shortcuts={MARKDOWN_SHORTCUTS} />
        <Section title="Wiki-links" shortcuts={WIKI_SHORTCUTS} />

        <p
          style={{
            marginTop: '16px',
            fontSize: 'var(--kp-text-xs)',
            color: 'var(--kp-text-muted)',
          }}
        >
          All shortcuts work across both editors unless noted. Press{' '}
          <kbd
            style={{
              borderRadius: 'var(--kp-radius-xs)',
              backgroundColor: 'var(--kp-surface-sunken)',
              paddingLeft: '6px',
              paddingRight: '6px',
              paddingTop: '2px',
              paddingBottom: '2px',
              fontSize: '10px',
              fontFamily: 'var(--kp-font-mono)',
              color: 'var(--kp-text-primary)',
            }}
          >
            Esc
          </kbd>{' '}
          or click outside to close.
        </p>
      </div>
    </div>
  );
}

function Section({ title, shortcuts }: { title: string; shortcuts: Shortcut[] }): JSX.Element {
  return (
    <div style={{ marginBottom: '16px' }}>
      <h3
        style={{
          marginBottom: '8px',
          fontSize: 'var(--kp-text-xs)',
          fontWeight: 'var(--kp-weight-semibold)',
          textTransform: 'uppercase',
          letterSpacing: 'var(--kp-tracking-snug)',
          color: 'var(--kp-text-muted)',
        }}
      >
        {title}
      </h3>
      <dl
        style={{
          display: 'grid',
          gridTemplateColumns: 'auto 1fr',
          gap: '16px 8px',
          fontSize: 'var(--kp-text-sm)',
        }}
      >
        {shortcuts.map((s) => (
          <div key={s.keys} style={{ display: 'contents' }}>
            <dt>
              <kbd
                style={{
                  borderRadius: 'var(--kp-radius-xs)',
                  backgroundColor: 'var(--kp-surface-sunken)',
                  paddingLeft: '8px',
                  paddingRight: '8px',
                  paddingTop: '2px',
                  paddingBottom: '2px',
                  fontFamily: 'var(--kp-font-mono)',
                  fontSize: 'var(--kp-text-xs)',
                  color: 'var(--kp-text-primary)',
                }}
              >
                {s.keys}
              </kbd>
            </dt>
            <dd style={{ color: 'var(--kp-text-secondary)' }}>{s.description}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

