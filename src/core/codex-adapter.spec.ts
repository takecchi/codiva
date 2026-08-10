import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '@/core/agent-events';
import type { AgentAdapter, AgentRunOptions, AgentRunRequest } from '@/core/agent-ports';
import { AsyncQueue } from '@/core/async-queue';
import {
  CODEX_CAPABILITIES,
  type CodexProcess,
  type CodexSpawn,
  type CodexSpawnRequest,
  createCodexAdapter,
} from '@/core/codex-adapter';

const tick = () => new Promise((r) => setTimeout(r, 0));

/** Wait until `cond` holds, giving the adapter's generator time to run. */
async function waitFor(cond: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (cond()) {
      return;
    }
    await tick();
  }
  throw new Error(`timed out waiting for ${label}`);
}

interface FakeExit {
  code?: number | null;
  stderr?: string;
}

interface FakeProcess {
  proc: CodexProcess;
  emit(event: unknown): void;
  /** stdout が尽きた（プロセスが終わった）。 */
  end(): void;
  wasKilled(): boolean;
}

/** A `codex exec` process that never spawns anything: stdout is a queue we push to. */
function makeFakeProcess(exit: FakeExit): FakeProcess {
  const out = new AsyncQueue<unknown>();
  let killed = false;
  return {
    proc: {
      [Symbol.asyncIterator]: () => out[Symbol.asyncIterator](),
      kill: () => {
        killed = true;
        out.close();
      },
      result: () => ({ code: exit.code ?? 0, stderr: exit.stderr ?? '' }),
    },
    emit: (event: unknown) => out.push(event),
    end: () => out.close(),
    wasKilled: () => killed,
  };
}

/** Captures every spawn request and hands back a controllable fake process. */
function makeFakeCodex(exits: readonly FakeExit[] = []) {
  const requests: CodexSpawnRequest[] = [];
  const procs: FakeProcess[] = [];
  const spawn: CodexSpawn = (request) => {
    const fake = makeFakeProcess(exits[requests.length] ?? {});
    requests.push(request);
    procs.push(fake);
    return fake.proc;
  };
  return {
    spawn,
    requests,
    procs,
    /** 起動された n 本目のプロセス（1 origin ではなく index）。 */
    at: (index: number) => {
      const fake = procs[index];
      if (!fake) {
        throw new Error(`no process spawned at index ${index}`);
      }
      return fake;
    },
  };
}

/** Open a run and drain it in the background (what `Session` does). */
function drive(adapter: AgentAdapter, over: Partial<AgentRunRequest> = {}) {
  const prompts = new AsyncQueue<string>();
  const abortController = new AbortController();
  const request: AgentRunRequest = {
    cwd: '/tmp/wt',
    prompt: prompts,
    options: {},
    requestPermission: async () => ({ behavior: 'deny' }),
    abortController,
    ...over,
  };
  const run = adapter.open(request);
  const events: AgentEvent[] = [];
  const done = (async () => {
    for await (const event of run) {
      events.push(event);
    }
  })();
  return { run, prompts, events, done, abortController };
}

const threadStarted = (id: string) => ({ type: 'thread.started', thread_id: id });
const turnCompleted = { type: 'turn.completed', usage: { input_tokens: 1 } };

describe('CODEX_CAPABILITIES', () => {
  it.each([
    // exec の JSON モードは承認要求を上げられない（CLI が自動 reject する）。
    ['permissions', false],
    ['interrupt', true],
    ['setModel', true],
    ['resume', true],
    ['modelCatalog', true],
    // `turn.completed` はトークン数だけで、アカウント使用状況も USD も運ばない。
    ['usage', false],
    ['cost', false],
    // rollout ファイルは形式が別なのでログ復元は未対応。
    ['transcript', false],
  ] as const)('%s is %s', (key, expected) => {
    expect(CODEX_CAPABILITIES[key]).toBe(expected);
  });
});

