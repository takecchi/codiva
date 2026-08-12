import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AsyncQueue } from '@/core/async-queue';
import type { GrokProcess, GrokSpawnRequest } from '@/core/grok-adapter';
import { detectGrokAvailability, fetchGrokModelCatalog, grokAgentArgs, spawnGrok } from './grok';

const MISSING_BINARY = '/nonexistent/grok-binary-for-tests';

describe('grokAgentArgs', () => {
  it.each([
    [{ cwd: '/repo' }, ['agent', '--no-leader', 'stdio']],
    [
      { cwd: '/repo', effort: 'high' as const },
      ['agent', '--reasoning-effort', 'high', '--no-leader', 'stdio'],
    ],
  ])('%o → %o', (request, expected) => {
    expect(grokAgentArgs(request as GrokSpawnRequest)).toEqual(expected);
  });

  it('フラグはサブコマンドより前に置く（後ろだと CLI が受け付けない）', () => {
    const args = grokAgentArgs({ cwd: '/repo', effort: 'low' });
    expect(args.indexOf('--reasoning-effort')).toBeLessThan(args.indexOf('stdio'));
    expect(args.at(-1)).toBe('stdio');
  });
});

/**
 * `spawnGrok` の実プロセス経路のうち、**実 `grok` が要らない**部分。
 * 未導入はユーザー環境で普通に起きるので「ハングしない・理由が残る」ことを固定する。
 */
describe('spawnGrok', () => {
  const request: GrokSpawnRequest = { cwd: process.cwd() };

  it('バイナリが無ければストリームを閉じて理由を残す', async () => {
    const proc = spawnGrok(request, MISSING_BINARY);
    const messages: unknown[] = [];
    for await (const message of proc) {
      messages.push(message);
    }
    expect(messages).toEqual([]);
    expect(proc.result().stderr).toContain('ENOENT');
  });

  it('起動していないプロセスへの send / kill で落ちない', async () => {
    const proc = spawnGrok(request, MISSING_BINARY);
    for await (const _message of proc) {
      // drain
    }
    expect(() => {
      proc.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
      proc.kill();
    }).not.toThrow();
  });
});

describe('detectGrokAvailability', () => {
  const saved = { key: process.env.XAI_API_KEY, home: process.env.GROK_HOME };

  afterEach(() => {
    process.env.XAI_API_KEY = saved.key;
    process.env.GROK_HOME = saved.home;
    if (saved.key === undefined) {
      delete process.env.XAI_API_KEY;
    }
    if (saved.home === undefined) {
      delete process.env.GROK_HOME;
    }
  });

  it('バイナリが無ければ未導入（ログインも false）', async () => {
    const a = await detectGrokAvailability(MISSING_BINARY);
    expect(a).toEqual({ installed: false, loggedIn: false });
  });

  it('XAI_API_KEY があればログイン済みとみなす', async () => {
    process.env.XAI_API_KEY = 'xai-something';
    // `--version` が 0 で終わる何かなら導入判定は通る（実 `grok` は要らない）。
    expect(await detectGrokAvailability(process.execPath)).toEqual({
      installed: true,
      loggedIn: true,
    });
  });

  it('auth.json があればログイン済み、無ければ未ログイン（GROK_HOME 尊重）', async () => {
    delete process.env.XAI_API_KEY;
    const home = await mkdtemp(join(tmpdir(), 'codiva-grok-'));
    process.env.GROK_HOME = home;
    expect(await detectGrokAvailability(process.execPath)).toEqual({
      installed: true,
      loggedIn: false,
    });
    await writeFile(join(home, 'auth.json'), '{}');
    expect(await detectGrokAvailability(process.execPath)).toEqual({
      installed: true,
      loggedIn: true,
    });
  });
});

/** `initialize` の応答だけを返すフェイク（セッションは作らない）。 */
function fakeAgent(result: unknown): {
  spawnFn: (request: GrokSpawnRequest, command?: string) => GrokProcess;
  killed: () => boolean;
  sent: unknown[];
} {
  const out = new AsyncQueue<unknown>();
  const sent: unknown[] = [];
  let killed = false;
  return {
    sent,
    killed: () => killed,
    spawnFn: () => ({
      [Symbol.asyncIterator]: () => out[Symbol.asyncIterator](),
      send: (message: unknown) => {
        sent.push(message);
        out.push({ jsonrpc: '2.0', id: 1, result });
      },
      kill: () => {
        killed = true;
        out.close();
      },
      result: () => ({ code: 0, stderr: '' }),
    }),
  };
}

describe('fetchGrokModelCatalog', () => {
  it('initialize の modelState をカタログに変換し、プロセスを畳む', async () => {
    const agent = fakeAgent({
      _meta: {
        modelState: {
          currentModelId: 'grok-4.5',
          availableModels: [
            { modelId: 'grok-4.5', name: 'Grok 4.5', description: 'frontier' },
            { modelId: 'grok-code-fast-2', name: 'Grok Code Fast 2' },
          ],
        },
      },
    });
    const options = await fetchGrokModelCatalog({ cwd: '/repo', spawnFn: agent.spawnFn });
    expect(options.map((o) => o.value)).toEqual(['default', 'grok-4.5', 'grok-code-fast-2']);
    expect(options[1]).toMatchObject({ resolvedModel: 'grok-4.5', displayName: 'Grok 4.5' });
    // セッションは作らない（推論を走らせない）＝ 送るのは initialize だけ。
    expect(agent.sent).toHaveLength(1);
    expect(agent.sent[0]).toMatchObject({ method: 'initialize' });
    expect(agent.killed()).toBe(true);
  });

  it('モデル状態が読めなければ空配列（呼び出し側がフォールバックする）', async () => {
    const agent = fakeAgent({ _meta: {} });
    expect(await fetchGrokModelCatalog({ spawnFn: agent.spawnFn })).toEqual([]);
  });

  it('中断されたら空配列で終わる（起動できない環境でも固まらない）', async () => {
    const abort = new AbortController();
    const stuck: GrokProcess = {
      [Symbol.asyncIterator]: () => new AsyncQueue<unknown>()[Symbol.asyncIterator](),
      send: () => {},
      kill: () => {},
      result: () => ({ code: null, stderr: '' }),
    };
    const promise = fetchGrokModelCatalog({ spawnFn: () => stuck, signal: abort.signal });
    abort.abort();
    expect(await promise).toEqual([]);
  });

  it('起動そのものが投げても空配列を返す', async () => {
    const options = await fetchGrokModelCatalog({
      spawnFn: () => {
        throw new Error('spawn failed');
      },
    });
    expect(options).toEqual([]);
  });
});
