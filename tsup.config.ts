import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.tsx'],
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  outDir: 'dist',
  clean: true,
  // The `claude` CLI binary and native deps must be resolved at runtime, so
  // dependencies stay external (tsup externalizes package.json deps by default).
  banner: { js: '#!/usr/bin/env node' },
});
