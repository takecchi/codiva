import type { Options, PermissionResult, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it, vi } from 'vitest';
import { AsyncQueue } from '@/core/async-queue';
import { type PermissionPolicy, type QueryFn, Session } from '@/core/session';
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
  const captured: { canUseTool?: CanUseTool } = {};
  let interrupted = false;

  const queryFn = ({ options }: { prompt: AsyncIterable<unknown>; options: Options }): Query => {
    captured.canUseTool = options.canUseTool as unknown as CanUseTool;
    const gen = (async function* () {
      yield* out;
    })() as unknown as Query & { interrupt: () => Promise<void> };
    gen.interrupt = async () => {
      interrupted = true;
    };
    return gen;
  };

  return {
    queryFn,
    emit: (m: unknown) => out.push(m as SDKMessage),
    end: () => out.close(),
    call: (name: string, input: Record<string, unknown>) => captured.canUseTool?.(name, input),
    wasInterrupted: () => interrupted,
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

  it('passes a model override into the query options', async () => {
    let seenModel: string | undefined;
    const queryFn = (({ options }: { options: { model?: string } }) => {
      seenModel = options.model;
      const gen = (async function* () {})() as unknown as Query & {
        interrupt: () => Promise<void>;
      };
      gen.interrupt = async () => {};
      return gen;
    }) as unknown as QueryFn;
    const session = new Session({ queryFn, input: INPUT, now: () => 1, model: 'claude-opus-4-8' });
    session.start();
    await tick();
    expect(seenModel).toBe('claude-opus-4-8');
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
});
