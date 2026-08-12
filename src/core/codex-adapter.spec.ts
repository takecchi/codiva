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

describe('createCodexAdapter resolveModel', () => {
  // `codex exec --json` はモデル名をひとことも運ばない（実測 0.147.0）。`--model` を
  // 明示していないセッションのモデル欄は、この問い合わせでしか埋まらない。
  it('reports the resolved model for a session running on the CLI default', async () => {
    const codex = makeFakeCodex();
    const seen: string[] = [];
    // `turn_context` はターン開始時に書かれるので、短いターンだと解決がストリームの
    // 終わりに間に合わない。その**遅れて届く**経路をここで固定する（間に合わなければ
    // 1 ターンで idle になったセッションのモデル欄が次の指示まで空のままになる）。
    let answer = (_model: string) => {};
    const pending = new Promise<string>((resolve) => {
      answer = resolve;
    });
    const adapter = createCodexAdapter({
      spawn: codex.spawn,
      resolveModel: (threadId, waitMs) => {
        seen.push(`${threadId}:${waitMs > 5_000 ? 'long' : 'short'}`);
        return pending;
      },
    });
    const { prompts, events, done } = drive(adapter);

    prompts.push('go');
    await waitFor(() => codex.requests.length === 1, 'the spawn');
    // 明示していないので `--model` は渡らない（CLI の既定に任せる）。
    expect(codex.requests[0]?.model).toBeUndefined();
    codex.at(0).emit(threadStarted('th-1'));
    codex.at(0).emit(turnCompleted);
    codex.at(0).end();
    await waitFor(() => events.some((e) => e.kind === 'turn_completed'), 'the turn to end');

    answer('gpt-5.6-sol');
    await waitFor(() => events.some((e) => e.kind === 'model_resolved'), 'the resolved model');
    // ターン中は長い猶予で聞き（誰も待たない）、ターン終了後は短い猶予で引き直す
    // （そこでは既に書かれているので当たれば即返る）。
    expect(seen).toEqual(['th-1:long', 'th-1:short']);
    expect(events.find((e) => e.kind === 'model_resolved')).toEqual({
      kind: 'model_resolved',
      model: 'gpt-5.6-sol',
    });
    // 終端イベントの**あと**に流れる（`model_resolved` は status を触らないので、
    // 完了したセッションを `running` に巻き戻さない）。
    const kinds = events.map((e) => e.kind);
    expect(kinds.indexOf('model_resolved')).toBeGreaterThan(kinds.indexOf('turn_completed'));

    prompts.close();
    await done;
  });

  it('does not ask when the model was chosen explicitly (Session already showed it)', async () => {
    const codex = makeFakeCodex();
    let asked = 0;
    const adapter = createCodexAdapter({
      spawn: codex.spawn,
      resolveModel: async () => {
        asked += 1;
        return 'gpt-5.6-sol';
      },
    });
    const { prompts, events, done } = drive(adapter, { options: { model: 'gpt-5.4-mini' } });

    prompts.push('go');
    await waitFor(() => codex.requests.length === 1, 'the spawn');
    codex.at(0).emit(threadStarted('th-1'));
    codex.at(0).emit(turnCompleted);
    codex.at(0).end();
    await waitFor(() => events.some((e) => e.kind === 'turn_completed'), 'the turn to end');

    expect(asked).toBe(0);
    expect(events.some((e) => e.kind === 'model_resolved')).toBe(false);

    prompts.close();
    await done;
  });

  it('asks once per thread, and again after /model resets to the CLI default', async () => {
    const codex = makeFakeCodex();
    const asked: string[] = [];
    const adapter = createCodexAdapter({
      spawn: codex.spawn,
      resolveModel: async (threadId) => {
        asked.push(threadId);
        return 'gpt-5.6-sol';
      },
    });
    const { run, prompts, events, done } = drive(adapter);

    prompts.push('first');
    await waitFor(() => codex.requests.length === 1, 'the first spawn');
    codex.at(0).emit(threadStarted('th-1'));
    codex.at(0).emit(turnCompleted);
    codex.at(0).end();
    await waitFor(() => events.some((e) => e.kind === 'model_resolved'), 'the first answer');

    // 同じスレッドを resume する 2 ターン目では問い合わせ直さない。
    prompts.push('second');
    await waitFor(() => codex.requests.length === 2, 'the second spawn');
    codex.at(1).emit(threadStarted('th-1'));
    codex.at(1).emit(turnCompleted);
    codex.at(1).end();
    await waitFor(() => events.filter((e) => e.kind === 'turn_completed').length === 2, 'turn 2');
    expect(asked).toEqual(['th-1']);

    // 明示指定 → 既定へ戻す、と往復したら引き直す（前の答えは別モデルのものかもしれない）。
    await run.setModel?.('gpt-5.4-mini');
    await run.setModel?.(undefined);
    prompts.push('third');
    await waitFor(() => codex.requests.length === 3, 'the third spawn');
    codex.at(2).emit(threadStarted('th-1'));
    codex.at(2).emit(turnCompleted);
    codex.at(2).end();
    await waitFor(() => asked.length === 2, 'the re-ask');

    prompts.close();
    await done;
  });

  // 問い合わせ中に `/model` で選び直されたら、届いた答えはもう古い。捨てないと
  // 「次のターンは選んだモデルで動くのに、一覧には既定のモデル名が出たまま」になり、
  // Codex は二度とモデルを報告しないので**永久にずれたまま** state.json にも焼き付く。
  it('drops the answer when /model overtook it while the lookup was in flight', async () => {
    const codex = makeFakeCodex();
    let answer = (_model: string) => {};
    const pending = new Promise<string>((resolve) => {
      answer = resolve;
    });
    const adapter = createCodexAdapter({ spawn: codex.spawn, resolveModel: () => pending });
    const { run, prompts, events, done } = drive(adapter);

    prompts.push('go');
    await waitFor(() => codex.requests.length === 1, 'the spawn');
    codex.at(0).emit(threadStarted('th-1'));
    // **答えが先に届き**（ここで保留される）、そのあとユーザーが明示選択する、という
    // 順序でないと再現しない（この順序を崩すと問い合わせ側のガードだけで素通りする）。
    answer('gpt-5.6-sol');
    for (let i = 0; i < 5; i += 1) {
      await tick();
    }
    await run.setModel?.('gpt-5.4-mini');
    codex.at(0).emit(turnCompleted);
    codex.at(0).end();
    await waitFor(() => events.some((e) => e.kind === 'turn_completed'), 'the turn to end');

    expect(events.some((e) => e.kind === 'model_resolved')).toBe(false);

    prompts.close();
    await done;
  });

  // `/agent` で切り替えると `run.interrupt()` が呼ばれ、`agent_switched` が model を
  // クリアする。遅れて届いた Codex の slug をそこへ流すと、Claude のセッションに
  // Codex のモデル名が出たまま永続化される。
  it('drops the answer when the run was interrupted (agent switch / Ctrl+C)', async () => {
    const codex = makeFakeCodex();
    let answer = (_model: string) => {};
    const pending = new Promise<string>((resolve) => {
      answer = resolve;
    });
    const adapter = createCodexAdapter({ spawn: codex.spawn, resolveModel: () => pending });
    const { run, prompts, events, done } = drive(adapter);

    prompts.push('go');
    await waitFor(() => codex.requests.length === 1, 'the spawn');
    codex.at(0).emit(threadStarted('th-1'));
    await run.interrupt?.();
    answer('gpt-5.6-sol');
    codex.at(0).end();
    await waitFor(() => codex.at(0).wasKilled(), 'the process to be killed');
    prompts.close();
    await done;

    expect(events.some((e) => e.kind === 'model_resolved')).toBe(false);
  });

  // **これが本命の回帰テスト。** CLI が解決済みモデルを書き出すのは `thread.started` から
  // 約 3 秒後（実測 0.147.0）なので、ターン中に張った問い合わせは空振りしうる。ターンが
  // 終わった時点なら必ず書かれているので、そこで引き直せば当たる。これが無いと
  // 「Codex でセッションを始めてもモデル欄が空のまま」になる（実際にそうなっていた）。
  it('re-asks at the end of the turn when the in-turn lookup was too early', async () => {
    const codex = makeFakeCodex();
    const answers: (string | undefined)[] = [undefined, 'gpt-5.6-sol'];
    let asked = 0;
    const adapter = createCodexAdapter({
      spawn: codex.spawn,
      resolveModel: async () => answers[asked++],
    });
    const { prompts, events, done } = drive(adapter);

    // 1 ターンで終わって idle になるセッション（次の指示は来ない）。
    prompts.push('only turn');
    await waitFor(() => codex.requests.length === 1, 'the spawn');
    codex.at(0).emit(threadStarted('th-1'));
    codex.at(0).emit(turnCompleted);
    codex.at(0).end();
    await waitFor(() => events.some((e) => e.kind === 'model_resolved'), 'the tail lookup');
    expect(asked).toBe(2);
    const kinds = events.map((e) => e.kind);
    expect(kinds.indexOf('model_resolved')).toBeGreaterThan(kinds.indexOf('turn_completed'));

    prompts.close();
    await done;
  });

  // 空振り（`turn_context` がまだ書かれていない）を記憶してしまうと、次のターンなら
  // すぐ読めるのに二度と引き直さないセッションになる。
  it('retries on the next turn when the rollout was not readable yet', async () => {
    const codex = makeFakeCodex();
    // ターン 1 は 2 回（ターン中 + 終了後）とも空振りし、ターン 2 で読めるようになる。
    const answers: (string | undefined)[] = [undefined, undefined, 'gpt-5.6-sol'];
    let asked = 0;
    const adapter = createCodexAdapter({
      spawn: codex.spawn,
      resolveModel: async () => answers[asked++],
    });
    const { prompts, events, done } = drive(adapter);

    prompts.push('first');
    await waitFor(() => codex.requests.length === 1, 'the first spawn');
    codex.at(0).emit(threadStarted('th-1'));
    codex.at(0).emit(turnCompleted);
    codex.at(0).end();
    await waitFor(() => events.some((e) => e.kind === 'turn_completed'), 'the first turn');
    expect(events.some((e) => e.kind === 'model_resolved')).toBe(false);

    prompts.push('second');
    await waitFor(() => codex.requests.length === 2, 'the second spawn');
    codex.at(1).emit(threadStarted('th-1'));
    codex.at(1).emit(turnCompleted);
    codex.at(1).end();
    await waitFor(() => events.some((e) => e.kind === 'model_resolved'), 'the retry to answer');
    expect(asked).toBe(3);

    prompts.close();
    await done;
  });

  // ただし、そもそも取れない環境で毎ターン探し回らない。
  it('stops asking after a few misses (never-readable rollout)', async () => {
    const codex = makeFakeCodex();
    let asked = 0;
    const adapter = createCodexAdapter({
      spawn: codex.spawn,
      resolveModel: async () => {
        asked += 1;
        return undefined;
      },
    });
    const { prompts, events, done } = drive(adapter);

    for (let turn = 0; turn < 5; turn += 1) {
      prompts.push(`turn ${turn}`);
      await waitFor(() => codex.requests.length === turn + 1, `spawn ${turn}`);
      codex.at(turn).emit(threadStarted('th-1'));
      codex.at(turn).emit(turnCompleted);
      codex.at(turn).end();
      await waitFor(
        () => events.filter((e) => e.kind === 'turn_completed').length === turn + 1,
        `turn ${turn} to end`,
      );
    }
    // 予算は 4 回ぶん（1 ターンにつきターン中 + 終了後の 2 回）。5 ターン回しても
    // それ以上は探しに行かない。
    expect(asked).toBe(4);

    prompts.close();
    await done;
  });

  // 上限は「読めない環境で毎ターン探し回らない」ためのもので、ユーザーが明示的に
  // 既定へ戻す操作まで縛るためのものではない。予算を戻さないと、序盤に空振りして
  // 使い切ったセッションは「明示モデル → 既定へ戻す」としてもモデル欄が明示モデルの
  // まま二度と更新されない。
  it('restores the probe budget when /model goes back to the CLI default', async () => {
    const codex = makeFakeCodex();
    let asked = 0;
    const adapter = createCodexAdapter({
      spawn: codex.spawn,
      resolveModel: async () => {
        asked += 1;
        // 最初の 4 回（= 上限ぶん）は空振り、そのあとは読める。
        return asked > 4 ? 'gpt-5.6-sol' : undefined;
      },
    });
    const { run, prompts, events, done } = drive(adapter);

    const turn = async (index: number) => {
      prompts.push(`turn ${index}`);
      await waitFor(() => codex.requests.length === index + 1, `spawn ${index}`);
      codex.at(index).emit(threadStarted('th-1'));
      codex.at(index).emit(turnCompleted);
      codex.at(index).end();
      await waitFor(
        () => events.filter((e) => e.kind === 'turn_completed').length === index + 1,
        `turn ${index} to end`,
      );
    };

    // 2 ターン（= 4 回の問い合わせ）で予算を使い切る。3 ターン目は探しに行かない。
    for (let i = 0; i < 3; i += 1) {
      await turn(i);
    }
    expect(asked).toBe(4);
    expect(events.some((e) => e.kind === 'model_resolved')).toBe(false);

    // 明示モデルを選び、また既定へ戻す。
    await run.setModel?.('gpt-5.4-mini');
    await run.setModel?.(undefined);
    await turn(3);

    expect(asked).toBe(5);
    expect(events.find((e) => e.kind === 'model_resolved')).toEqual({
      kind: 'model_resolved',
      model: 'gpt-5.6-sol',
    });

    prompts.close();
    await done;
  });

  it('survives a failed lookup (the model column just stays empty)', async () => {
    const codex = makeFakeCodex();
    const adapter = createCodexAdapter({
      spawn: codex.spawn,
      resolveModel: async () => {
        throw new Error('no rollout directory');
      },
    });
    const { prompts, events, done } = drive(adapter);

    prompts.push('go');
    await waitFor(() => codex.requests.length === 1, 'the spawn');
    codex.at(0).emit(threadStarted('th-1'));
    codex.at(0).emit(turnCompleted);
    codex.at(0).end();
    await waitFor(() => events.some((e) => e.kind === 'turn_completed'), 'the turn to end');

    expect(events.some((e) => e.kind === 'model_resolved')).toBe(false);

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

  /**
   * リグレッション: 初回のターンが `thread.started` より前に落ちる（`codex` 未導入・
   * 未ログイン・不正な `--model`）と threadId が付かず、次のターンは**新しいスレッド**に
   * なる。フラグで latch していると、そこで systemPrompt を前置しそこねて
   * **一度も渡らないセッション**になる（symlink 共有の注意書きが落ちる = 実害が大きい）。
   */
  it('re-sends the systemPrompt when the first turn died before thread.started', async () => {
    const codex = makeFakeCodex([{ code: 1, stderr: 'not logged in' }, {}]);
    const adapter = createCodexAdapter({ spawn: codex.spawn });
    const { prompts, events, done } = drive(adapter, {
      options: { systemPrompt: 'WORKTREE NOTES' },
    });

    prompts.push('first');
    await waitFor(() => codex.requests.length === 1, 'the first spawn');
    expect(codex.requests[0]?.prompt).toBe('WORKTREE NOTES\n\n---\n\nfirst');
    // thread.started を出さずに終了（起動に失敗したのと同じ形）。
    codex.at(0).end();
    await waitFor(() => events.some((e) => e.kind === 'turn_stopped'), 'the failed turn');

    prompts.push('second');
    await waitFor(() => codex.requests.length === 2, 'the second spawn');
    // resume 先が無い = 新しいスレッドなので、systemPrompt はもう一度必要。
    expect(codex.requests[1]?.resume).toBeUndefined();
    expect(codex.requests[1]?.prompt).toBe('WORKTREE NOTES\n\n---\n\nsecond');

    codex.at(1).end();
    prompts.close();
    await done;
  });

  /**
   * リグレッション: 消費側が途中で捨てた（`run.return()`）ときにプロセスを殺さないと、
   * `codex exec` が worktree を触ったまま残る。パイプが壊れても Rust は SIGPIPE を
   * 無視するので、放っておいても死なない。
   */
  it('kills the child when the consumer abandons the stream mid-turn', async () => {
    const codex = makeFakeCodex();
    const adapter = createCodexAdapter({ spawn: codex.spawn });
    const prompts = new AsyncQueue<string>();
    const run = adapter.open({
      cwd: '/tmp/wt',
      prompt: prompts,
      options: {},
      requestPermission: async () => ({ behavior: 'allow' }),
      abortController: new AbortController(),
    });

    // 1 イベントだけ受け取って break する（= generator を捨てる）。
    prompts.push('do the thing');
    const iterate = (async () => {
      for await (const _event of run) {
        break;
      }
    })();
    await waitFor(() => codex.requests.length === 1, 'the spawn');
    codex.at(0).emit(threadStarted('th-1'));
    await iterate;

    expect(codex.at(0).wasKilled()).toBe(true);
  });
});
