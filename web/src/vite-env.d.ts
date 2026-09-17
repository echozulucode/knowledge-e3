/// <reference types="vite/client" />

/**
 * Project-specific `VITE_…` flags read via `import.meta.env` are declared here by
 * augmenting Vite's `ImportMetaEnv`:
 *
 *   interface ImportMetaEnv {
 *     readonly VITE_EXAMPLE_FLAG?: string;
 *   }
 *
 * There are none today. `VITE_KNOWLEDGE_E3_AUTH_MODE` was removed with the
 * server's authentication-disabled mode: the server refuses to start without
 * authentication, so the client has no sign-in bypass to mirror.
 */
