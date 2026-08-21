import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '@/core/agent-events';
import type { AgentRunOptions, AgentRunRequest, PermissionDecision } from '@/core/agent-ports';
import { AsyncQueue } from '@/core/async-queue';
import {
  createGrokAdapter,
  GROK_CAPABILITIES,
  type GrokProcess,
  type GrokSpawn,
  type GrokSpawnRequest,
} from '@/core/grok-adapter';
import type { PermissionRequest } from '@/core/types';

const tick = () => new Promise((r) => setTimeout(r, 0));

/** 条件が満たされるまで待つ（アダプタの非同期ループに順番を回す）。 */
async function waitFor(cond: () => boolean, label: string): Promise<void> {
  // 全体実行では 1 tick が詰まるので回数に余裕を持たせる（待ちが成立していれば
  // 早く抜けるだけで、遅くはならない）。
  for (let i = 0; i < 3000; i += 1) {
    if (cond()) {
      return;
    }
    await tick();
  }
  throw new Error(`timed out waiting for ${label}`);
}

interface RpcRequest {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
}

interface FakeProcess {
  proc: GrokProcess;
  /** クライアント（アダプタ）が送ってきた JSON-RPC。 */
  sent: RpcRequest[];
  /** stdout へ 1 通流す。 */
  emit(message: unknown): void;
  /** 直近の要求に応答する（method で探す）。 */
  reply(method: string, result: unknown): void;
  /** 直近の要求をエラーで返す。 */
  replyError(method: string, error: { code?: number; message: string; data?: unknown }): void;
  find(method: string): RpcRequest | undefined;
  /** stdout が尽きた（プロセスが死んだ）。 */
  end(): void;
  /** 終了コードと stderr を差し替える（クラッシュの再現）。 */
  setExit(exit: { code: number | null; stderr: string }): void;
  wasKilled(): boolean;
}

/** プロセスを起こさない `grok agent stdio`: stdout は自分で push するキュー。 */
function makeFakeProcess(): FakeProcess {
  const out = new AsyncQueue<unknown>();
  const sent: RpcRequest[] = [];
  let killed = false;
  let exit: { code: number | null; stderr: string } = { code: 0, stderr: '' };
  const find = (method: string): RpcRequest | undefined =>
    [...sent].reverse().find((m) => m.method === method);
  return {
    proc: {
      [Symbol.asyncIterator]: () => out[Symbol.asyncIterator](),
      send: (message: unknown) => sent.push(message as RpcRequest),
      kill: () => {
        killed = true;
        out.close();
      },
      result: () => exit,
    },
    sent,
    emit: (message: unknown) => out.push(message),
    reply: (method, result) => {
      const req = find(method);
      out.push({ jsonrpc: '2.0', id: req?.id, result });
    },
    replyError: (method, error) => {
      const req = find(method);
      out.push({ jsonrpc: '2.0', id: req?.id, error: { code: error.code ?? -32603, ...error } });
    },
    find,
    end: () => out.close(),
    setExit: (next) => {
      exit = next;
    },
    wasKilled: () => killed,
  };
}

function makeFakeGrok() {
  const requests: GrokSpawnRequest[] = [];
  const procs: FakeProcess[] = [];
  const spawn: GrokSpawn = (request) => {
    const fake = makeFakeProcess();
    requests.push(request);
    procs.push(fake);
    return fake.proc;
  };
  return {
    spawn,
    requests,
    procs,
    /** n 本目のプロセスが起きるまで待つ（起動はプロンプトが来てからなので非同期）。 */
    at: async (index: number): Promise<FakeProcess> => {
      await waitFor(() => procs.length > index, `process #${index}`);
      const fake = procs[index];
      if (!fake) {
        throw new Error(`no process spawned at index ${index}`);
      }
      return fake;
    },
  };
}

interface Harness {
  events: AgentEvent[];
  prompts: AsyncQueue<string>;
  permissions: {
    request: Omit<PermissionRequest, 'id'>;
    resolve(decision: PermissionDecision): void;
  }[];
  abort: AbortController;
  /** 消費側のループが終わるまで（テスト末尾で await する必要は無い）。 */
  done: Promise<void>;
}

function run(
  spawn: GrokSpawn,
  opts: { options?: AgentRunOptions; resume?: string } = {},
): { harness: Harness; run: ReturnType<ReturnType<typeof createGrokAdapter>['open']> } {
  const adapter = createGrokAdapter({ spawn });
  const prompts = new AsyncQueue<string>();
  const events: AgentEvent[] = [];
  const permissions: Harness['permissions'] = [];
  const abort = new AbortController();
  const request: AgentRunRequest = {
    cwd: '/repo',
    prompt: prompts,
    resume: opts.resume,
    options: opts.options ?? {},
    requestPermission: (req) =>
      new Promise<PermissionDecision>((resolve) => {
        permissions.push({ request: req, resolve });
      }),
    abortController: abort,
  };
  const agentRun = adapter.open(request);
  const done = (async () => {
    for await (const event of agentRun) {
      events.push(event);
    }
  })();
  return { harness: { events, prompts, permissions, abort, done }, run: agentRun };
}

