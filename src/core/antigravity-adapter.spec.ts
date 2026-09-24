import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '@/core/agent-events';
import type { AgentRun, AgentRunRequest } from '@/core/agent-ports';
import {
  ANTIGRAVITY_CAPABILITIES,
  type AntigravityProcess,
  type AntigravitySpawnRequest,
  createAntigravityAdapter,
} from '@/core/antigravity-adapter';
import { AsyncQueue } from '@/core/async-queue';

/**
 * アダプタの配線を実プロセス無しで駆動する。**フェイクは「行を流す + 送られた行を
 * 覚える」だけ**にして、ターンの直列化・プロセスの起こし直し・引き継ぎの解除点と
 * いった `antigravity-adapter.ts` 側の判断だけを見る。
 */
function makeProc() {
  const buffer: unknown[] = [];
  let wake: (() => void) | undefined;
  let closed = false;
  const proc = {
    sent: [] as unknown[],
    killed: false,
    ended: false,
    code: null as number | null,
    stderr: '',
    /** CLI が 1 行流した。 */
    emit(value: unknown) {
      buffer.push(value);
      wake?.();
      wake = undefined;
    },
    /** プロセスが終わった。 */
    close(code: number | null, stderr = '') {
      closed = true;
      proc.code = code;
      proc.stderr = stderr;
      wake?.();
      wake = undefined;
    },
    send(message: unknown) {
      proc.sent.push(message);
    },
    endInput() {
      proc.ended = true;
    },
    alive: () => !closed,
    kill() {
      proc.killed = true;
      if (!closed) {
        proc.close(null);
      }
    },
    result: () => ({ code: proc.code, stderr: proc.stderr }),
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<unknown>> {
          for (;;) {
            if (buffer.length > 0) {
              return { done: false, value: buffer.shift() };
            }
            if (closed) {
              return { done: true, value: undefined };
            }
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
          }
        },
      };
    },
  };
  return proc satisfies AntigravityProcess & Record<string, unknown>;
}

type Proc = ReturnType<typeof makeProc>;

