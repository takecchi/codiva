import { describe, expect, it, vi } from 'vitest';
import {
  clipValue,
  evaluatePermission,
  type PermissionContext,
  type PermissionEvaluator,
  type PermissionVerdict,
  redactToolInput,
  toPermissionContext,
} from './permission-evaluator';

/** 定数の評価器（`evaluate` が何回呼ばれたかも数える）。 */
function fakeEvaluator(verdict: PermissionVerdict | (() => Promise<PermissionVerdict>)) {
  const calls: PermissionContext[] = [];
  const evaluator: PermissionEvaluator = {
    evaluate: async (context) => {
      calls.push(context);
      return typeof verdict === 'function' ? verdict() : verdict;
    },
  };
  return { evaluator, calls };
}

const TOOL = { toolName: 'Bash', input: { command: 'npm test' }, kind: 'tool' } as const;

describe('redactToolInput', () => {
  it.each<[string, Record<string, unknown>]>([
    ['plain scalars survive', { command: 'npm test', count: 3, ok: true }],
    ['null survives', { value: null }],
  ])('%s', (_label, input) => {
    expect(redactToolInput(input)).toEqual(input);
  });

  it('drops secret-looking keys entirely', () => {
    const out = redactToolInput({
      command: 'curl x',
      GITHUB_TOKEN: 'ghp_real',
      apiKey: 'sk-real',
      api_key: 'sk-real',
      password: 'hunter2',
      my_secret: 'x',
      credentials: 'x',
    });
    expect(out).toEqual({ command: 'curl x' });
    // 値だけでなくキーごと消える（キー名から中身が推測されうるため）。
    expect(JSON.stringify(out)).not.toContain('ghp_real');
  });

  it('replaces bulk content with a size marker instead of sending it', () => {
    const out = redactToolInput({
      file_path: '/repo/src/a.ts',
      content: 'x'.repeat(5000),
      old_string: 'secret business logic',
      edits: [1, 2, 3],
    });
    expect(out).toEqual({
      file_path: '/repo/src/a.ts',
      content: '<5000 chars>',
      old_string: '<21 chars>',
      edits: '<array(3)>',
    });
  });

  it('clips long strings and summarizes nested values', () => {
    const out = redactToolInput({ command: 'a'.repeat(1000), opts: { a: 1, b: 2 } });
    expect(out.command).toBe(`${'a'.repeat(400)}…`);
    expect(out.opts).toBe('<object(2)>');
  });

  it('caps the number of fields so an unknown tool cannot flood the request', () => {
    const input: Record<string, unknown> = {};
    for (let i = 0; i < 40; i += 1) {
      input[`k${i}`] = i;
    }
    expect(Object.keys(redactToolInput(input))).toHaveLength(12);
  });

  it('skips values JSON cannot carry without spending a field slot', () => {
    const out = redactToolInput({ fn: () => 1, gone: undefined, command: 'ls' });
    expect(out).toEqual({ command: 'ls' });
  });
});

describe('clipValue', () => {
  it.each([
    ['short text is untouched', 'abc', 5, 'abc'],
    ['exact length is untouched', 'abcde', 5, 'abcde'],
    ['longer text gets an ellipsis', 'abcdef', 5, 'abcde…'],
  ])('%s', (_label, text, max, expected) => {
    expect(clipValue(text, max)).toBe(expected);
  });
});

describe('toPermissionContext', () => {
  it('carries the normalized tool kind and redacted input', () => {
    expect(
      toPermissionContext(
        { ...TOOL, tool: 'shell' },
        { instruction: '  テストを通して  ', agent: 'codex' },
      ),
    ).toEqual({
      toolName: 'Bash',
      tool: 'shell',
      kind: 'tool',
      input: { command: 'npm test' },
      instruction: 'テストを通して',
      agent: 'codex',
    });
  });

  // 種別を報告しない provider のぶんは `other` に倒す。ツール名から当てにいくと
  // provider 固有の知識が中立モジュールへ漏れる（規約: sdk-integration.md）。
  it('falls back to `other` when the adapter did not report a kind', () => {
    expect(toPermissionContext(TOOL).tool).toBe('other');
  });

  it('omits empty optional fields rather than sending blanks', () => {
    const ctx = toPermissionContext(TOOL, { instruction: '   ' });
    expect(ctx.instruction).toBeUndefined();
    expect(ctx.agent).toBeUndefined();
  });
});