/** initialize → session/new を済ませて 1 ターン目を送れる状態にする。 */
async function handshake(
  proc: FakeProcess,
  opts: { sessionId?: string; currentModelId?: string } = {},
): Promise<void> {
  await waitFor(() => proc.find('initialize') !== undefined, 'initialize');
  proc.reply('initialize', { protocolVersion: 1 });
  await waitFor(() => proc.find('session/new') !== undefined, 'session/new');
  proc.reply('session/new', {
    sessionId: opts.sessionId ?? 'sess-1',
    models: { currentModelId: opts.currentModelId ?? 'grok-4.5' },
  });
}

const kinds = (events: readonly AgentEvent[]): string[] => events.map((e) => e.kind);

describe('createGrokAdapter', () => {
  it('名乗りと capability', () => {
    const adapter = createGrokAdapter({ spawn: makeFakeGrok().spawn });
    expect(adapter.id).toBe('grok');
    expect(adapter.displayName).toBe('Grok');
    expect(adapter.loginCommand).toBe('grok');
    expect(adapter.capabilities).toEqual(GROK_CAPABILITIES);
    // 許可・質問を上げられるのが Codex との決定的な違い。
    expect(adapter.capabilities.permissions).toBe(true);
  });

  it('TUI 内ログインは spawnLogin を注入したときだけ生える', () => {
    const calls: { command: string; args: readonly string[] }[] = [];
    const withLogin = createGrokAdapter({
      spawn: makeFakeGrok().spawn,
      spawnLogin: (command, args) => {
        calls.push({ command, args });
        return {
          [Symbol.asyncIterator]: async function* () {},
          cancel: () => {},
          result: () => ({ code: 0 }),
        };
      },
    });
    withLogin.login?.();
    expect(calls).toEqual([{ command: 'grok', args: ['login', '--device-auth'] }]);
    expect(createGrokAdapter({ spawn: makeFakeGrok().spawn }).login).toBeUndefined();
  });

  describe('ターンの進行', () => {
    it('initialize → session/new → session/prompt の順に往復し、完了を流す', async () => {
      const grok = makeFakeGrok();
      const { harness } = run(grok.spawn, { options: { systemPrompt: 'RULES', effort: 'high' } });
      harness.prompts.push('hello');

      const proc = await grok.at(0);
      await handshake(proc);
      // systemPrompt は `_meta.rules` で渡す（Grok 自身の system prompt は潰さない）。
      const created = proc.find('session/new');
      expect(created?.params?._meta).toMatchObject({ rules: 'RULES' });
      expect(created?.params?.cwd).toBe('/repo');
      // effort は起動時の引数（`--reasoning-effort`）として渡る。
      expect(grok.requests[0]?.effort).toBe('high');

      await waitFor(() => proc.find('session/prompt') !== undefined, 'session/prompt');
      expect(proc.find('session/prompt')?.params?.prompt).toEqual([
        { type: 'text', text: 'hello' },
      ]);
      proc.reply('session/prompt', { stopReason: 'end_turn' });

      await waitFor(() => harness.events.some((e) => e.kind === 'turn_completed'), 'completion');
      expect(kinds(harness.events)).toEqual([
        'session_started',
        'model_resolved',
        'turn_completed',
      ]);
      expect(harness.events[0]).toEqual({ kind: 'session_started', sessionId: 'sess-1' });
      expect(harness.events[1]).toEqual({ kind: 'model_resolved', model: 'grok-4.5' });
    });

    // `/agent` の引き継ぎは systemPrompt（`_meta.rules`）ではなく最初のユーザープロンプトに
    // 載る。session/resume には rules を渡し直さないので、そこでも確実に届く。
    it('引き継ぎは切替後の最初のプロンプトにだけ前置する', async () => {
      const grok = makeFakeGrok();
      const { harness } = run(grok.spawn, { options: { handoff: 'HANDOVER' } });
      harness.prompts.push('now you');
      const proc = await grok.at(0);
      await handshake(proc);

      await waitFor(() => proc.find('session/prompt') !== undefined, 'first prompt');
      expect(proc.find('session/prompt')?.params?.prompt).toEqual([
        { type: 'text', text: 'HANDOVER\n\n# Current instruction after the switch\n\nnow you' },
      ]);
      proc.reply('session/prompt', { stopReason: 'end_turn' });
      await waitFor(() => harness.events.some((e) => e.kind === 'turn_completed'), 'first turn');

      harness.prompts.push('and this');
      await waitFor(
        () => proc.sent.filter((m) => m.method === 'session/prompt').length === 2,
        'second prompt',
      );
      const second = proc.sent.filter((m) => m.method === 'session/prompt')[1];
      expect(second?.params?.prompt).toEqual([{ type: 'text', text: 'and this' }]);
    });

    it('2 ターン目は同じプロセスを使い回す（1 ターン 1 プロセスではない）', async () => {
      const grok = makeFakeGrok();
      const { harness } = run(grok.spawn);
      harness.prompts.push('first');
      const proc = await grok.at(0);
      await handshake(proc);
      await waitFor(() => proc.find('session/prompt') !== undefined, 'first prompt');
      proc.reply('session/prompt', { stopReason: 'end_turn' });
      await waitFor(() => harness.events.some((e) => e.kind === 'turn_completed'), 'first turn');

      harness.prompts.push('second');
      await waitFor(
        () => proc.sent.filter((m) => m.method === 'session/prompt').length === 2,
        'second prompt',
      );
      expect(grok.procs).toHaveLength(1);
      expect(proc.sent.filter((m) => m.method === 'session/new')).toHaveLength(1);
    });

    it('resume id があれば session/resume で繋ぎ直す（session/load は使わない）', async () => {
      const grok = makeFakeGrok();
      const { harness } = run(grok.spawn, { resume: 'sess-old' });
      harness.prompts.push('again');
      const proc = await grok.at(0);
      await waitFor(() => proc.find('initialize') !== undefined, 'initialize');
      proc.reply('initialize', { protocolVersion: 1 });
      await waitFor(() => proc.find('session/resume') !== undefined, 'session/resume');
      expect(proc.find('session/resume')?.params).toMatchObject({
        sessionId: 'sess-old',
        cwd: '/repo',
      });
      // 会話を丸ごと流し直す `session/load` は使わない（ログが二重になる）。
      expect(proc.find('session/load')).toBeUndefined();
      proc.reply('session/resume', { models: { currentModelId: 'grok-code-fast-2' } });

      await waitFor(() => proc.find('session/prompt') !== undefined, 'prompt after resume');
      expect(harness.events).toContainEqual({
        kind: 'model_resolved',
        model: 'grok-code-fast-2',
      });
      // 新規セッションは開かない（開くと過去の文脈が消える）。
      expect(proc.find('session/new')).toBeUndefined();
    });

    it('resume に失敗したら新しいセッションを開いて続ける', async () => {
      const grok = makeFakeGrok();
      const { harness } = run(grok.spawn, { resume: 'sess-gone' });
      harness.prompts.push('again');
      const proc = await grok.at(0);
      await waitFor(() => proc.find('initialize') !== undefined, 'initialize');
      proc.reply('initialize', { protocolVersion: 1 });
      await waitFor(() => proc.find('session/resume') !== undefined, 'session/resume');
      proc.replyError('session/resume', { message: 'Path not found.' });
      await waitFor(() => proc.find('session/new') !== undefined, 'session/new fallback');
      proc.reply('session/new', { sessionId: 'sess-new' });
      await waitFor(() => proc.find('session/prompt') !== undefined, 'prompt');
      expect(harness.events).toContainEqual({ kind: 'session_started', sessionId: 'sess-new' });
    });

    it('通知はログのイベントへ写る（本文はターン終了で確定する）', async () => {
      const grok = makeFakeGrok();
      const { harness } = run(grok.spawn);
      harness.prompts.push('hi');
      const proc = await grok.at(0);
      await handshake(proc);
      await waitFor(() => proc.find('session/prompt') !== undefined, 'prompt');

      proc.emit({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: 'sess-1',
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hi ' } },
        },
      });
      proc.emit({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: 'sess-1',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'there' },
          },
        },
      });
      await waitFor(
        () => harness.events.filter((e) => e.kind === 'stream_text').length === 2,
        'stream deltas',
      );
      proc.reply('session/prompt', { stopReason: 'end_turn' });
      await waitFor(() => harness.events.some((e) => e.kind === 'turn_completed'), 'completion');

      expect(harness.events).toContainEqual({ kind: 'assistant_text', text: 'Hi there' });
      // 確定は完了イベントより前（ログの順序が入れ替わらない）。
      const textAt = harness.events.findIndex((e) => e.kind === 'assistant_text');
      const doneAt = harness.events.findIndex((e) => e.kind === 'turn_completed');
      expect(textAt).toBeLessThan(doneAt);
    });

    it('`_x.ai/models/update` はモデル欄だけを更新する', async () => {
      const grok = makeFakeGrok();
      const { harness } = run(grok.spawn);
      harness.prompts.push('hi');
      const proc = await grok.at(0);
      await handshake(proc);
      proc.emit({
        jsonrpc: '2.0',
        method: '_x.ai/models/update',
        params: { currentModelId: 'grok-5', availableModels: [{ modelId: 'grok-5' }] },
      });
      await waitFor(
        () => harness.events.some((e) => e.kind === 'model_resolved' && e.model === 'grok-5'),
        'model update',
      );
    });
  });

  describe('許可と質問', () => {
    it('許可要求をダイアログへ上げ、返事の kind で optionId を選ぶ', async () => {
      const grok = makeFakeGrok();
      const { harness } = run(grok.spawn);
      harness.prompts.push('rm it');
      const proc = await grok.at(0);
      await handshake(proc);
      await waitFor(() => proc.find('session/prompt') !== undefined, 'prompt');

      proc.emit({
        jsonrpc: '2.0',
        id: 977,
        method: 'session/request_permission',
        params: {
          sessionId: 'sess-1',
          toolCall: {
            toolCallId: 'call-1',
            rawInput: { command: 'rm -rf build' },
            _meta: { 'x.ai/tool': { name: 'run_terminal_command', kind: 'execute' } },
          },
          options: [
            { optionId: 'allow-once', name: 'Yes, proceed', kind: 'allow_once' },
            { optionId: 'reject-once', name: 'No', kind: 'reject_once' },
          ],
        },
      });
      await waitFor(() => harness.permissions.length === 1, 'permission dialog');
      const asked = harness.permissions[0];
      expect(asked?.request.kind).toBe('tool');
      expect(asked?.request.toolName).toBe('run_terminal_command');
      expect(asked?.request.input).toEqual({ command: 'rm -rf build' });

      asked?.resolve({ behavior: 'allow' });
      await waitFor(() => proc.sent.some((m) => m.id === 977), 'permission reply');
      expect(proc.sent.find((m) => m.id === 977)?.result).toEqual({
        outcome: { outcome: 'selected', optionId: 'allow-once' },
      });
    });

    it('拒否は reject 系の optionId を選ぶ（固定文字列に頼らない）', async () => {
      const grok = makeFakeGrok();
      const { harness } = run(grok.spawn);
      harness.prompts.push('rm it');
      const proc = await grok.at(0);
      await handshake(proc);
      proc.emit({
        jsonrpc: '2.0',
        id: 905,
        method: 'session/request_permission',
        params: {
          sessionId: 'sess-1',
          toolCall: { toolCallId: 'c1', rawInput: {} },
          options: [
            { optionId: 'always-allow', kind: 'allow_always' },
            { optionId: 'nope', kind: 'reject_once' },
          ],
        },
      });
      await waitFor(() => harness.permissions.length === 1, 'permission dialog');
      harness.permissions[0]?.resolve({ behavior: 'deny', message: 'no' });
      await waitFor(() => proc.sent.some((m) => m.id === 905), 'permission reply');
      expect(proc.sent.find((m) => m.id === 905)?.result).toEqual({
        outcome: { outcome: 'selected', optionId: 'nope' },
      });
    });

    // `kind` は optional。CLI が名前を変えた・落としたときに「1 番目の選択肢」へ
    // 落ちると、実データの先頭は `allow-once` なので**拒否したのに実行される**。
    it('拒否できる選択肢が見当たらなければ cancelled で返す（allow に化けさせない）', async () => {
      const grok = makeFakeGrok();
      const { harness } = run(grok.spawn);
      harness.prompts.push('rm it');
      const proc = await grok.at(0);
      await handshake(proc);
      proc.emit({
        jsonrpc: '2.0',
        id: 906,
        method: 'session/request_permission',
        params: {
          sessionId: 'sess-1',
          toolCall: { toolCallId: 'c1', rawInput: {} },
          // `kind` の無い（= CLI 側の語彙が変わった）選択肢。先頭は実行系。
          options: [{ optionId: 'allow-once' }, { optionId: 'reject-once' }],
        },
      });
      await waitFor(() => harness.permissions.length === 1, 'permission dialog');
      harness.permissions[0]?.resolve({ behavior: 'deny', message: 'no' });
      await waitFor(() => proc.sent.some((m) => m.id === 906), 'permission reply');
      expect(proc.sent.find((m) => m.id === 906)?.result).toEqual({
        outcome: { outcome: 'cancelled' },
      });
    });

    it('質問は QuestionSpec へ写り、回答は質問文をキーにしたマップで返す', async () => {
      const grok = makeFakeGrok();
      const { harness } = run(grok.spawn);
      harness.prompts.push('ask me');
      const proc = await grok.at(0);
      await handshake(proc);
      proc.emit({
        jsonrpc: '2.0',
        id: 909,
        method: '_x.ai/ask_user_question',
        params: {
          sessionId: 'sess-1',
          toolCallId: 'call-q',
          mode: 'default',
          questions: [
            {
              question: 'Which approach?',
              multiSelect: false,
              options: [
                { label: 'Rewrite', description: 'Start over' },
                { label: 'Patch', description: 'Minimal' },
              ],
            },
          ],
        },
      });
      await waitFor(() => harness.permissions.length === 1, 'question dialog');
      const asked = harness.permissions[0];
      expect(asked?.request.kind).toBe('question');
      expect(asked?.request.questions).toEqual([
        {
          question: 'Which approach?',
          header: '',
          multiSelect: false,
          options: [
            { label: 'Rewrite', description: 'Start over' },
            { label: 'Patch', description: 'Minimal' },
          ],
        },
      ]);

      asked?.resolve({ behavior: 'allow', input: { answers: { 'Which approach?': 'Patch' } } });
      await waitFor(() => proc.sent.some((m) => m.id === 909), 'question reply');
      // `outcome` が無いとツールが失敗する（実測）。複数選択はカンマ区切り → 配列。
      expect(proc.sent.find((m) => m.id === 909)?.result).toEqual({
        outcome: 'accepted',
        answers: { 'Which approach?': ['Patch'] },
      });
    });

    it('複数選択の回答はカンマ区切りを配列に割る', async () => {
      const grok = makeFakeGrok();
      const { harness } = run(grok.spawn);
      harness.prompts.push('ask me');
      const proc = await grok.at(0);
      await handshake(proc);
      proc.emit({
        jsonrpc: '2.0',
        id: 903,
        method: '_x.ai/ask_user_question',
        params: {
          sessionId: 'sess-1',
          questions: [{ question: 'Which extras?', multiSelect: true, options: [] }],
        },
      });
      await waitFor(() => harness.permissions.length === 1, 'question dialog');
      harness.permissions[0]?.resolve({
        behavior: 'allow',
        input: { answers: { 'Which extras?': 'Tests, Docs' } },
      });
      await waitFor(() => proc.sent.some((m) => m.id === 903), 'question reply');
      expect(proc.sent.find((m) => m.id === 903)?.result).toEqual({
        outcome: 'accepted',
        answers: { 'Which extras?': ['Tests', 'Docs'] },
      });
    });

    it('質問を断ったら cancelled で返す（declined という値は無い）', async () => {
      const grok = makeFakeGrok();
      const { harness } = run(grok.spawn);
      harness.prompts.push('ask me');
      const proc = await grok.at(0);
      await handshake(proc);
      proc.emit({
        jsonrpc: '2.0',
        id: 904,
        method: '_x.ai/ask_user_question',
        params: { sessionId: 'sess-1', questions: [{ question: 'Q?', options: [] }] },
      });
      await waitFor(() => harness.permissions.length === 1, 'question dialog');
      harness.permissions[0]?.resolve({ behavior: 'deny' });
      await waitFor(() => proc.sent.some((m) => m.id === 904), 'question reply');
      expect(proc.sent.find((m) => m.id === 904)?.result).toEqual({ outcome: 'cancelled' });
    });

    it('知らない要求にも必ず答える（放置するとターンが永久に止まる）', async () => {
      const grok = makeFakeGrok();
      const { harness } = run(grok.spawn);
      harness.prompts.push('hi');
      const proc = await grok.at(0);
      await handshake(proc);
      proc.emit({ jsonrpc: '2.0', id: 942, method: '_x.ai/unknown/thing', params: {} });
      await waitFor(() => proc.sent.some((m) => m.id === 942), 'method-not-found reply');
      expect(proc.sent.find((m) => m.id === 942)).toMatchObject({
        error: { code: -32601 },
      });
    });
  });

  describe('中断・失敗', () => {
    it('interrupt は session/cancel を通知として送る（id を付けない）', async () => {
      const grok = makeFakeGrok();
      const { harness, run: agentRun } = run(grok.spawn);
      harness.prompts.push('long task');
      const proc = await grok.at(0);
      await handshake(proc);
      await waitFor(() => proc.find('session/prompt') !== undefined, 'prompt');

      await agentRun.interrupt?.();
      const cancel = proc.find('session/cancel');
      expect(cancel?.params).toEqual({ sessionId: 'sess-1' });
      // **通知**なので id は付けない（付けると Method not found になる。実測）。
      expect(cancel?.id).toBeUndefined();

      // 中断後の `cancelled` は静かに終わる（状態は Session 側が確定済み）。
      proc.reply('session/prompt', { stopReason: 'cancelled' });
      await tick();
      await tick();
      expect(kinds(harness.events)).not.toContain('turn_stopped');
      expect(kinds(harness.events)).not.toContain('turn_completed');
    });

    it('自分で止めていない cancelled は resumable な停止にする', async () => {
      const grok = makeFakeGrok();
      const { harness } = run(grok.spawn);
      harness.prompts.push('hi');
      const proc = await grok.at(0);
      await handshake(proc);
      await waitFor(() => proc.find('session/prompt') !== undefined, 'prompt');
      proc.reply('session/prompt', { stopReason: 'cancelled' });
      await waitFor(() => harness.events.some((e) => e.kind === 'turn_stopped'), 'stop');
      expect(harness.events.at(-1)).toMatchObject({ kind: 'turn_stopped', cause: 'connection' });
    });

    it('ターンのエラーは文言から分類する（401 は auth）', async () => {
      const grok = makeFakeGrok();
      const { harness } = run(grok.spawn);
      harness.prompts.push('hi');
      const proc = await grok.at(0);
      await handshake(proc);
      await waitFor(() => proc.find('session/prompt') !== undefined, 'prompt');
      proc.replyError('session/prompt', {
        message: 'Internal error',
        data: 'Unauthorized (401) from https://api.x.ai/v1/responses: Incorrect API key provided.',
      });
      await waitFor(() => harness.events.some((e) => e.kind === 'turn_stopped'), 'stop');
      expect(harness.events.at(-1)).toMatchObject({ kind: 'turn_stopped', cause: 'auth' });
    });

    it('セッションを開けない（未ログイン）ときは auth で止め、次のターンでやり直す', async () => {
      const grok = makeFakeGrok();
      const { harness } = run(grok.spawn);
      harness.prompts.push('hi');
      const first = await grok.at(0);
      await waitFor(() => first.find('initialize') !== undefined, 'initialize');
      first.reply('initialize', { protocolVersion: 1 });
      await waitFor(() => first.find('session/new') !== undefined, 'session/new');
      first.replyError('session/new', {
        code: -32000,
        message: 'Authentication required',
        data: 'no auth method id provided',
      });
      await waitFor(() => harness.events.some((e) => e.kind === 'turn_stopped'), 'auth stop');
      expect(harness.events.at(-1)).toMatchObject({ kind: 'turn_stopped', cause: 'auth' });
      // 立ち上げに失敗したプロセスは畳む（worktree を触ったまま残さない）。
      expect(first.wasKilled()).toBe(true);

      // ログインし直したあとの再送は新しいプロセスで最初からやり直す。
      harness.prompts.push('retry');
      await waitFor(() => grok.procs.length === 2, 'respawn');
      await handshake(await grok.at(1), { sessionId: 'sess-2' });
      const second = await grok.at(1);
      await waitFor(() => second.find('session/prompt') !== undefined, 'prompt on the new process');
    });

    // 未応答要求の待ち行列は**接続ごと**に持つ。1 本にまとめていた頃は、死んだ
    // プロセスの後片付け（stdout が閉じたときに待ち人を全部起こす処理）が
    // **次のプロセスの** `initialize` まで「1 本目の stderr」で失敗させ、健全な
    // プロセスを殺していた（実プロセスの SIGTERM は stdout が閉じるまで少し遅れる）。
    it('死んだプロセスの後片付けが次のプロセスの要求を巻き込まない', async () => {
      const procs: FakeProcess[] = [];
      const spawn: GrokSpawn = () => {
        const fake = makeFakeProcess();
        procs.push(fake);
        // kill しても stdout が閉じるのは少し後（= 実プロセスと同じタイミング）。
        return {
          [Symbol.asyncIterator]: () => fake.proc[Symbol.asyncIterator](),
          send: (message: unknown) => fake.proc.send(message),
          kill: () => {
            setTimeout(() => fake.proc.kill(), 5);
          },
          result: () => fake.proc.result(),
        };
      };
      const { harness } = run(spawn);
      harness.prompts.push('one');
      harness.prompts.push('two');

      await waitFor(() => procs.length > 0, 'first process');
      const first = procs[0];
      if (!first) {
        throw new Error('no first process');
      }
      first.setExit({ code: 1, stderr: 'first process stderr' });
      await waitFor(() => first.find('initialize') !== undefined, 'initialize');
      first.reply('initialize', { protocolVersion: 1 });
      await waitFor(() => first.find('session/new') !== undefined, 'session/new');
      first.replyError('session/new', {
        code: -32000,
        message: 'Authentication required',
        data: 'no auth method id provided',
      });

      // 2 本目が起きる（1 本目の stdout はこの後で閉じる）。
      await waitFor(() => procs.length > 1, 'second process');
      const second = procs[1];
      if (!second) {
        throw new Error('no second process');
      }
      await waitFor(() => second.find('initialize') !== undefined, 'initialize on #2');
      await new Promise((r) => setTimeout(r, 20)); // 1 本目の後片付けを通す
      await handshake(second, { sessionId: 'sess-2' });
      await waitFor(() => second.find('session/prompt') !== undefined, 'prompt on #2');

      // 2 本目は生きたまま。止まったのは 1 本目のターンだけ。
      expect(second.wasKilled()).toBe(false);
      const stops = harness.events.filter((e) => e.kind === 'turn_stopped');
      expect(stops).toHaveLength(1);
      expect(stops[0]).toMatchObject({ cause: 'auth' });
    });

    it('ターンの最中にプロセスが死んだら、stderr を理由にして再開可能な停止にする', async () => {
      const grok = makeFakeGrok();
      const { harness } = run(grok.spawn);
      harness.prompts.push('hi');
      const proc = await grok.at(0);
      await handshake(proc);
      await waitFor(() => proc.find('session/prompt') !== undefined, 'prompt');

      // クラッシュ: 応答を返さないまま stdout が尽きる。
      proc.setExit({ code: 101, stderr: 'thread panicked at ...' });
      proc.end();

      await waitFor(() => harness.events.some((e) => e.kind === 'turn_stopped'), 'stop');
      const stopped = harness.events.at(-1);
      // **`failed`（終端・再開不可）にしない** — 一過性のクラッシュで再開の導線を消さない。
      expect(stopped).toMatchObject({ kind: 'turn_stopped', cause: 'connection' });
      // 理由はプロセスから取る（合成文言だと診断にならない）。
      expect(stopped).toMatchObject({ detail: expect.stringContaining('thread panicked') });

      // 次の指示は新しいプロセスで、**同じ会話を resume して**やり直す。
      harness.prompts.push('retry');
      const second = await grok.at(1);
      await waitFor(() => second.find('initialize') !== undefined, 'initialize after crash');
      second.reply('initialize', { protocolVersion: 1 });
      await waitFor(() => second.find('session/resume') !== undefined, 'resume after crash');
      expect(second.find('session/resume')?.params).toMatchObject({ sessionId: 'sess-1' });
      second.reply('session/resume', {});
      await waitFor(() => second.find('session/prompt') !== undefined, 'prompt after crash');
    });

    it('プロセスが死んだ理由が認証切れなら auth のまま（分類を潰さない）', async () => {
      const grok = makeFakeGrok();
      const { harness } = run(grok.spawn);
      harness.prompts.push('hi');
      const proc = await grok.at(0);
      await handshake(proc);
      await waitFor(() => proc.find('session/prompt') !== undefined, 'prompt');
      proc.setExit({ code: 1, stderr: 'Not signed in. To authenticate without a browser, run:' });
      proc.end();
      await waitFor(() => harness.events.some((e) => e.kind === 'turn_stopped'), 'stop');
      expect(harness.events.at(-1)).toMatchObject({ kind: 'turn_stopped', cause: 'auth' });
    });

    it('retry_state の error_type を失敗の分類に使う（文言では読めないとき）', async () => {
      const grok = makeFakeGrok();
      const { harness } = run(grok.spawn);
      harness.prompts.push('hi');
      const proc = await grok.at(0);
      await handshake(proc);
      await waitFor(() => proc.find('session/prompt') !== undefined, 'prompt');
      proc.emit({
        jsonrpc: '2.0',
        method: '_x.ai/session_notification',
        params: {
          sessionId: 'sess-1',
          update: {
            sessionUpdate: 'retry_state',
            type: 'failed',
            error_type: 'rate_limit',
            message: 'the provider said no',
          },
        },
      });
      await waitFor(() => harness.events.some((e) => e.kind === 'notice'), 'retry notice');
      proc.replyError('session/prompt', {
        message: 'Internal error',
        data: 'the provider said no',
      });
      await waitFor(() => harness.events.some((e) => e.kind === 'turn_stopped'), 'stop');
      // 文言だけなら `failed` に落ちるところを、CLI 自身の分類が救う。
      expect(harness.events.at(-1)).toMatchObject({ kind: 'turn_stopped', cause: 'rate_limit' });
    });

    it('セッション確立中の Ctrl+C はそのターンを始めない（裏で走り続けさせない）', async () => {
      const grok = makeFakeGrok();
      const { harness, run: agentRun } = run(grok.spawn);
      harness.prompts.push('long task');
      const proc = await grok.at(0);
      await waitFor(() => proc.find('initialize') !== undefined, 'initialize');
      proc.reply('initialize', { protocolVersion: 1 });
      await waitFor(() => proc.find('session/new') !== undefined, 'session/new');

      // まだ sessionId が無い時点で中断（UI は既に「中断」と言っている）。
      await agentRun.interrupt?.();
      // 走っているターンが無いので cancel は送らない（送っても空振りする）。
      expect(proc.find('session/cancel')).toBeUndefined();

      proc.reply('session/new', { sessionId: 'sess-1' });
      for (let i = 0; i < 20; i += 1) {
        await tick();
      }
      // **中断した指示は投げない**。ここで送ると UI は中断済みなのにエージェントだけが
      // worktree を書き換え続ける（cancel は「今走っているターン」しか止められない）。
      expect(proc.find('session/prompt')).toBeUndefined();
      expect(kinds(harness.events)).not.toContain('turn_completed');

      // 次の指示は普通に始まる（そのときの text で）。
      harness.prompts.push('do it now');
      await waitFor(() => proc.find('session/prompt') !== undefined, 'prompt for the new text');
      expect(proc.find('session/prompt')?.params?.prompt).toEqual([
        { type: 'text', text: 'do it now' },
      ]);
    });

    it('resume の最中に Ctrl+C を押しても同じ（prompt を出さない）', async () => {
      const grok = makeFakeGrok();
      const { harness, run: agentRun } = run(grok.spawn, { resume: 'sess-old' });
      harness.prompts.push('long task');
      const proc = await grok.at(0);
      await waitFor(() => proc.find('initialize') !== undefined, 'initialize');
      proc.reply('initialize', { protocolVersion: 1 });
      await waitFor(() => proc.find('session/resume') !== undefined, 'session/resume');
      // sessionId は既に分かっているが、ターンはまだ走っていない。
      await agentRun.interrupt?.();
      expect(proc.find('session/cancel')).toBeUndefined();
      proc.reply('session/resume', {});
      for (let i = 0; i < 20; i += 1) {
        await tick();
      }
      expect(proc.find('session/prompt')).toBeUndefined();
    });

    it('中断と end_turn が競っても completed にしない（auto-PR を走らせない）', async () => {
      const grok = makeFakeGrok();
      const { harness, run: agentRun } = run(grok.spawn);
      harness.prompts.push('hi');
      const proc = await grok.at(0);
      await handshake(proc);
      await waitFor(() => proc.find('session/prompt') !== undefined, 'prompt');
      await agentRun.interrupt?.();
      // cancel が届く前にターンが終わっていた場合。
      proc.reply('session/prompt', { stopReason: 'end_turn' });
      await tick();
      await tick();
      await tick();
      expect(kinds(harness.events)).not.toContain('turn_completed');
    });

    it('消費側に捨てられたらプロセスを畳む', async () => {
      const grok = makeFakeGrok();
      const adapter = createGrokAdapter({ spawn: grok.spawn });
      const prompts = new AsyncQueue<string>();
      const abort = new AbortController();
      const agentRun = adapter.open({
        cwd: '/repo',
        prompt: prompts,
        options: {},
        requestPermission: async () => ({ behavior: 'deny' }),
        abortController: abort,
      });
      prompts.push('hi');
      const iterator = agentRun[Symbol.asyncIterator]();
      const first = iterator.next();
      const proc = await grok.at(0);
      await handshake(proc);
      await first;
      await iterator.return?.(undefined);
      expect(proc.wasKilled()).toBe(true);
    });

    it('abort でプロセスを殺してストリームを閉じる', async () => {
      const grok = makeFakeGrok();
      const { harness } = run(grok.spawn);
      harness.prompts.push('hi');
      const proc = await grok.at(0);
      await handshake(proc);
      harness.abort.abort();
      await harness.done;
      expect(proc.wasKilled()).toBe(true);
    });
  });

  describe('setModel', () => {
    it('走っているセッションへ session/set_model を送り、モデル欄を更新する', async () => {
      const grok = makeFakeGrok();
      const { harness, run: agentRun } = run(grok.spawn);
      harness.prompts.push('hi');
      const proc = await grok.at(0);
      await handshake(proc);
      // セッション確立（`session/new` の応答処理）が済むまで待つ。
      await waitFor(() => harness.events.some((e) => e.kind === 'session_started'), 'session');
      const pending = agentRun.setModel?.('grok-code-fast-2');
      await waitFor(() => proc.find('session/set_model') !== undefined, 'set_model');
      expect(proc.find('session/set_model')?.params).toEqual({
        sessionId: 'sess-1',
        modelId: 'grok-code-fast-2',
      });
      proc.reply('session/set_model', { _meta: { model: { Ok: 'grok-code-fast-2' } } });
      await pending;
      await waitFor(
        () =>
          harness.events.some((e) => e.kind === 'model_resolved' && e.model === 'grok-code-fast-2'),
        'model_resolved after set_model',
      );
    });

    it('セッション開始前の選択は session/new の `_meta.modelId` に載る', async () => {
      const grok = makeFakeGrok();
      const { harness } = run(grok.spawn, { options: { model: 'grok-code-fast-2' } });
      harness.prompts.push('hi');
      const proc = await grok.at(0);
      await waitFor(() => proc.find('initialize') !== undefined, 'initialize');
      proc.reply('initialize', { protocolVersion: 1 });
      await waitFor(() => proc.find('session/new') !== undefined, 'session/new');
      expect(proc.find('session/new')?.params?._meta).toMatchObject({
        modelId: 'grok-code-fast-2',
      });
    });
  });
});
