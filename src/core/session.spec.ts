import type { Options, PermissionResult, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it, vi } from 'vitest';
import type { AgentAdapter, AgentRunRequest } from '@/core/agent-ports';
import { NO_CAPABILITIES } from '@/core/agent-ports';
import { AsyncQueue } from '@/core/async-queue';
import type { QueryFn } from '@/core/claude-adapter';
import { type PermissionPolicy, Session } from '@/core/session';
import { AGENT_SWITCH_DETAIL, initialState, STREAM_ENDED_DETAIL } from '@/core/status-reducer';
import { SHARED_IGNORED_FILES_NOTICE } from '@/core/system-prompt';
import type { AgentId, CreateSessionInput } from '@/core/types';

const tick = () => new Promise((r) => setTimeout(r, 0));

const INPUT: CreateSessionInput = {
  id: 's1',
  title: 't',
  prompt: 'do the thing',
  branch: 'codiva/t',
  worktreePath: '/tmp/t',
  startedAt: 0,
};

type CanUseTool = (toolName: string, input: Record<string, unknown>) => Promise<PermissionResult>;

/** A controllable fake of the SDK's query(): drive output + inspect canUseTool. */
function makeFakeQuery() {
  const out = new AsyncQueue<SDKMessage>();
  const captured: { canUseTool?: CanUseTool; options?: Options } = {};
  let interrupted = false;

  const modelCalls: (string | undefined)[] = [];

  const queryFn = ({ options }: { prompt: AsyncIterable<unknown>; options: Options }): Query => {
    captured.canUseTool = options.canUseTool as unknown as CanUseTool;
    captured.options = options;
    const gen = (async function* () {
      yield* out;
    })() as unknown as Query & {
      interrupt: () => Promise<void>;
      setModel: (model?: string) => Promise<void>;
    };
    gen.interrupt = async () => {
      interrupted = true;
    };
    gen.setModel = async (model?: string) => {
      modelCalls.push(model);
    };
    return gen;
  };

  return {
    queryFn,
    emit: (m: unknown) => out.push(m as SDKMessage),
    end: () => out.close(),
    call: (name: string, input: Record<string, unknown>) => captured.canUseTool?.(name, input),
    wasInterrupted: () => interrupted,
    modelCalls,
    seenOptions: () => captured.options,
  };
}

function initMsg(): SDKMessage {
  return { type: 'system', subtype: 'init', session_id: 'sdk-1' } as unknown as SDKMessage;
}
function resultOk(): SDKMessage {
  return {
    type: 'result',
    subtype: 'success',
    result: 'done',
    total_cost_usd: 0.01,
  } as unknown as SDKMessage;
}

