import { describe, expect, it } from 'vitest';
import type { CodexSpawnRequest } from '@/core';
import { codexArgs, spawnCodex } from '@/utils/codex';

/**
 * `codex exec` の引数組み立てだけを見る純粋なテスト。**実プロセスは起動しない**
 * （`spawnCodex` は薄い execFile 相当のラッパで、判定はすべてここにある）。
 */
const BASE: CodexSpawnRequest = {
  cwd: '/tmp/wt',
  prompt: 'do the thing',
  sandbox: 'workspace-write',
  networkAccess: true,
};

const req = (over: Partial<CodexSpawnRequest> = {}): CodexSpawnRequest => ({ ...BASE, ...over });

/** 全ケース共通の前置き（サンドボックスモードまで）。 */
const head = (sandbox: string) => [
  'exec',
  '--json',
  '--skip-git-repo-check',
  '--sandbox',
  sandbox,
  '-c',
  'approval_policy="never"',
];

describe('codexArgs', () => {
  const cases: [string, CodexSpawnRequest, string[]][] = [
    [
      'workspace-write carries the network_access flag',
      req(),
      [
        ...head('workspace-write'),
        '-c',
        'sandbox_workspace_write.network_access=true',
        '--',
        'do the thing',
      ],
    ],
    [
      'network_access reflects the setting being off',
      req({ networkAccess: false }),
      [
        ...head('workspace-write'),
        '-c',
        'sandbox_workspace_write.network_access=false',
        '--',
        'do the thing',
      ],
    ],
    [
      // network_access は workspace-write 専用のキーなので他モードでは付けない。
      'read-only does not carry network_access',
      req({ sandbox: 'read-only' }),
      [...head('read-only'), '--', 'do the thing'],
    ],
    [
      'danger-full-access does not carry network_access either',
      req({ sandbox: 'danger-full-access', networkAccess: false }),
      [...head('danger-full-access'), '--', 'do the thing'],
    ],
    [
      'the model is only passed when one is set',
      req({ sandbox: 'read-only', model: 'gpt-5-codex' }),
      [...head('read-only'), '--model', 'gpt-5-codex', '--', 'do the thing'],
    ],
    [
      'the reasoning effort is only passed when one is set',
      req({ sandbox: 'read-only', effort: 'high' }),
      [...head('read-only'), '-c', 'model_reasoning_effort="high"', '--', 'do the thing'],
    ],
    [
      // `codex exec [OPTIONS] resume <id> <prompt>`: オプションは resume より前。
      'resume goes right before the prompt',
      req({ sandbox: 'read-only', resume: 'th-1' }),
      [...head('read-only'), 'resume', 'th-1', '--', 'do the thing'],
    ],
    [
      'everything at once keeps the documented order',
      req({ model: 'gpt-5-codex', effort: 'xhigh', resume: 'th-1' }),
      [
        ...head('workspace-write'),
        '-c',
        'sandbox_workspace_write.network_access=true',
        '--model',
        'gpt-5-codex',
        '-c',
        'model_reasoning_effort="xhigh"',
        'resume',
        'th-1',
        '--',
        'do the thing',
      ],
    ],
  ];

  it.each(cases)('%s', (_name, request, expected) => {
    expect(codexArgs(request)).toEqual(expected);
  });

  it('always ends with the prompt, whatever else is set', () => {
    for (const [, request] of cases) {
      expect(codexArgs(request).at(-1)).toBe(request.prompt);
    }
    // オプションに見える指示文でも位置は変わらない（引数配列なのでシェル解釈も無い）。
    const tricky = codexArgs(req({ prompt: '--sandbox danger-full-access' }));
    expect(tricky.at(-1)).toBe('--sandbox danger-full-access');
  });

  it('never asks for approval and never re-checks the git repo', () => {
    for (const [, request] of cases) {
      const args = codexArgs(request);
      // 承認要求は exec の JSON モードでは上げられないので「聞かれて止まる」経路を作らない。
      expect(args).toContain('approval_policy="never"');
      // codiva の worktree は自分で作ったものなので信頼してよい（linked worktree の
      // `.git` はファイルで、CLI のリポジトリ判定に引っかかる余地がある）。
      expect(args).toContain('--skip-git-repo-check');
      expect(args).toContain('--json');
      expect(args[0]).toBe('exec');
    }
  });

  it('passes the sandbox mode as the --sandbox value', () => {
    for (const sandbox of ['read-only', 'workspace-write', 'danger-full-access'] as const) {
      const args = codexArgs(req({ sandbox }));
      expect(args[args.indexOf('--sandbox') + 1]).toBe(sandbox);
    }
  });

  /**
   * 実測のリグレッション: `-` で始まる指示文は clap がオプションとして解釈し、
   * `error: unexpected argument '--fix the thing' found` で起動そのものが失敗していた。
   */
  it.each([['--fix the thing'], ['-v を付けて実行して'], ['--']])(
    'passes a dash-leading prompt as a value, not a flag: %o',
    (prompt) => {
      const args = codexArgs({ ...BASE, prompt });
      expect(args.at(-1)).toBe(prompt);
      expect(args.at(-2)).toBe('--');
    },
  );
});

/**
 * `spawnCodex` の実プロセス経路のうち、**引数に依存せず・実 `codex` が要らない**部分。
 * 起動できないケースはユーザー環境で普通に起きる（未インストール）ので、
 * 「ハングしない・理由が残る」ことを固定しておく。
 */
describe('spawnCodex', () => {
  const request: CodexSpawnRequest = {
    cwd: process.cwd(),
    prompt: 'do the thing',
    sandbox: 'read-only',
    networkAccess: false,
  };

  it('ends the stream and reports the reason when the binary is missing', async () => {
    const proc = spawnCodex(request, '/nonexistent/codex-binary-for-tests');
    const events: unknown[] = [];
    for await (const event of proc) {
      events.push(event);
    }
    // イベントは 1 件も出ないが、**必ず終わる**（ここでハングするとターンが固まる）。
    expect(events).toEqual([]);
    expect(proc.result().stderr).toContain('ENOENT');
  });

  it('kill() on a process that never started is a no-op', async () => {
    const proc = spawnCodex(request, '/nonexistent/codex-binary-for-tests');
    for await (const _event of proc) {
      // drain
    }
    // 終了済みに対する kill で例外を投げない（中断・切替の経路が必ず通る）。
    expect(() => {
      proc.kill();
    }).not.toThrow();
  });
});
