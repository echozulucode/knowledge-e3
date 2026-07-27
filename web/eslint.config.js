import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

/**
 * Deliberately narrow lint config.
 *
 * The point of adding ESLint here was a concrete bug: `useContentTypes()` was
 * called *after* an early return in PageView, which React only surfaces at
 * runtime ("Rendered more hooks than during the previous render"). Neither
 * `tsc --noEmit` nor `vite build` can catch that class of error.
 *
 * So `react-hooks/rules-of-hooks` is an ERROR and nearly everything else is
 * off or a warning. This codebase has never been linted, so a config that
 * reports hundreds of pre-existing style violations would just get ignored --
 * and then it catches nothing at all. Tighten incrementally.
 */
export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'dist-tsc/**',
      'node_modules/**',
      'spike/**',
      'coverage/**',
      'playwright-report/**',
      'test-results/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx,js}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      // The reason this config exists.
      'react-hooks/rules-of-hooks': 'error',
      // Real, but noisy on a never-linted codebase. Warn so it surfaces
      // without failing the gate; promote to error once burned down.
      'react-hooks/exhaustive-deps': 'warn',

      // `tsc` already resolves identifiers, and it understands the DOM/Node
      // lib types that this rule does not. Leaving it on produced ~200 false
      // positives on globals like `document`, `process`, and `console`.
      'no-undef': 'off',

      // Stylistic or already covered by tsconfig's noUnusedLocals.
      '@typescript-eslint/no-unused-vars': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-empty-object-type': 'off',
      'no-useless-escape': 'off',
      'no-useless-assignment': 'off',
      'no-empty': 'off',
      'prefer-const': 'off',
    },
  },
  {
    // Playwright fixtures take a callback named `use`, which the hooks plugin
    // heuristically reads as a React Hook call in a non-component function.
    // It is not; these files contain no React.
    files: ['tests/**'],
    rules: {
      'react-hooks/rules-of-hooks': 'off',
      'react-hooks/exhaustive-deps': 'off',
    },
  },
);