describe('Session', () => {
  it('runs to completed and notifies onChange', async () => {
    const fake = makeFakeQuery();
    const states: string[] = [];
    const session = new Session({
      queryFn: fake.queryFn,
      input: INPUT,
      now: () => 1,
      onChange: (s) => states.push(s.status),
    });
    session.start();
    fake.emit(initMsg());
    await tick();
    expect(session.getState().status).toBe('running');
    fake.emit(resultOk());
    await tick();
    fake.end();
    await tick();
    expect(session.getState().status).toBe('completed');
    expect(session.getState().totalCostUsd).toBe(0.01);
    expect(states).toContain('completed');
  });

  it('accrues only active (working) time, excluding time spent awaiting the user', async () => {
    const fake = makeFakeQuery();
    let t = 0;
    const session = new Session({ queryFn: fake.queryFn, input: INPUT, now: () => t });
    session.start();

    // creating → running: still active, clock keeps running from startedAt (0).
    t = 10;
    fake.emit(initMsg());
    await tick();
    expect(session.getState().status).toBe('running');

    // running → awaiting_input at t=100: closes the segment (0→100 = 100ms active).
    t = 100;
    const decision = fake.call('AskUserQuestion', {
      questions: [{ question: 'Q', header: 'h', multiSelect: false, options: [] }],
    });
    await tick();
    expect(session.getState().status).toBe('awaiting_input');
    expect(session.getState().activeMs).toBe(100);
    expect(session.getState().activeSince).toBeUndefined();

    // The user takes 400ms to answer — that idle gap must NOT be counted.
    t = 500;
    session.answerPending({ Q: 'A' });
    await tick();
    expect(session.getState().status).toBe('running');
    expect(session.getState().activeSince).toBe(500);
    expect(session.getState().activeMs).toBe(100);

    // running → completed at t=800: adds the second segment (500→800 = 300ms).
    t = 800;
    fake.emit(resultOk());
    await tick();
    fake.end();
    await tick();
    expect(session.getState().status).toBe('completed');
    // 100 + 300 = 400ms of actual work; wall-clock since start would be 800ms.
    expect(session.getState().activeMs).toBe(400);
    expect(session.getState().activeSince).toBeUndefined();

    await decision;
  });

  it('forwards rate_limit_event payloads to onRateLimit', async () => {
    const fake = makeFakeQuery();
    const infos: unknown[] = [];
    const session = new Session({
      queryFn: fake.queryFn,
      input: INPUT,
      now: () => 1,
      onRateLimit: (info) => infos.push(info),
    });
    session.start();
    fake.emit(initMsg());
    fake.emit({
      type: 'rate_limit_event',
      rate_limit_info: {
        status: 'allowed_warning',
        rateLimitType: 'five_hour',
        utilization: 5,
        resetsAt: 1785542400,
      },
    } as unknown as SDKMessage);
    await tick();
    expect(infos).toEqual([
      {
        status: 'allowed_warning',
        rateLimitType: 'five_hour',
        utilization: 5,
        resetsAt: 1785542400,
      },
    ]);
  });

  it('escalates AskUserQuestion and resolves it with answers', async () => {
    const fake = makeFakeQuery();
    const session = new Session({ queryFn: fake.queryFn, input: INPUT, now: () => 1 });
    session.start();
    await tick();

    const questionInput = {
      questions: [
        {
          question: 'Which language?',
          header: 'Lang',
          multiSelect: false,
          options: [{ label: 'English', description: '' }],
        },
      ],
    };
    const decision = fake.call('AskUserQuestion', questionInput);
    // The permission_request is dispatched synchronously during canUseTool.
    expect(session.getState().status).toBe('awaiting_input');
    expect(session.getState().pendingPermission?.questions?.[0]?.question).toBe('Which language?');

    session.answerPending({ 'Which language?': 'English' });
    const result = await decision;
    expect(result?.behavior).toBe('allow');
    expect(
      (result as unknown as { updatedInput: { answers: unknown } }).updatedInput.answers,
    ).toEqual({ 'Which language?': 'English' });
    expect(session.getState().status).toBe('running');
    expect(session.getState().pendingPermission).toBeUndefined();
  });

  it('stays awaiting_input when the assistant tool_use message lands after the question', async () => {
    // Regression: canUseTool (control channel) and the assistant message
    // carrying the AskUserQuestion tool_use (stream channel) arrive out-of-band.
    // If the assistant message is reduced after the question is registered it
    // must not flip the badge back to Running.
    const fake = makeFakeQuery();
    const session = new Session({ queryFn: fake.queryFn, input: INPUT, now: () => 1 });
    session.start();
    await tick();

    const questionInput = {
      questions: [{ question: 'Which language?', header: 'Lang', multiSelect: false, options: [] }],
    };
    fake.call('AskUserQuestion', questionInput);
    expect(session.getState().status).toBe('awaiting_input');

    // The stream channel now delivers the assistant message for that tool_use.
    fake.emit({
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', id: 't1', name: 'AskUserQuestion', input: questionInput }],
      },
    } as unknown as SDKMessage);
    await tick();

    expect(session.getState().status).toBe('awaiting_input');
    expect(session.getState().pendingPermission?.kind).toBe('question');
  });

  it('auto-allows routine tools without escalating', async () => {
    const fake = makeFakeQuery();
    const session = new Session({ queryFn: fake.queryFn, input: INPUT, now: () => 1 });
    session.start();
    await tick();
    const result = await fake.call('Write', { file_path: 'a.txt' });
    expect(result?.behavior).toBe('allow');
    expect(session.getState().status).not.toBe('awaiting_permission');
  });

  it('escalates and denies a tool when the policy says ask', async () => {
    const policy: PermissionPolicy = (name) => (name === 'Bash' ? 'ask' : 'allow');
    const fake = makeFakeQuery();
    const session = new Session({ queryFn: fake.queryFn, input: INPUT, now: () => 1, policy });
    session.start();
    await tick();
    const decision = fake.call('Bash', { command: 'rm -rf /' });
    expect(session.getState().status).toBe('awaiting_permission');
    session.denyPending('too dangerous');
    const result = await decision;
    expect(result).toEqual({ behavior: 'deny', message: 'too dangerous' });
    expect(session.getState().status).toBe('running');
  });

  it('start() logs the initial prompt as the first user entry', () => {
    const fake = makeFakeQuery();
    const session = new Session({ queryFn: fake.queryFn, input: INPUT, now: () => 1 });
    session.start();
    // 詳細画面で「自分の最初の指示」が AI 応答より前に見えるよう、start でログ先頭に積む。
    const first = session.getState().messages[0];
    expect(first?.kind).toBe('user');
    expect(first?.text).toBe('do the thing');
    expect(first?.timestamp).toBe(INPUT.startedAt);
  });

  it('send() injects a follow-up and resumes running', async () => {
    const fake = makeFakeQuery();
    const session = new Session({ queryFn: fake.queryFn, input: INPUT, now: () => 1 });
    session.start();
    fake.emit(initMsg());
    fake.emit(resultOk());
    await tick();
    expect(session.getState().status).toBe('completed');
    session.send('now do more');
    expect(session.getState().status).toBe('running');
    expect(session.getState().messages.at(-1)?.text).toBe('now do more');
  });

  it('setModel() switches the live query and reflects it optimistically in state', async () => {
    const fake = makeFakeQuery();
    const session = new Session({ queryFn: fake.queryFn, input: INPUT, now: () => 1 });
    session.start();
    fake.emit(initMsg());
    await tick();
    session.setModel('claude-fable-5');
    // The SDK's setModel is called so the running turn switches models…
    expect(fake.modelCalls).toEqual(['claude-fable-5']);
    // …and state.model updates at once so the list row repaints (before the SDK
    // reports the resolved model on the next turn).
    expect(session.getState().model).toBe('claude-fable-5');
  });

  it('setModel(undefined) resets to the CLI default', async () => {
    const fake = makeFakeQuery();
    const session = new Session({
      queryFn: fake.queryFn,
      input: INPUT,
      now: () => 1,
      options: { model: 'claude-opus-4-8' },
    });
    session.start();
    await tick();
    // Codex のように開始イベントへモデル名を載せない provider でも、実際に渡した
    // 明示モデルは一覧へ表示できる。
    expect(session.getState().model).toBe('claude-opus-4-8');
    session.setModel(undefined);
    expect(fake.modelCalls).toEqual([undefined]);
    expect(session.getState().model).toBeUndefined();
  });

  it('a per-session model override wins over the configured default on (re)start', async () => {
    // Restored session: not started yet, so setModel only records the override;
    // consume() must use it (not deps.options.model) when the query starts.
    const fake = makeFakeQuery();
    const restored = { ...initialState(INPUT), status: 'completed' as const };
    const session = new Session({
      queryFn: fake.queryFn,
      input: INPUT,
      now: () => 1,
      options: { model: 'claude-opus-4-8' },
      restored,
    });
    session.setModel('claude-haiku-4-5');
    session.send('go');
    await tick();
    expect(fake.seenOptions()?.model).toBe('claude-haiku-4-5');
  });

  it('interrupt() calls through to the query handle', async () => {
    const fake = makeFakeQuery();
    const session = new Session({ queryFn: fake.queryFn, input: INPUT, now: () => 1 });
    session.start();
    await tick();
    await session.interrupt();
    expect(fake.wasInterrupted()).toBe(true);
  });

  // 詳細ビューの Ctrl+C。ユーザーが自分で止めたのだから失敗ではない — 再開できる
  // `interrupted` に落とし、SDK の応答を待たずに（体感のため）先に確定させる。
  it('interrupt() marks the session interrupted (resumable), not failed', async () => {
    const fake = makeFakeQuery();
    const session = new Session({ queryFn: fake.queryFn, input: INPUT, now: () => 1 });
    session.start();
    fake.emit(initMsg());
    await tick();
    expect(session.getState().status).toBe('running');
    await session.interrupt();
    expect(session.getState().status).toBe('interrupted');
    expect(session.getState().error).toBeUndefined();
    expect(session.getState().messages.at(-1)?.text).toBe('interrupted by user');
  });

  // 実測（__fixtures__/session-interrupt.jsonl）: interrupt すると CLI は
  // `error_during_execution` + `terminal_reason: 'aborted_streaming'` でターンを閉じる。
  // 診断（先に立てた interrupted）を維持し、ログ行も二重にしない。
  it('keeps interrupted when the CLI closes the turn with aborted_streaming', async () => {
    const fake = makeFakeQuery();
    const session = new Session({ queryFn: fake.queryFn, input: INPUT, now: () => 1 });
    session.start();
    fake.emit(initMsg());
    await tick();
    await session.interrupt();
    fake.emit({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      terminal_reason: 'aborted_streaming',
      total_cost_usd: 0.02,
      errors: ['[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null'],
    });
    await tick();
    expect(session.getState().status).toBe('interrupted');
    expect(session.getState().totalCostUsd).toBe(0.02);
    expect(
      session.getState().messages.filter((entry) => entry.text === 'interrupted by user'),
    ).toHaveLength(1);
  });

  it('interrupt() is a no-op once the turn is over (nothing to interrupt)', async () => {
    const fake = makeFakeQuery();
    const session = new Session({ queryFn: fake.queryFn, input: INPUT, now: () => 1 });
    session.start();
    fake.emit(initMsg());
    fake.emit(resultOk());
    await tick();
    expect(session.getState().status).toBe('completed');
    await session.interrupt();
    expect(fake.wasInterrupted()).toBe(false);
    expect(session.getState().status).toBe('completed');
  });

  // 許可/質問待ちのまま中断すると canUseTool の promise が永遠に残る。未応答の tool_use で
  // 終わる transcript は後の resume を壊すので、deny で閉じてから中断する（stop() と同じ理由）。
  it('interrupt() denies a pending permission so the transcript closes cleanly', async () => {
    const fake = makeFakeQuery();
    const session = new Session({
      queryFn: fake.queryFn,
      input: INPUT,
      now: () => 1,
      policy: () => 'ask',
    });
    session.start();
    fake.emit(initMsg());
    await tick();
    const decision = fake.call('Bash', { command: 'ls' });
    await tick();
    expect(session.getState().status).toBe('awaiting_permission');

    await session.interrupt();
    expect(await decision).toMatchObject({ behavior: 'deny' });
    expect(fake.wasInterrupted()).toBe(true);
    expect(session.getState().status).toBe('interrupted');
    expect(session.getState().pendingPermission).toBeUndefined();
  });

  it('abort() marks a running session failed and stops the stream', async () => {
    const fake = makeFakeQuery();
    const session = new Session({ queryFn: fake.queryFn, input: INPUT, now: () => 1 });
    session.start();
    fake.emit(initMsg());
    await tick();
    session.abort();
    await tick();
    expect(session.getState().status).toBe('failed');
  });

  it('marks the session failed when the query stream throws', async () => {
    const queryFn = (() => {
      // an async-iterable whose first next() rejects
      const gen = {
        next: async () => {
          throw new Error('stream boom');
        },
        [Symbol.asyncIterator]() {
          return this;
        },
        interrupt: async () => {},
      };
      return gen as unknown as Query;
    }) as unknown as QueryFn;
    const session = new Session({ queryFn, input: INPUT, now: () => 1 });
    session.start();
    await tick();
    expect(session.getState().status).toBe('failed');
    expect(session.getState().error).toContain('stream boom');
  });

  it('a dropped connection marks the session interrupted (resumable), then resumes on send', async () => {
    // Once the query has reached init (sdkSessionId known), a mid-stream throw
    // whose message looks like a connection drop is treated as `interrupted`
    // (idle & resumable) rather than `failed`. The next send() restarts the
    // (ended) consume loop with resume=sdkSessionId, continuing the SDK session.
    const optionsSeen: Options[] = [];
    let call = 0;
    // The resumed query must stay OPEN with no further output (streaming input
    // mode): a stream that just ends is an unexpected shutdown and `consume()`
    // deliberately lands such a session back in `interrupted`.
    const open = new AsyncQueue<SDKMessage>();
    const queryFn = (({ options }: { options: Options }) => {
      optionsSeen.push(options);
      const n = call++;
      const gen = (async function* () {
        if (n === 0) {
          yield { type: 'system', subtype: 'init', session_id: 'sdk-9' } as unknown as SDKMessage;
          throw new Error('terminated');
        }
        yield* open;
      })() as unknown as Query & { interrupt: () => Promise<void> };
      gen.interrupt = async () => {};
      return gen;
    }) as unknown as QueryFn;
    const session = new Session({ queryFn, input: INPUT, now: () => 1 });
    session.start();
    await tick();
    expect(session.getState().status).toBe('interrupted');
    expect(session.getState().sdkSessionId).toBe('sdk-9');
    // Not an error state — the reason is logged, but `error` stays unset.
    expect(session.getState().error).toBeUndefined();

    session.send('continue');
    await tick();
    expect(session.getState().status).toBe('running');
    // The restarted query resumed the prior SDK conversation.
    expect(optionsSeen[1]?.resume).toBe('sdk-9');
    expect(session.getState().messages.at(-1)?.text).toBe('continue');
  });

  it('queues concurrent permission requests instead of orphaning the first promise', async () => {
    // 「ずっと Running」の再現: エージェントは 1 通のメッセージで複数の tool_use を
    // 並行に投げるので、`confirm` モードでは `canUseTool` が同時に走る。単一スロットに
    // 上書きすると先の promise が永久に解決されず、provider はその 1 本を待ち続けて
    // ターン終了イベントを出さない（ストリームは生きているので最後の砦でも救えない）。
    const fake = makeFakeQuery();
    const session = new Session({
      queryFn: fake.queryFn,
      input: INPUT,
      policy: () => 'ask',
      now: () => 1,
    });
    session.start();
    fake.emit(initMsg());
    await tick();

    const first = fake.call('Bash', { command: 'one' });
    const second = fake.call('Bash', { command: 'two' });
    await tick();
    // 出ているのは先頭だけ（2 件目は待ち行列）。
    expect(session.getState().status).toBe('awaiting_permission');
    expect(session.getState().pendingPermission?.input).toEqual({ command: 'one' });

    session.allowPending();
    await tick();
    // 1 件目が解決し、続けて 2 件目が上がる（running へ戻さない）。
    expect(await first).toMatchObject({ behavior: 'allow' });
    expect(session.getState().status).toBe('awaiting_permission');
    expect(session.getState().pendingPermission?.input).toEqual({ command: 'two' });

    session.denyPending('no');
    await tick();
    expect(await second).toMatchObject({ behavior: 'deny' });
    expect(session.getState().status).toBe('running');
    expect(session.getState().pendingPermission).toBeUndefined();
  });

  it('denies every queued permission when the turn dies, not just the visible one', async () => {
    const fake = makeFakeQuery();
    const session = new Session({
      queryFn: fake.queryFn,
      input: INPUT,
      policy: () => 'ask',
      now: () => 1,
    });
    session.start();
    fake.emit(initMsg());
    await tick();
    const first = fake.call('Bash', { command: 'one' });
    const second = fake.call('Bash', { command: 'two' });
    await tick();

    fake.end();
    await tick();
    expect(session.getState().status).toBe('interrupted');
    // 未応答の tool_use を 1 つでも残すと後の resume が壊れる。
    expect(await first).toMatchObject({ behavior: 'deny' });
    expect(await second).toMatchObject({ behavior: 'deny' });
  });

  it('marks the session interrupted when the stream ends without finishing the turn', async () => {
    // 「ずっと Running」の再現: ストリームが終端イベント（result / error）を出さずに
    // 終わると、状態機械には何も届かないのでセッションが永久に `running` のまま
    // 張り付く（動作時間だけ増え続ける）。失敗ではないので resumable な
    // `interrupted` に落とし、追加指示で続けられるようにする。
    const fake = makeFakeQuery();
    const session = new Session({ queryFn: fake.queryFn, input: INPUT, now: () => 1 });
    session.start();
    fake.emit(initMsg());
    await tick();
    expect(session.getState().status).toBe('running');

    fake.end(); // ターンの結果を出さずにストリームが終わる
    await tick();
    expect(session.getState().status).toBe('interrupted');
    // 失敗ではない（`error` は立てず、ログに理由だけ残す）。
    expect(session.getState().error).toBeUndefined();
    expect(session.getState().messages.at(-1)?.text).toBe(STREAM_ENDED_DETAIL);
  });

  it('rescues a session stuck awaiting a permission the dead stream can never answer', async () => {
    const fake = makeFakeQuery();
    const session = new Session({
      queryFn: fake.queryFn,
      input: INPUT,
      policy: () => 'ask',
      now: () => 1,
    });
    session.start();
    fake.emit(initMsg());
    await tick();
    const decision = fake.call('Bash', { command: 'ls' });
    await tick();
    expect(session.getState().status).toBe('awaiting_permission');

    fake.end();
    await tick();
    expect(session.getState().status).toBe('interrupted');
    expect(session.getState().pendingPermission).toBeUndefined();
    // 未応答の tool_use で終わる transcript は後の resume を壊すので deny で閉じる。
    expect(await decision).toMatchObject({ behavior: 'deny' });
  });

  it('stop() keeps the status untouched even though the stream then ends', async () => {
    // quiet 停止（アプリ終了）は状態を変えない契約なので、最後の砦は発火しない
    // — 保存時に `restoreAs` が running → interrupted へ丸める。
    const fake = makeFakeQuery();
    const session = new Session({ queryFn: fake.queryFn, input: INPUT, now: () => 1 });
    session.start();
    fake.emit(initMsg());
    await tick();

    session.stop();
    fake.end();
    await tick();
    expect(session.getState().status).toBe('running');
  });

  it('an expired login marks the session needs_login, even before init', async () => {
    // Unlike a connection drop, this needs no sdkSessionId to be meaningful: the
    // fix is the same (log in again) whether or not the query got that far.
    const error = 'Failed to authenticate: OAuth session expired and could not be refreshed';
    const queryFn = (() => {
      const gen = {
        next: async () => {
          throw new Error(error);
        },
        [Symbol.asyncIterator]() {
          return this;
        },
        interrupt: async () => {},
      };
      return gen as unknown as Query;
    }) as unknown as QueryFn;
    const session = new Session({ queryFn, input: INPUT, now: () => 1 });
    session.start();
    await tick();
    expect(session.getState().status).toBe('needs_login');
    expect(session.getState().error).toBe(error);
  });

  it('an auth error that mentions a timeout is needs_login, not interrupted', async () => {
    // The CLI's auth failures can mention a timeout; classifying that as a dropped
    // connection would offer a plain resume when a login is what's needed.
    const queryFn = (() => {
      const gen = (async function* () {
        yield { type: 'system', subtype: 'init', session_id: 'sdk-a' } as unknown as SDKMessage;
        throw new Error('Failed to authenticate through the broker: request timed out');
      })() as unknown as Query & { interrupt: () => Promise<void> };
      gen.interrupt = async () => {};
      return gen;
    }) as unknown as QueryFn;
    const session = new Session({ queryFn, input: INPUT, now: () => 1 });
    session.start();
    await tick();
    expect(session.getState().status).toBe('needs_login');
  });

  it('a connection error before init has no session to resume, so it fails', async () => {
    // Without an sdkSessionId there is nothing to resume — a connection drop this
    // early is a genuine early failure, not a resumable interruption.
    const queryFn = (() => {
      const gen = {
        next: async () => {
          throw new Error('fetch failed');
        },
        [Symbol.asyncIterator]() {
          return this;
        },
        interrupt: async () => {},
      };
      return gen as unknown as Query;
    }) as unknown as QueryFn;
    const session = new Session({ queryFn, input: INPUT, now: () => 1 });
    session.start();
    await tick();
    expect(session.getState().status).toBe('failed');
  });

  it('forwards model/effort/permissionMode/maxBudgetUsd into the query options', async () => {
    let seen: Options | undefined;
    const queryFn = (({ options }: { options: Options }) => {
      seen = options;
      const gen = (async function* () {})() as unknown as Query & {
        interrupt: () => Promise<void>;
      };
      gen.interrupt = async () => {};
      return gen;
    }) as unknown as QueryFn;
    const session = new Session({
      queryFn,
      input: INPUT,
      now: () => 1,
      options: {
        model: 'claude-opus-4-8',
        effort: 'high',
        permissionMode: 'plan',
        maxBudgetUsd: 3,
        appendSystemPrompt: 'Open a PR when done',
      },
    });
    session.start();
    await tick();
    expect(seen?.model).toBe('claude-opus-4-8');
    expect(seen?.effort).toBe('high');
    expect(seen?.permissionMode).toBe('plan');
    expect(seen?.maxBudgetUsd).toBe(3);
    // The repo prompt is injected as systemPrompt (append-to-empty; see consume()).
    expect(seen?.systemPrompt).toBe('Open a PR when done');
  });

  it('defaults permissionMode to acceptEdits and omits absent options', async () => {
    let seen: Options | undefined;
    const queryFn = (({ options }: { options: Options }) => {
      seen = options;
      const gen = (async function* () {})() as unknown as Query & {
        interrupt: () => Promise<void>;
      };
      gen.interrupt = async () => {};
      return gen;
    }) as unknown as QueryFn;
    const session = new Session({ queryFn, input: INPUT, now: () => 1 });
    session.start();
    await tick();
    expect(seen?.permissionMode).toBe('acceptEdits');
    expect(seen?.model).toBeUndefined();
    expect(seen?.effort).toBeUndefined();
    expect(seen?.maxBudgetUsd).toBeUndefined();
    // No repo prompt configured → systemPrompt is omitted (preserves default behavior).
    expect(seen?.systemPrompt).toBeUndefined();
  });

  it.each([
    ['symlink', true],
    ['copy', false],
    ['none', false],
  ] as const)(
    'injects the shared-ignored-files notice only for ignoredFiles=%s',
    async (ignoredFiles, expected) => {
      let seen: Options | undefined;
      const queryFn = (({ options }: { options: Options }) => {
        seen = options;
        const gen = (async function* () {})() as unknown as Query & {
          interrupt: () => Promise<void>;
        };
        gen.interrupt = async () => {};
        return gen;
      }) as unknown as QueryFn;
      const session = new Session({
        queryFn,
        input: INPUT,
        now: () => 1,
        options: { ignoredFiles, appendSystemPrompt: 'Open a PR when done' },
      });
      session.start();
      await tick();
      // systemPrompt は SDK 側が union（string | string[] | preset）なので文字列に絞ってから見る。
      const systemPrompt = typeof seen?.systemPrompt === 'string' ? seen.systemPrompt : '';
      expect(systemPrompt.includes(SHARED_IGNORED_FILES_NOTICE)).toBe(expected);
      // The repo prompt rides along regardless of the worktree mode, and stays last.
      expect(systemPrompt.endsWith('Open a PR when done')).toBe(true);
    },
  );

  it('works with all optional deps defaulted (now/policy/onChange)', async () => {
    const fake = makeFakeQuery();
    const session = new Session({ queryFn: fake.queryFn, input: INPUT });
    session.start();
    fake.emit(initMsg());
    fake.emit(resultOk());
    await tick();
    fake.end();
    await tick();
    expect(session.getState().status).toBe('completed');
    // default policy auto-allows routine tools
    const result = await fake.call('Write', { file_path: 'a.txt' });
    expect(result?.behavior).toBe('allow');
  });

  it('does not emit aborted when already completed', async () => {
    const fake = makeFakeQuery();
    const onChange = vi.fn();
    const session = new Session({ queryFn: fake.queryFn, input: INPUT, now: () => 1, onChange });
    session.start();
    fake.emit(resultOk());
    await tick();
    fake.end();
    await tick();
    expect(session.getState().status).toBe('completed');
    session.abort();
    await tick();
    expect(session.getState().status).toBe('completed');
  });

  it('stop() leaves an in-flight session unchanged (resumable, not failed)', async () => {
    const fake = makeFakeQuery();
    const session = new Session({ queryFn: fake.queryFn, input: INPUT, now: () => 1 });
    session.start();
    fake.emit(initMsg());
    await tick();
    expect(session.getState().status).toBe('running');
    session.stop();
    await tick();
    // Unlike abort(), stop() must NOT flip the status to failed.
    expect(session.getState().status).toBe('running');
    expect(session.getState().error).toBeUndefined();
  });

  it('stop() denies a dangling permission prompt without changing status', async () => {
    const policy: PermissionPolicy = (name) => (name === 'Bash' ? 'ask' : 'allow');
    const fake = makeFakeQuery();
    const session = new Session({ queryFn: fake.queryFn, input: INPUT, now: () => 1, policy });
    session.start();
    await tick();
    const decision = fake.call('Bash', { command: 'ls' });
    expect(session.getState().status).toBe('awaiting_permission');
    session.stop();
    // The pending canUseTool promise resolves with a deny so the resumed
    // transcript doesn't end on an unanswered tool_use.
    await expect(decision).resolves.toEqual({ behavior: 'deny', message: 'session stopped' });
    // stop() is quiet: it doesn't run the reducer, so status is untouched.
    expect(session.getState().status).toBe('awaiting_permission');
  });

  it('denies a dangling permission prompt when the stream ends the turn mid-decision', async () => {
    // A mid-response API error (here: the stream cut, reported as a flagged
    // assistant message) ends the turn while a prompt is still open. The pending
    // canUseTool promise can never be answered, so it must be denied — otherwise
    // the transcript ends on a dangling tool_use and the later resume can error out.
    const policy: PermissionPolicy = (name) => (name === 'Bash' ? 'ask' : 'allow');
    const fake = makeFakeQuery();
    const session = new Session({ queryFn: fake.queryFn, input: INPUT, now: () => 1, policy });
    session.start();
    fake.emit(initMsg());
    await tick();
    const decision = fake.call('Bash', { command: 'ls' });
    expect(session.getState().status).toBe('awaiting_permission');
    fake.emit({
      type: 'assistant',
      error: 'server_error',
      message: { content: [{ type: 'text', text: 'API Error: Connection closed mid-response.' }] },
    });
    await tick();
    expect(session.getState().status).toBe('interrupted');
    expect(session.getState().pendingPermission).toBeUndefined();
    await expect(decision).resolves.toMatchObject({ behavior: 'deny' });
  });

  it('a restored session stays idle until send(), then resumes with the SDK session id', async () => {
    let seen: Options | undefined;
    // Stays open with no output (streaming input mode) — an immediately ending
    // stream would be an unexpected shutdown and land in `interrupted`.
    const open = new AsyncQueue<SDKMessage>();
    const queryFn = (({ options }: { options: Options }) => {
      seen = options;
      const gen = (async function* () {
        yield* open;
      })() as unknown as Query & {
        interrupt: () => Promise<void>;
      };
      gen.interrupt = async () => {};
      return gen;
    }) as unknown as QueryFn;
    const restored = { ...initialState(INPUT), status: 'completed' as const };
    const session = new Session({
      queryFn,
      input: INPUT,
      now: () => 1,
      resume: 'sdk-42',
      restored,
    });
    // Restored sessions don't call start(); no query yet.
    expect(seen).toBeUndefined();
    expect(session.getState().status).toBe('completed');
    session.send('continue please');
    await tick();
    expect(seen?.resume).toBe('sdk-42');
    expect(session.getState().status).toBe('running');
  });

  it('swaps in a generated title on a fresh start', async () => {
    const fake = makeFakeQuery();
    const session = new Session({
      queryFn: fake.queryFn,
      input: INPUT,
      now: () => 1,
      generateTitle: async () => 'Generated title',
    });
    expect(session.getState().title).toBe('t'); // placeholder before generation
    session.start();
    await tick();
    expect(session.getState().title).toBe('Generated title');
  });

  it('keeps the placeholder title when generation returns nothing', async () => {
    const fake = makeFakeQuery();
    const session = new Session({
      queryFn: fake.queryFn,
      input: INPUT,
      now: () => 1,
      generateTitle: async () => null,
    });
    session.start();
    await tick();
    expect(session.getState().title).toBe('t');
  });

  it('does not throw or change the title when generation rejects', async () => {
    const fake = makeFakeQuery();
    const session = new Session({
      queryFn: fake.queryFn,
      input: INPUT,
      now: () => 1,
      generateTitle: async () => {
        throw new Error('boom');
      },
    });
    session.start();
    await tick();
    expect(session.getState().title).toBe('t');
  });

  it('does not generate a title for restored sessions', async () => {
    const fake = makeFakeQuery();
    const generateTitle = vi.fn(async () => 'Should not run');
    const restored = { ...initialState(INPUT), status: 'completed' as const };
    const session = new Session({
      queryFn: fake.queryFn,
      input: INPUT,
      now: () => 1,
      generateTitle,
      restored,
    });
    // Restored sessions don't call start(); the first send() resumes without title gen.
    session.send('continue');
    await tick();
    expect(generateTitle).not.toHaveBeenCalled();
    expect(session.getState().title).toBe('t');
  });
});