describe('evaluatePermission', () => {
  const ctx = toPermissionContext({ ...TOOL, tool: 'shell' });

  it('allows only when the evaluator says allow', async () => {
    await expect(evaluatePermission(fakeEvaluator('allow').evaluator, ctx)).resolves.toBe('allow');
    await expect(evaluatePermission(fakeEvaluator('ask').evaluator, ctx)).resolves.toBe('ask');
  });

  // MVP の方針: 判断モデルを最終決定者にしない。`deny` でも自動拒否せず人間へ上げる。
  it('promotes deny to ask (never auto-denies)', async () => {
    await expect(evaluatePermission(fakeEvaluator('deny').evaluator, ctx)).resolves.toBe('ask');
  });

  it('falls back to ask when the evaluator throws', async () => {
    const evaluator: PermissionEvaluator = {
      evaluate: () => Promise.reject(new Error('network down')),
    };
    await expect(evaluatePermission(evaluator, ctx)).resolves.toBe('ask');
  });

  it('falls back to ask when there is no evaluator at all', async () => {
    await expect(evaluatePermission(undefined, ctx)).resolves.toBe('ask');
  });

  it('falls back to ask on an unknown verdict', async () => {
    const evaluator = {
      evaluate: async () => 'maybe' as unknown as PermissionVerdict,
    } satisfies PermissionEvaluator;
    await expect(evaluatePermission(evaluator, ctx)).resolves.toBe('ask');
  });

  it('falls back to ask on timeout and signals the evaluator to stop', async () => {
    vi.useFakeTimers();
    try {
      let aborted = false;
      const evaluator: PermissionEvaluator = {
        evaluate: (_c, signal) =>
          new Promise<PermissionVerdict>(() => {
            signal?.addEventListener('abort', () => {
              aborted = true;
            });
          }),
      };
      const result = evaluatePermission(evaluator, ctx, { timeoutMs: 50 });
      await vi.advanceTimersByTimeAsync(60);
      await expect(result).resolves.toBe('ask');
      expect(aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  // 質問は**それ自体がユーザーへ聞く経路**。評価器に聞かせて自動 allow すると、
  // 空の回答で「承諾」を返して質問が黙って消える。
  it('never sends a question to the evaluator', async () => {
    const { evaluator, calls } = fakeEvaluator('allow');
    const question = toPermissionContext({
      toolName: 'AskUserQuestion',
      input: {},
      kind: 'question',
      tool: 'question',
    });
    await expect(evaluatePermission(evaluator, question)).resolves.toBe('ask');
    expect(calls).toHaveLength(0);
  });

  it('does not call the evaluator once the session is aborted', async () => {
    const { evaluator, calls } = fakeEvaluator('allow');
    const controller = new AbortController();
    controller.abort();
    await expect(evaluatePermission(evaluator, ctx, { signal: controller.signal })).resolves.toBe(
      'ask',
    );
    expect(calls).toHaveLength(0);
  });

  // 中断されたら評価器の答えを待たずに決着させる。待っているのは provider の
  // `canUseTool` なので、ここで伸びるとターンごと止まる。
  it('gives up with ask when the session aborts mid-flight', async () => {
    const controller = new AbortController();
    let aborted = false;
    const evaluator: PermissionEvaluator = {
      evaluate: (_c, signal) =>
        new Promise<PermissionVerdict>(() => {
          signal?.addEventListener('abort', () => {
            aborted = true;
          });
        }),
    };
    const result = evaluatePermission(evaluator, ctx, { signal: controller.signal });
    controller.abort();
    await expect(result).resolves.toBe('ask');
    expect(aborted).toBe(true);
  });
});
