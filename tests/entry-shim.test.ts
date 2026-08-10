import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * `src/index.tsx` は「NODE_ENV を立ててから `./main` を動的 import するだけ」のシム。
 *
 * ここを守らないと React が dev ビルドで動き、レンダーごとに `performance.measure()` が
 * 積まれて（Node は user timing を自動で捨てない）ヒープが単調増加する = 実際に OOM で
 * 3 回落ちた不具合が戻る。static import を 1 本足すだけで巻き上げられて壊れる（見た目では
 * 気づけない）ので、テストで固定する。
 */
const source = readFileSync(fileURLToPath(new URL('../src/index.tsx', import.meta.url)), 'utf8');

// コメント・文字列内の記述に引っかからないよう、コード行だけを見る。
const code = source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line.length > 0);

describe('エントリシム (src/index.tsx)', () => {
  it('static import を持たない（巻き上げられて NODE_ENV の代入より先に評価されるため）', () => {
    expect(code.filter((line) => /^import\s+(?!\()/.test(line))).toEqual([]);
  });

  it('NODE_ENV の代入が動的 import より前にある', () => {
    const assign = code.findIndex((line) => line.includes('process.env.NODE_ENV'));
    const dynamic = code.findIndex((line) => line.includes("import('./main')"));
    expect(assign).toBeGreaterThanOrEqual(0);
    expect(dynamic).toBeGreaterThan(assign);
  });

  it('既存の NODE_ENV を上書きしない（dev 起動で React の警告を戻せる）', () => {
    expect(source).toMatch(/process\.env\.NODE_ENV\s*\?\?=/);
  });

  it('自分で NODE_ENV を立てたことを目印に残す（子プロセスへ漏らさないため）', () => {
    // `utils/child-env.ts` の `childProcessEnv()` がこの目印を見て NODE_ENV を落とす。
    // 立てる前の値を見る必要があるので、代入は `??=` より**前**になければならない。
    const marker = code.findIndex((line) => line.includes('CODIVA_NODE_ENV_INJECTED'));
    const assign = code.findIndex((line) => /process\.env\.NODE_ENV\s*\?\?=/.test(line));
    expect(marker).toBeGreaterThanOrEqual(0);
    expect(assign).toBeGreaterThan(marker);
  });

  it('シムは main を動的 import するだけに保つ（副作用を足さない）', () => {
    // 目印の代入 / NODE_ENV の代入 / ESM マーカーの空 export / 動的 import の 4 文だけ。
    expect(code).toHaveLength(4);
  });
});
