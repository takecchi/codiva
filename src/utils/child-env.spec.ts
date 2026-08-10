import { readdirSync, readFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { childProcessEnv } from './child-env';

/** `src/` 以下の実装ソース（spec / fixtures は除く）を再帰的に読む。 */
function allSources(dir: string): { file: string; code: string }[] {
  const out: { file: string; code: string }[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== '__fixtures__') {
        out.push(...allSources(path));
      }
    } else if (/\.tsx?$/.test(entry.name) && !/\.spec\.tsx?$/.test(entry.name)) {
      out.push({ file: path, code: readFileSync(path, 'utf8') });
    }
  }
  return out;
}

describe('childProcessEnv', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it('codiva が立てた NODE_ENV を落とす（セッション内の npm が dev 依存を入れる）', () => {
    process.env.NODE_ENV = 'production';
    process.env.CODIVA_NODE_ENV_INJECTED = '1';
    const env = childProcessEnv();
    expect(env.NODE_ENV).toBeUndefined();
    expect(env.CODIVA_NODE_ENV_INJECTED).toBeUndefined();
    // 置き換え用（SDK の `Options.env` はマージしない）なので、他は全部残す。
    expect(env.PATH).toBe(process.env.PATH);
  });

  it('ユーザーが渡した NODE_ENV は残す', () => {
    process.env.NODE_ENV = 'development';
    process.env.CODIVA_NODE_ENV_INJECTED = '';
    expect(childProcessEnv().NODE_ENV).toBe('development');
  });

  it('process.env を書き換えない', () => {
    process.env.NODE_ENV = 'production';
    process.env.CODIVA_NODE_ENV_INJECTED = '1';
    childProcessEnv();
    expect(process.env.NODE_ENV).toBe('production');
  });
});

/**
 * 番人: 子プロセスを起こす utils は必ず `childProcessEnv()` を通す。
 *
 * 1 箇所でも素の `process.env` を継がせると、そこから下（エージェントのシェル・git フック）
 * で `NODE_ENV=production` が復活して `npm install` が devDependencies を落とす（issue #103）。
 * 見た目では気付けないので、ソースの形で固定する。
 */
describe('子プロセスの env（番人）', () => {
  const dir = fileURLToPath(new URL('.', import.meta.url));
  const sources = readdirSync(dir)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.spec.ts'))
    .map((f) => ({ file: f, code: readFileSync(new URL(f, import.meta.url), 'utf8') }));

  it('`node:child_process` を使う utils は childProcessEnv を通す', () => {
    const spawners = sources.filter(({ code }) => code.includes("from 'node:child_process'"));
    // 走査そのものが空振り（= 番人が何も見ていない）になっていないことを確かめる。
    expect(spawners.length).toBeGreaterThan(3);
    const offenders = spawners
      .filter(({ code }) => !code.includes('childProcessEnv'))
      .map(({ file }) => file);
    expect(offenders).toEqual([]);
  });

  it('SDK の `query` を値として import するのは claude-query.ts だけ', () => {
    // 素の `query` を使うと env が被らないので、入口を 1 本に絞る（型 import は対象外）。
    const src = fileURLToPath(new URL('..', import.meta.url));
    const offenders = allSources(src)
      .filter(({ file }) => !file.endsWith(`utils${sep}claude-query.ts`))
      .filter(({ code }) => /import \{[^}]*\bquery\b[^}]*\} from '@anthropic-ai\//.test(code))
      .map(({ file }) => file);
    expect(offenders).toEqual([]);
  });
});