/**
 * エージェントの途中切替（`/agent`）。worktree は provider に依存しないので、
 * Claude で始めた作業を Codex へ引き継げる — ただし**次の指示が本当に新しい
 * エージェントへ流れる**ことが前提。
 */
describe('Session.setAgent', () => {
  /** 受け取った指示文と open 回数を記録するだけのフェイクアダプタ。 */
  function recorder(id: AgentId) {
    const seen: string[] = [];
    const resumes: (string | undefined)[] = [];
    const systemPrompts: (string | undefined)[] = [];
    const adapter: AgentAdapter = {
      id,
      displayName: id,
      loginCommand: id,
      capabilities: NO_CAPABILITIES,
      open(request: AgentRunRequest) {
        resumes.push(request.resume);
        systemPrompts.push(request.options.systemPrompt);
        return {
          async *[Symbol.asyncIterator]() {
            for await (const text of request.prompt) {
              seen.push(text);
              // provider が会話 id を発行したことにする（切替の往復で resume される）。
              yield { kind: 'session_started', sessionId: `${id}-thread` } as const;
              yield { kind: 'assistant_text', text: `${id} answered: ${text}` } as const;
            }
          },
        };
      },
    };
    return { adapter, seen, resumes, systemPrompts };
  }

  it('routes the next instruction to the new agent, not the old one', async () => {
    const a = recorder('claude');
    const b = recorder('codex');
    const session = new Session({ agent: a.adapter, input: INPUT, now: () => 0 });
    session.start();
    await tick();
    expect(a.seen).toEqual(['do the thing']);

    session.setAgent(b.adapter);
    session.send('now you');
    await tick();

    // 切替前のストリームは畳まれているので、古いエージェントには届かない。
    expect(b.seen).toHaveLength(1);
    expect(b.seen[0]).toContain('# Current instruction after the switch\n\nnow you');
    expect(a.seen).toEqual(['do the thing']);
    expect(session.getState().agent).toBe('codex');
  });

  it('hands the new agent a handover briefing on the first run only', async () => {
    // 切替先は前の会話を持たない（各 CLI が自分のトランスクリプトを持つ）ので、
    // worktree の状況を systemPrompt で 1 回だけ渡す（`core/agent-handoff.ts`）。
    const a = recorder('claude');
    const b = recorder('codex');
    const session = new Session({ agent: a.adapter, input: INPUT, now: () => 0 });
    session.start();
    await tick();
    // 切替前は引き継ぎの説明を渡さない。
    expect(a.systemPrompts).toEqual([undefined]);

    session.setAgent(b.adapter);
    session.send('now you');
    await tick();

    const briefing = b.seen[0];
    expect(briefing).toContain('taking over this session from claude');
    expect(briefing).toContain('- Branch: codiva/t');
    expect(briefing).toContain('- Original task: do the thing');
    expect(briefing).toContain('User:\ndo the thing');
    expect(briefing).toContain('Assistant:\nclaude answered: do the thing');

    // 2 回目のターン（同じエージェント）には持ち越さない — 引き継ぎは済んでいる。
    session.send('and this');
    await tick();
    expect(b.seen[1]).toBe('and this');
  });

  it('resumes the previous conversation when switching back', async () => {
    const a = recorder('claude');
    const b = recorder('codex');
    const session = new Session({ agent: a.adapter, input: INPUT, now: () => 0 });
    session.start();
    await tick();

    session.setAgent(b.adapter);
    session.send('to codex');
    await tick();
    session.setAgent(a.adapter);
    session.send('back to claude');
    await tick();

    // 2 回目の Claude は自分が発行した id で resume する（別 provider の id は渡さない）。
    expect(a.resumes).toEqual([undefined, 'claude-thread']);
    expect(b.resumes).toEqual([undefined]);
    expect(a.seen[0]).toBe('do the thing');
    expect(a.seen[1]).toContain('User (codex):\nto codex');
    expect(a.seen[1]).toContain('Assistant (codex):\ncodex answered: to codex');
    expect(a.seen[1]).toContain('# Current instruction after the switch\n\nback to claude');
  });

  it('stops the in-flight turn and hands queued follow-ups to the NEW agent', async () => {
    // ターンの最中（アダプタがキューではなく provider の出力を待っている状態）を作る。
    let interrupts = 0;
    const held = new AsyncQueue<string>();
    const a: AgentAdapter = {
      id: 'claude',
      displayName: 'claude',
      loginCommand: 'claude',
      capabilities: NO_CAPABILITIES,
      open: (request) => ({
        async *[Symbol.asyncIterator]() {
          for await (const text of request.prompt) {
            seenByA.push(text);
            // ターンが動き出したことにする（実アダプタも turn の頭でこれを出す）。
            yield { kind: 'assistant_message' } as const;
            // ターン中: プロンプトではなく provider の出力を待つ。
            for await (const _ of held) {
              // 中断されるまで返らない
            }
          }
        },
        interrupt: async () => {
          interrupts += 1;
          held.close();
        },
      }),
    };
    const seenByA: string[] = [];
    const b = recorder('codex');
    const session = new Session({ agent: a, input: INPUT, now: () => 0 });
    session.start();
    await tick();
    expect(seenByA).toEqual(['do the thing']);

    // ターン実行中に追加指示 → まだ誰にも渡っていない（キューに積まれるだけ）。
    session.send('follow up');
    await tick();
    expect(seenByA).toEqual(['do the thing']);

    session.setAgent(b.adapter);
    await tick();
    await tick();

    // 走っていたターンは畳まれ、積み残しは**新しいエージェント**が実行する。
    expect(interrupts).toBe(1);
    expect(b.seen).toEqual(['follow up']);
    expect(seenByA).toEqual(['do the thing']);
  });

  it('folds an in-flight turn into interrupted instead of leaving it "Running"', async () => {
    // 切替はストリームを畳むが `agent_switched` は status を動かさない。積み残しが
    // 無いと新しいエージェントは起動しないので、これが無いと誰も先へ進めないまま
    // `running` の表示だけが残る。
    const a = recorder('claude');
    const b = recorder('codex');
    const session = new Session({ agent: a.adapter, input: INPUT, now: () => 0 });
    session.start();
    await tick();
    expect(session.getState().status).toBe('running');

    session.setAgent(b.adapter);
    await tick();
    expect(session.getState().status).toBe('interrupted');
    expect(session.getState().messages.at(-1)?.text).toBe(AGENT_SWITCH_DETAIL);

    // 再開（追加指示）は新しいエージェントで走る。
    session.send('now you');
    await tick();
    expect(b.seen).toEqual(['now you']);
    expect(session.getState().status).toBe('running');
  });

  it('is a no-op when the agent is unchanged (keeps the running stream)', async () => {
    const a = recorder('claude');
    const session = new Session({ agent: a.adapter, input: INPUT, now: () => 0 });
    session.start();
    await tick();

    session.setAgent(a.adapter);
    session.send('more');
    await tick();

    expect(a.resumes).toEqual([undefined]); // ストリームは張り替わっていない
    expect(a.seen).toEqual(['do the thing', 'more']);
  });
});