describe('createCodexAdapter identity', () => {
  it('exposes the Codex provider metadata and its own error classifier', () => {
    const { spawn } = makeFakeCodex();
    const adapter = createCodexAdapter({ spawn });
    expect(adapter.id).toBe('codex');
    expect(adapter.displayName).toBe('Codex');
    expect(adapter.loginCommand).toBe('codex');
    expect(adapter.capabilities).toBe(CODEX_CAPABILITIES);
    expect(adapter.classifyError?.('api error 401: Unauthorized')).toBe('auth');
  });
});

describe('createCodexAdapter turn loop', () => {
  it('starts fresh, then resumes the thread id it saw for the next prompt', async () => {
    const codex = makeFakeCodex();
    const adapter = createCodexAdapter({ spawn: codex.spawn });
    const { prompts, events, done } = drive(adapter);

    prompts.push('first');
    await waitFor(() => codex.requests.length === 1, 'the first spawn');
    // 初回は resume 無し = 新しいスレッド。
    expect(codex.requests[0]?.resume).toBeUndefined();
    expect(codex.requests[0]?.cwd).toBe('/tmp/wt');
    codex.at(0).emit(threadStarted('th-1'));
    codex.at(0).emit(turnCompleted);
    codex.at(0).end();

    await waitFor(() => events.some((e) => e.kind === 'turn_completed'), 'the first turn to end');

    prompts.push('second');
    await waitFor(() => codex.requests.length === 2, 'the second spawn');
    // `codex exec` は 1 ターン 1 プロセスなので、続きは resume で繋ぐ。
    expect(codex.requests[1]?.resume).toBe('th-1');
    codex.at(1).emit(turnCompleted);
    codex.at(1).end();

    prompts.close();
    await done;
    expect(events.filter((e) => e.kind === 'turn_completed')).toHaveLength(2);
  });

  it('prepends the systemPrompt to the first prompt only', async () => {
    const codex = makeFakeCodex();
    const adapter = createCodexAdapter({ spawn: codex.spawn });
    const options: AgentRunOptions = { systemPrompt: 'WORKTREE NOTES', effort: 'high' };
    const { prompts, events, done } = drive(adapter, { options });

    prompts.push('do the thing');
    await waitFor(() => codex.requests.length === 1, 'the first spawn');
    expect(codex.requests[0]?.prompt).toBe('WORKTREE NOTES\n\n---\n\ndo the thing');
    expect(codex.requests[0]?.effort).toBe('high');
    codex.at(0).emit(threadStarted('th-1'));
    codex.at(0).emit(turnCompleted);
    codex.at(0).end();
    await waitFor(() => events.some((e) => e.kind === 'turn_completed'), 'the first turn to end');

    prompts.push('and now this');
    await waitFor(() => codex.requests.length === 2, 'the second spawn');
    // 2 ターン目は同じスレッドを resume するのでモデルは既に読んでいる。
    expect(codex.requests[1]?.prompt).toBe('and now this');

    codex.at(1).end();
    prompts.close();
    await done;
  });

  it('does not re-send the systemPrompt when the session was restored (resume given)', async () => {
    const codex = makeFakeCodex();
    const adapter = createCodexAdapter({ spawn: codex.spawn });
    const { prompts, done } = drive(adapter, {
      resume: 'th-restored',
      options: { systemPrompt: 'WORKTREE NOTES' },
    });

    prompts.push('carry on');
    await waitFor(() => codex.requests.length === 1, 'the spawn');
    expect(codex.requests[0]?.resume).toBe('th-restored');
    expect(codex.requests[0]?.prompt).toBe('carry on');

    codex.at(0).end();
    prompts.close();
    await done;
  });

  it('passes the sandbox settings through to every spawn', async () => {
    const codex = makeFakeCodex();
    const adapter = createCodexAdapter({
      spawn: codex.spawn,
      sandbox: 'read-only',
      networkAccess: false,
    });
    const { prompts, done } = drive(adapter);

    prompts.push('look around');
    await waitFor(() => codex.requests.length === 1, 'the spawn');
    expect(codex.requests[0]).toMatchObject({ sandbox: 'read-only', networkAccess: false });

    codex.at(0).end();
    prompts.close();
    await done;
  });

  it('defaults to a writable workspace with network access', async () => {
    const codex = makeFakeCodex();
    const adapter = createCodexAdapter({ spawn: codex.spawn });
    const { prompts, done } = drive(adapter);

    prompts.push('write something');
    await waitFor(() => codex.requests.length === 1, 'the spawn');
    expect(codex.requests[0]).toMatchObject({ sandbox: 'workspace-write', networkAccess: true });

    codex.at(0).end();
    prompts.close();
    await done;
  });
});