function harness(options?: Partial<AgentRunRequest['options']> & { resume?: string }) {
  const spawns: AntigravitySpawnRequest[] = [];
  const procs: Proc[] = [];
  const prompt = new AsyncQueue<string>();
  const abortController = new AbortController();
  let handoffDelivered = 0;

  const adapter = createAntigravityAdapter({
    spawn: (request) => {
      spawns.push(request);
      const proc = makeProc();
      procs.push(proc);
      return proc;
    },
  });

  const run: AgentRun = adapter.open({
    cwd: '/tmp/repo',
    prompt,
    resume: options?.resume,
    options: {
      systemPrompt: options?.systemPrompt,
      handoff: options?.handoff,
      model: options?.model,
      effort: options?.effort,
      permissionMode: options?.permissionMode,
    },
    requestPermission: async () => ({ behavior: 'deny' as const }),
    onHandoffDelivered: () => {
      handoffDelivered += 1;
    },
    abortController,
  });

  const events: AgentEvent[] = [];
  const iterator = run[Symbol.asyncIterator]();
  // バックグラウンドで回し続け、テストは `settle()` で追いつく。
  const pump = (async () => {
    for (;;) {
      const next = await iterator.next();
      if (next.done) {
        return;
      }
      events.push(next.value);
    }
  })();

  /** マイクロタスクを何周かして、アダプタが進めるところまで進める。 */
  const settle = async () => {
    for (let i = 0; i < 40; i += 1) {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  };

  return {
    adapter,
    run,
    spawns,
    procs,
    prompt,
    events,
    abortController,
    settle,
    pump,
    handoffDelivered: () => handoffDelivered,
  };
}

const init = (id: string, model?: string) => ({
  event: 'init',
  conversation_id: id,
  init: { cwd: '/tmp/repo', tools: ['run_command'], model },
});
const stepDone = (index: number, text: string) => ({
  event: 'step_update',
  step_update: { step_index: index, state: 'DONE', step_type: 'agent_response', text_delta: text },
});
const success = (id: string, response = 'ok') => ({
  event: 'result',
  result: { conversation_id: id, status: 'SUCCESS', response },
});

describe('ANTIGRAVITY_CAPABILITIES', () => {
  it('許可要求を上げられないことを表明する（ダイアログを偽装しない）', () => {
    expect(ANTIGRAVITY_CAPABILITIES.permissions).toBe(false);
  });

  it('カタログを出せないので /model も出さない', () => {
    expect(ANTIGRAVITY_CAPABILITIES.modelCatalog).toBe(false);
    expect(ANTIGRAVITY_CAPABILITIES.setModel).toBe(false);
  });

  it('resume と interrupt はできる', () => {
    expect(ANTIGRAVITY_CAPABILITIES.resume).toBe(true);
    expect(ANTIGRAVITY_CAPABILITIES.interrupt).toBe(true);
  });

  it('確かめていないものは false のまま（早すぎる完了より永久 running が危険）', () => {
    expect(ANTIGRAVITY_CAPABILITIES.subagents).toBe(false);
    expect(ANTIGRAVITY_CAPABILITIES.cost).toBe(false);
    expect(ANTIGRAVITY_CAPABILITIES.usage).toBe(false);
  });
});

describe('createAntigravityAdapter', () => {
  it('固有名詞とログインコマンドを名乗る', () => {
    const adapter = createAntigravityAdapter({ spawn: () => makeProc() });
    expect(adapter.id).toBe('antigravity');
    expect(adapter.displayName).toBe('Antigravity');
    expect(adapter.loginCommand).toBe('agy');
  });

  it('TUI 内ログインを表現できないので login を持たない', () => {
    const adapter = createAntigravityAdapter({ spawn: () => makeProc() });
    expect(adapter.login).toBeUndefined();
  });

  it('指示を NDJSON の user イベントとして 1 行送る', async () => {
    const h = harness();
    h.prompt.push('do the thing');
    await h.settle();
    expect(h.spawns).toHaveLength(1);
    expect(h.procs[0]?.sent).toEqual([{ event: 'user', message: { content: 'do the thing' } }]);
  });

  it('最初のターンにだけ systemPrompt を前置する', async () => {
    const h = harness({ systemPrompt: 'SYSTEM' });
    h.prompt.push('first');
    h.procs.length === 0 && (await h.settle());
    h.procs[0]?.emit(init('c1'));
    h.procs[0]?.emit(success('c1'));
    await h.settle();
    h.prompt.push('second');
    await h.settle();

    const sent = h.procs[0]?.sent as { message: { content: string } }[];
    expect(sent[0]?.message.content).toBe('SYSTEM\n\n---\n\nfirst');
    // 会話 id が付いたので 2 ターン目には前置しない。
    expect(sent[1]?.message.content).toBe('second');
  });

  it('会話 id を貰う前に落ちたら次のターンで systemPrompt を渡し直す', async () => {
    const h = harness({ systemPrompt: 'SYSTEM' });
    h.prompt.push('first');
    await h.settle();
    // `init` を貰えないままプロセスが死ぬ（未ログイン等）。
    h.procs[0]?.close(1, 'authentication failed or timed out');
    await h.settle();
    h.prompt.push('second');
    await h.settle();

    expect(h.spawns).toHaveLength(2);
    const sent = h.procs[1]?.sent as { message: { content: string } }[];
    expect(sent[0]?.message.content).toBe('SYSTEM\n\n---\n\nsecond');
  });

  it('resume id を起動フラグとして渡す', async () => {
    const h = harness({ resume: 'prior-conversation' });
    h.prompt.push('go');
    await h.settle();
    expect(h.spawns[0]?.resume).toBe('prior-conversation');
  });

  it('1 プロセスを複数ターンで使い回す', async () => {
    const h = harness();
    h.prompt.push('one');
    await h.settle();
    h.procs[0]?.emit(init('c1'));
    h.procs[0]?.emit(success('c1'));
    await h.settle();
    h.prompt.push('two');
    await h.settle();

    expect(h.spawns).toHaveLength(1);
    expect(h.procs[0]?.sent).toHaveLength(2);
  });

  it('プロセスが死んだら次のターンで会話 id 付きで起こし直す', async () => {
    const h = harness();
    h.prompt.push('one');
    await h.settle();
    h.procs[0]?.emit(init('c1'));
    h.procs[0]?.emit(success('c1'));
    await h.settle();
    h.procs[0]?.close(0);
    await h.settle();

    h.prompt.push('two');
    await h.settle();
    expect(h.spawns).toHaveLength(2);
    expect(h.spawns[1]?.resume).toBe('c1');
  });

  it('決着イベント無しで死んだら resumable な connection に倒す', async () => {
    const h = harness();
    h.prompt.push('one');
    await h.settle();
    h.procs[0]?.emit(init('c1'));
    await h.settle();
    h.procs[0]?.close(2, 'boom');
    await h.settle();

    const stopped = h.events.filter((e) => e.kind === 'turn_stopped');
    expect(stopped).toHaveLength(1);
    expect(stopped[0]).toMatchObject({ cause: 'connection', detail: 'boom' });
  });

  it('会話 id も分からないまま落ちたら分類結果をそのまま使う', async () => {
    const h = harness();
    h.prompt.push('one');
    await h.settle();
    h.procs[0]?.close(1, 'authentication failed or timed out');
    await h.settle();

    const stopped = h.events.filter((e) => e.kind === 'turn_stopped');
    expect(stopped[0]).toMatchObject({ cause: 'auth' });
  });

  it('終了コード 0 で静かに終わったら完了扱いにする', async () => {
    const h = harness();
    h.prompt.push('one');
    await h.settle();
    h.procs[0]?.close(0);
    await h.settle();

    expect(h.events.filter((e) => e.kind === 'turn_completed')).toHaveLength(1);
  });

  it('引き継ぎを最初の指示に前置し、ターンが始まって初めて落とす', async () => {
    const h = harness({ handoff: 'HANDOFF' });
    h.prompt.push('first');
    await h.settle();
    const sent = h.procs[0]?.sent as { message: { content: string } }[];
    expect(sent[0]?.message.content).toContain('HANDOFF');
    expect(sent[0]?.message.content).toContain('first');
    // `init` だけでは落とさない（指示を読む前にも出るため）。
    h.procs[0]?.emit(init('c1'));
    await h.settle();
    expect(h.handoffDelivered()).toBe(0);

    h.procs[0]?.emit(stepDone(1, 'hi'));
    await h.settle();
    expect(h.handoffDelivered()).toBe(1);
  });

  it('ターンが始まる前に死んだら引き継ぎを使い切らない', async () => {
    const h = harness({ handoff: 'HANDOFF' });
    h.prompt.push('first');
    await h.settle();
    h.procs[0]?.close(1, 'authentication failed or timed out');
    await h.settle();
    expect(h.handoffDelivered()).toBe(0);

    // ログインし直して送り直すと、引き継ぎはまだ載っている。
    h.prompt.push('second');
    await h.settle();
    const sent = h.procs[1]?.sent as { message: { content: string } }[];
    expect(sent[0]?.message.content).toContain('HANDOFF');
  });

  it('interrupt はプロセスを殺し、失敗イベントを出さない', async () => {
    const h = harness();
    h.prompt.push('one');
    await h.settle();
    h.procs[0]?.emit(init('c1'));
    await h.settle();

    await h.run.interrupt?.();
    await h.settle();

    expect(h.procs[0]?.killed).toBe(true);
    expect(h.events.filter((e) => e.kind === 'turn_stopped')).toHaveLength(0);
    expect(h.events.filter((e) => e.kind === 'turn_completed')).toHaveLength(0);
  });

  it('中断したあとの指示は会話 id 付きの新しいプロセスへ行く', async () => {
    const h = harness();
    h.prompt.push('one');
    await h.settle();
    h.procs[0]?.emit(init('c1'));
    await h.settle();
    await h.run.interrupt?.();
    await h.settle();

    h.prompt.push('two');
    await h.settle();
    expect(h.spawns).toHaveLength(2);
    expect(h.spawns[1]?.resume).toBe('c1');
  });

  it('abort でプロセスを殺す', async () => {
    const h = harness();
    h.prompt.push('one');
    await h.settle();
    h.abortController.abort();
    await h.settle();
    expect(h.procs[0]?.killed).toBe(true);
  });

  it('会話 id と解決済みモデルを session_started として流す', async () => {
    const h = harness();
    h.prompt.push('one');
    await h.settle();
    h.procs[0]?.emit(init('c1', 'gemini-3-pro'));
    await h.settle();

    const started = h.events.find((e) => e.kind === 'session_started');
    expect(started).toMatchObject({ sessionId: 'c1', model: 'gemini-3-pro' });
  });

  it('起動オプションをそのまま spawn へ渡す', async () => {
    const h = harness({ model: 'gemini-3-pro', effort: 'high', permissionMode: 'plan' });
    h.prompt.push('one');
    await h.settle();
    expect(h.spawns[0]).toMatchObject({
      cwd: '/tmp/repo',
      model: 'gemini-3-pro',
      effort: 'high',
      permissionMode: 'plan',
    });
  });
});
