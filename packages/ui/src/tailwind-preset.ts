/**
 * Tailwind preset — maps the `--kp-*` design tokens (tokens.css) into the
 * Tailwind theme so utilities like `bg-surface-canvas`, `text-text-secondary`,
 * `border-border-subtle`, `rounded-md`, `font-mono` resolve to the same CSS
 * variables every hand-written stylesheet reads. Because the values are
 * `var()` references, light / dark / system themes keep working with no
 * Tailwind dark-mode configuration.
 *
 * Only tokens that exist in tokens.css are mapped. Type scale and the 4px
 * spacing grid are deliberately NOT mapped onto Tailwind's `fontSize` /
 * `spacing` keys: those would silently reshape every existing `text-sm` /
 * `p-4` in the app (the root font-size is 15px, so rem-based defaults and the
 * px tokens disagree by a pixel). Measure tokens are exposed under `maxWidth`.
 */
import type { Config } from 'tailwindcss';

export const preset: Partial<Config> = {
  theme: {
    extend: {
      colors: {
        surface: {
          canvas: 'var(--kp-surface-canvas)',
          base: 'var(--kp-surface-base)',
          raised: 'var(--kp-surface-raised)',
          sunken: 'var(--kp-surface-sunken)',
          muted: 'var(--kp-surface-muted)',
          overlay: 'var(--kp-surface-overlay)',
        },
        text: {
          primary: 'var(--kp-text-primary)',
          secondary: 'var(--kp-text-secondary)',
          muted: 'var(--kp-text-muted)',
          inverse: 'var(--kp-text-inverse)',
        },
        border: {
          subtle: 'var(--kp-border-subtle)',
          strong: 'var(--kp-border-strong)',
          focus: 'var(--kp-border-focus)',
        },
        brand: {
          DEFAULT: 'var(--kp-brand)',
          strong: 'var(--kp-brand-strong)',
          soft: 'var(--kp-brand-soft)',
          contrast: 'var(--kp-brand-contrast)',
          ring: 'var(--kp-brand-ring)',
        },
        warm: {
          DEFAULT: 'var(--kp-warm)',
          soft: 'var(--kp-warm-soft)',
        },
        accent: {
          DEFAULT: 'var(--kp-accent)',
          hover: 'var(--kp-accent-hover)',
          bg: 'var(--kp-accent-bg)',
          fg: 'var(--kp-accent-fg)',
        },
        success: { DEFAULT: 'var(--kp-success)', bg: 'var(--kp-success-bg)' },
        warning: { DEFAULT: 'var(--kp-warning)', bg: 'var(--kp-warning-bg)' },
        danger: { DEFAULT: 'var(--kp-danger)', bg: 'var(--kp-danger-bg)' },
        info: { DEFAULT: 'var(--kp-info)', bg: 'var(--kp-info-bg)' },
        type: {
          reference: 'var(--kp-type-reference)',
          support: 'var(--kp-type-support)',
          operations: 'var(--kp-type-operations)',
          guides: 'var(--kp-type-guides)',
          decisions: 'var(--kp-type-decisions)',
          publishing: 'var(--kp-type-publishing)',
        },
      },
      borderRadius: {
        xs: 'var(--kp-radius-xs)',
        sm: 'var(--kp-radius-sm)',
        md: 'var(--kp-radius-md)',
        lg: 'var(--kp-radius-lg)',
        pill: 'var(--kp-radius-pill)',
      },
      fontFamily: {
        ui: 'var(--kp-font-ui)',
        mono: 'var(--kp-font-mono)',
      },
      boxShadow: {
        xs: 'var(--kp-shadow-xs)',
        sm: 'var(--kp-shadow-sm)',
        md: 'var(--kp-shadow-md)',
        lg: 'var(--kp-shadow-lg)',
        fab: 'var(--kp-shadow-fab)',
      },
      maxWidth: {
        article: 'var(--kp-article-width)',
        content: 'var(--kp-content-max-width)',
        prose: 'var(--kp-prose-max-width)',
      },
      zIndex: {
        dropdown: 'var(--kp-z-dropdown)',
        sticky: 'var(--kp-z-sticky)',
        fab: 'var(--kp-z-fab)',
        overlay: 'var(--kp-z-overlay)',
        modal: 'var(--kp-z-modal)',
        toast: 'var(--kp-z-toast)',
      },
      transitionTimingFunction: {
        kp: 'var(--kp-ease)',
        spring: 'var(--kp-ease-spring)',
      },
      transitionDuration: {
        fast: 'var(--kp-duration-fast)',
        DEFAULT: 'var(--kp-duration)',
        slow: 'var(--kp-duration-slow)',
      },
    },
  },
};

export default preset;