describe('createCodexAdapter completion fallback', () => {
  it('completes the turn when the process exits cleanly without a terminal event', async () => {
    // 実測: 稀に `turn.completed` が来ないまま stdout が閉じる。終了コードで補う。
    const codex = makeFakeCodex([{ code: 0 }]);
    const adapter = createCodexAdapter({ spawn: codex.spawn });
    const { prompts, events, done } = drive(adapter);

    prompts.push('go');
    await waitFor(() => codex.requests.length === 1, 'the spawn');
    codex.at(0).emit(threadStarted('th-1'));
    codex.at(0).end();

    prompts.close();
    await done;
    expect(events.at(-1)).toEqual({ kind: 'turn_completed', text: '' });
  });

  it('classifies the stderr of a non-zero exit (auth wording → needs a login)', async () => {
    const codex = makeFakeCodex([
      { code: 1, stderr: '\nERROR: Not logged in. Run `codex login`.\n' },
    ]);
    const adapter = createCodexAdapter({ spawn: codex.spawn });
    const { prompts, events, done } = drive(adapter);

    prompts.push('go');
    await waitFor(() => codex.requests.length === 1, 'the spawn');
    codex.at(0).end();

    prompts.close();
    await done;
    expect(events.at(-1)).toEqual({
      kind: 'turn_stopped',
      cause: 'auth',
      detail: 'ERROR: Not logged in. Run `codex login`.',
    });
  });

  it('falls back to the exit code when the process said nothing at all', async () => {
    const codex = makeFakeCodex([{ code: 127 }]);
    const adapter = createCodexAdapter({ spawn: codex.spawn });
    const { prompts, events, done } = drive(adapter);

    prompts.push('go');
    await waitFor(() => codex.requests.length === 1, 'the spawn');
    codex.at(0).end();

    prompts.close();
    await done;
    expect(events.at(-1)).toMatchObject({
      kind: 'turn_stopped',
      cause: 'failed',
      detail: 'codex exited with code 127',
    });
  });
});

