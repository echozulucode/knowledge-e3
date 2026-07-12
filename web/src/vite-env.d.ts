/// <reference types="vite/client" />

/**
 * Augment Vite's `ImportMetaEnv` with the project-specific env vars we read
 * via `import.meta.env`. Add a new key here when introducing another
 * `VITE_…` flag so TS sees it without `any`.
 */
interface ImportMetaEnv {
  /** Mirrors server KNOWLEDGE_E3_AUTH_MODE for client routing: 'disabled' skips sign-in redirect. */
  readonly VITE_KNOWLEDGE_E3_AUTH_MODE?: 'disabled' | 'session';
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
