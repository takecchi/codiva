import type { Options, PermissionResult, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it, vi } from 'vitest';
import { AsyncQueue } from '@/core/async-queue';
import { type PermissionPolicy, type QueryFn, Session } from '@/core/session';
import { initialState } from '@/core/status-reducer';
import type { CreateSessionInput } from '@/core/types';

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

  it('a restored session stays idle until send(), then resumes with the SDK session id', async () => {
    let seen: Options | undefined;
    const queryFn = (({ options }: { options: Options }) => {
      seen = options;
      const gen = (async function* () {})() as unknown as Query & {
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
