import { describe, expect, it } from 'vitest';
import { spawnLogin } from '@/utils/agent-login';

/**
 * ログインプロセスの I/O。実 `codex`/`claude` を起こさずに検証できる部分:
 * 実在するコマンドの stdout を行で流せること、未導入コマンドで**ハングせず終わる**こと。
 */
describe('spawnLogin', () => {
  it('streams stdout as lines and reports the exit code', async () => {
    // `node -e` で 2 行出して 0 で終わる（provider 非依存の line-stream を確認）。
    const proc = spawnLogin(process.execPath, [
      '-e',
      "process.stdout.write('open https://auth.example/x\\ndone\\n')",
    ]);
    const lines: string[] = [];
    for await (const line of proc) {
      lines.push(line);
    }
    expect(lines).toContain('open https://auth.example/x');
    expect(lines).toContain('done');
    expect(proc.result().code).toBe(0);
  });

  it('keeps stdout and stderr on separate lines when chunks interleave', async () => {
    // 改行で終わっていない stdout の途中チャンク → stderr の 1 行、の順で流す。
    // 行バッファを共有していると `Open https://auth.example/device` に
    // `warning: ...` が連結され、URL の抽出が壊れる（issue #113）。
    const proc = spawnLogin(process.execPath, [
      '-e',
      [
        "process.stdout.write('Open https://auth.example/device');",
        'setTimeout(() => {',
        "  process.stderr.write('warning: retrying\\n');",
        '  setTimeout(() => process.exit(0), 20);',
        '}, 20);',
      ].join(''),
    ]);
    const lines: string[] = [];
    for await (const line of proc) {
      lines.push(line);
    }
    expect(lines).toContain('Open https://auth.example/device');
    expect(lines).toContain('warning: retrying');
    expect(lines.some((l) => l.includes('device') && l.includes('warning'))).toBe(false);
  });

  it('flushes each stream trailing partial line independently', async () => {
    const proc = spawnLogin(process.execPath, [
      '-e',
      "process.stdout.write('out-tail');process.stderr.write('err-tail');",
    ]);
    const lines: string[] = [];
    for await (const line of proc) {
      lines.push(line);
    }
    expect([...lines].sort()).toEqual(['err-tail', 'out-tail']);
    expect(proc.result().code).toBe(0);
  });

  it('ends (does not hang) and reports failure when the binary is missing', async () => {
    const proc = spawnLogin('/nonexistent/login-binary-for-tests', ['login']);
    const lines: string[] = [];
    for await (const line of proc) {
      lines.push(line);
    }
    expect(lines).toEqual([]);
    // 終了コードは非 0（ENOENT）。少なくとも null 以外に丸める（`code ?? 1`）。
    expect(proc.result().code).not.toBe(0);
  });

  it('cancel() on an exited process does not throw', async () => {
    const proc = spawnLogin(process.execPath, ['-e', 'process.exit(0)']);
    for await (const _ of proc) {
      // drain
    }
    expect(() => {
      proc.cancel();
    }).not.toThrow();
  });
});
