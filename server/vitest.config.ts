import { defineConfig } from 'vitest/config';
import swc from 'unplugin-swc';

// NestJS DI relies on `emitDecoratorMetadata`, which esbuild (vite's default
// TS transform) does not implement. Run sources through SWC instead so that
// constructor parameter types are reflected and `@Injectable()` providers
// resolve their dependencies at test time.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    globals: false,
    environment: 'node',
    testTimeout: 15000,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov', 'json-summary'],
      reportsDirectory: './coverage',
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.test.ts',
        'src/**/*.dto.ts',
        'src/**/*.module.ts',
        'src/main.ts',
        'src/seed.ts',
        'src/db/migrate.ts',
      ],
    },
  },
  plugins: [
    swc.vite({
      module: { type: 'es6' },
      jsc: {
        target: 'es2022',
        parser: { syntax: 'typescript', decorators: true },
        transform: {
          legacyDecorator: true,
          decoratorMetadata: true,
        },
      },
    }),
  ],
});