describe('createCodexAdapter interrupt', () => {
  it('kills the process and stays silent (Session owns the interrupted state)', async () => {
    // 終了コードは異常のまま: ガードが無ければ turn_stopped が出てしまう組み合わせ。
    const codex = makeFakeCodex([{ code: null, stderr: '' }]);
    const adapter = createCodexAdapter({ spawn: codex.spawn });
    const { run, prompts, events, done } = drive(adapter);

    prompts.push('long job');
    await waitFor(() => codex.requests.length === 1, 'the spawn');
    codex.at(0).emit(threadStarted('th-1'));
    await waitFor(() => events.some((e) => e.kind === 'session_started'), 'the thread id');

    await run.interrupt?.();
    expect(codex.at(0).wasKilled()).toBe(true);

    prompts.close();
    await done;
    // 中断は失敗ではない。Session が先に `interrupted` を確定させている。
    expect(events.some((e) => e.kind === 'turn_stopped')).toBe(false);
    expect(events.some((e) => e.kind === 'turn_completed')).toBe(false);
  });

  it('resumes the same thread on the next prompt after an interrupt', async () => {
    const codex = makeFakeCodex([{ code: null }]);
    const adapter = createCodexAdapter({ spawn: codex.spawn });
    const { run, prompts, events, done } = drive(adapter);

    prompts.push('long job');
    await waitFor(() => codex.requests.length === 1, 'the spawn');
    codex.at(0).emit(threadStarted('th-1'));
    await waitFor(() => events.some((e) => e.kind === 'session_started'), 'the thread id');
    await run.interrupt?.();

    prompts.push('never mind, do this instead');
    await waitFor(() => codex.requests.length === 2, 'the second spawn');
    expect(codex.requests[1]?.resume).toBe('th-1');

    codex.at(1).end();
    prompts.close();
    await done;
  });

  it('aborting the controller kills the running process and ends the stream', async () => {
    const codex = makeFakeCodex([{ code: null }]);
    const adapter = createCodexAdapter({ spawn: codex.spawn });
    const { prompts, abortController, done } = drive(adapter);

    prompts.push('long job');
    await waitFor(() => codex.requests.length === 1, 'the spawn');
    abortController.abort();
    expect(codex.at(0).wasKilled()).toBe(true);

    prompts.close();
    await done;
    // 中断されたので次のプロセスは起きない。
    expect(codex.requests).toHaveLength(1);
  });
});

describe('createCodexAdapter setModel', () => {
  it('applies the new model from the next spawn on (1 turn = 1 process)', async () => {
    const codex = makeFakeCodex();
    const adapter = createCodexAdapter({ spawn: codex.spawn });
    const { run, prompts, events, done } = drive(adapter, { options: { model: 'gpt-5' } });

    prompts.push('first');
    await waitFor(() => codex.requests.length === 1, 'the first spawn');
    expect(codex.requests[0]?.model).toBe('gpt-5');

    await run.setModel?.('gpt-5-codex');
    codex.at(0).emit(threadStarted('th-1'));
    codex.at(0).emit(turnCompleted);
    codex.at(0).end();
    await waitFor(() => events.some((e) => e.kind === 'turn_completed'), 'the first turn to end');

    prompts.push('second');
    await waitFor(() => codex.requests.length === 2, 'the second spawn');
    expect(codex.requests[1]?.model).toBe('gpt-5-codex');

    codex.at(1).end();
    prompts.close();
    await done;
  });
});

describe('createCodexAdapter stream mapping', () => {
  it('drops junk lines and maps the rest through parseCodexEvent', async () => {
    const codex = makeFakeCodex();
    const adapter = createCodexAdapter({ spawn: codex.spawn });
    const { prompts, events, done } = drive(adapter);

    prompts.push('go');
    await waitFor(() => codex.requests.length === 1, 'the spawn');
    const proc = codex.at(0);
    proc.emit(null);
    proc.emit({ nope: true });
    proc.emit({ type: 'thread.finished' });
    // 必須フィールドを欠いた行。通すとパースが throw してターンのストリームごと死ぬ。
    proc.emit({ type: 'turn.failed' });
    proc.emit({ type: 'item.started' });
    proc.emit(threadStarted('th-1'));
    proc.emit({ type: 'turn.started' });
    proc.emit({
      type: 'item.completed',
      item: { id: 'item_0', type: 'agent_message', text: 'hi' },
    });
    proc.emit(turnCompleted);
    proc.end();

    prompts.close();
    await done;
    expect(events).toEqual([
      { kind: 'session_started', sessionId: 'th-1' },
      { kind: 'assistant_message' },
      { kind: 'assistant_text', text: 'hi' },
      { kind: 'turn_completed', text: '' },
    ]);
  });

  it('forwards the title generator it was given', async () => {
    const codex = makeFakeCodex();
    const adapter = createCodexAdapter({
      spawn: codex.spawn,
      generateTitle: async (prompt) => `title: ${prompt}`,
    });
    expect(await adapter.generateTitle?.('fix the bug')).toBe('title: fix the bug');
  });
});
