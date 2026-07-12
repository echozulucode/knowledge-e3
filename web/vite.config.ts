import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const singletonPackages = [
  '@codemirror/autocomplete',
  '@codemirror/commands',
  '@codemirror/lang-markdown',
  '@codemirror/language',
  '@codemirror/search',
  '@codemirror/state',
  '@codemirror/view',
  '@lezer/common',
  '@lezer/highlight',
  '@lezer/markdown',
  '@lexical/code',
  '@lexical/link',
  '@lexical/list',
  '@lexical/markdown',
  '@lexical/react',
  '@lexical/rich-text',
  '@lexical/selection',
  '@lexical/table',
  '@lexical/utils',
  'lexical',
  'style-mod',
  'w3c-keyname',
];

// Proxy target is overridable so the Playwright e2e harness can point at the
// test API server (port 3001) while leaving the dev loop default (port 3000) alone.
const apiTarget = process.env['VITE_API_PROXY_TARGET'] ?? 'http://localhost:3000';
const port = process.env['PORT'] ? Number(process.env['PORT']) : 5173;

export default defineConfig({
  plugins: [react()],
  resolve: {
    // Keep sibling workspace editor packages resolved through this app's
    // node_modules graph so Vite/Rollup can find their runtime deps.
    preserveSymlinks: true,
    // CodeMirror relies on class identity/instanceof checks for extensions.
    // The standalone editor repo has its own node_modules for isolated dev, so
    // force these singleton packages to resolve from the Knowledge E3 app graph.
    dedupe: singletonPackages,
  },
  server: {
    port,
    strictPort: false,
    proxy: {
      '/api/v1': {
        target: apiTarget,
        changeOrigin: true,
      },
      // Bundle-relative image refs (`/assets/<file>`) are served by the API.
      '/assets': {
        target: apiTarget,
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/assets/, '/api/v1/assets'),
      },
    },
  },
});
