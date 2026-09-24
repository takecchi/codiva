import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AntigravitySpawnRequest, PermissionMode } from '@/core';
import {
  antigravityArgs,
  antigravityModeArgs,
  detectAntigravityAvailability,
} from '@/utils/antigravity';

/**
 * `agy` の引数組み立てと導入・ログイン検出。**実 CLI は要らない** — 検出は
 * 実測した振る舞い（`--version` は 0 / `models` は未サインインで 1 + 特定の文言）を
 * 再現する使い捨てのスクリプトで駆動する。
 */
const BASE: AntigravitySpawnRequest = { cwd: '/tmp/wt' };

const req = (over: Partial<AntigravitySpawnRequest> = {}): AntigravitySpawnRequest => ({
  ...BASE,
  ...over,
});

/** 全ケース共通の前置き。 */
const HEAD = ['--input-format=stream-json', '--output-format=stream-json', '--print-timeout=0'];

describe('antigravityArgs', () => {
  it('stream-json の入出力を必ず指定する', () => {
    // 実測: `--print` を渡すと次のフラグをプロンプトとして食うので渡さない。
    const args = antigravityArgs(req());
    expect(args.slice(0, 3)).toEqual(HEAD);
    expect(args).not.toContain('--print');
  });

  it('値を取るフラグはすべて `--flag=value` 形にする', () => {
    const args = antigravityArgs(req({ model: 'gemini-3-pro', effort: 'low', resume: 'conv-1' }));
    for (const arg of args) {
      expect(arg.startsWith('--')).toBe(true);
    }
    expect(args).toContain('--model=gemini-3-pro');
    expect(args).toContain('--effort=low');
    expect(args).toContain('--conversation=conv-1');
  });

  it('未指定のものはフラグごと出さない', () => {
    const args = antigravityArgs(req());
    expect(args.some((a) => a.startsWith('--model='))).toBe(false);
    expect(args.some((a) => a.startsWith('--effort='))).toBe(false);
    expect(args.some((a) => a.startsWith('--conversation='))).toBe(false);
  });

  // codiva の effort は 5 段、`agy` は 3 段しか受けない。
  it.each([
    ['low', '--effort=low'],
    ['medium', '--effort=medium'],
    ['high', '--effort=high'],
    ['xhigh', '--effort=high'],
    ['max', '--effort=high'],
  ] as const)('effort %s → %s', (effort, expected) => {
    expect(antigravityArgs(req({ effort }))).toContain(expected);
  });
});

describe('antigravityModeArgs', () => {
  it('既定では全許可フラグを使わない（issue #140）', () => {
    for (const mode of [undefined, 'default', 'acceptEdits', 'auto', 'dontAsk'] as const) {
      const args = antigravityModeArgs(mode as PermissionMode | undefined);
      expect(args).not.toContain('--dangerously-skip-permissions');
      expect(args).toEqual(['--mode=accept-edits']);
    }
  });

  it('plan モードは agy の plan へ写す', () => {
    expect(antigravityModeArgs('plan')).toEqual(['--mode=plan']);
  });

  it('bypassPermissions を明示したときだけ全許可にする', () => {
    expect(antigravityModeArgs('bypassPermissions')).toEqual(['--dangerously-skip-permissions']);
  });
});

describe('detectAntigravityAvailability', () => {
  let dir: string;
  const fake = async (body: string): Promise<string> => {
    const path = join(dir, 'agy');
    await writeFile(path, `#!/bin/sh\n${body}\n`, 'utf8');
    await chmod(path, 0o755);
    return path;
  };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'codiva-agy-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('バイナリが無ければ未導入（かつ未ログイン）', async () => {
    const a = await detectAntigravityAvailability(join(dir, 'does-not-exist'));
    expect(a).toEqual({ installed: false, loggedIn: false });
  });

  it('models が通ればログイン済み', async () => {
    const path = await fake('exit 0');
    expect(await detectAntigravityAvailability(path)).toEqual({
      installed: true,
      loggedIn: true,
    });
  });

  it('「サインインしろ」と言われたときだけ未ログインと断定する', async () => {
    // 実測の文言（agy 1.2.10, exit 1）。
    const path = await fake(`
case "$1" in
  --version) echo 1.2.10; exit 0;;
  models) echo 'Error: Please sign in to view available models.' >&2; exit 1;;
esac`);
    expect(await detectAntigravityAvailability(path)).toEqual({
      installed: true,
      loggedIn: false,
    });
  });

  it('それ以外の失敗は unknown に倒す（オフラインで未ログイン扱いにしない）', async () => {
    const path = await fake(`
case "$1" in
  --version) echo 1.2.10; exit 0;;
  models) echo 'Error: dial tcp: lookup googleapis.com: no such host' >&2; exit 1;;
esac`);
    expect(await detectAntigravityAvailability(path)).toEqual({
      installed: true,
      loggedIn: 'unknown',
    });
  });
});
