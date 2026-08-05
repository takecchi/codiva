import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.tsx'],
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  outDir: 'dist',
  clean: true,
  // `src/index.tsx` は NODE_ENV を立ててから `./main` を **動的 import** するだけの
  // シムなので、分割が必須（同一ファイルに畳むと ink / react の static import が
  // 巻き上げられ、代入より先に react-reconciler が評価されてしまう）。
  splitting: true,
  // The `claude` CLI binary and native deps must be resolved at runtime, so
  // dependencies stay external (tsup externalizes package.json deps by default).
  banner: { js: '#!/usr/bin/env node' },
});
