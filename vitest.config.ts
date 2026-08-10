import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    // Unit tests are co-located as *.spec.ts next to their module; feature /
    // integration tests (whole-App e2e) live in tests/ as *.test.ts.
    include: ['src/**/*.spec.{ts,tsx}', 'tests/**/*.test.{ts,tsx}'],
    // 実 git を叩くテストを開発者のグローバル設定から切り離す（issue #110）。
    setupFiles: ['./tests/setup-git-config.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/core/**', 'src/utils/**'],
      exclude: ['**/*.spec.{ts,tsx}', '**/__fixtures__/**'],
      thresholds: {
        // The PRD requires 80%+ coverage of core logic (statements/functions/lines).
        lines: 80,
        functions: 80,
        statements: 80,
        // Branch coverage is held slightly lower: the remaining uncovered branches
        // are defensive `?? default` / optional-chaining fallbacks against untyped
        // SDK data, which are not worth forcing artificial tests for.
        branches: 75,
      },
    },
  },
});
