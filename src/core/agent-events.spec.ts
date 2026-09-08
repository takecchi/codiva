import { describe, expect, it } from 'vitest';
import { type AgentEvent, applyAgentEvent } from '@/core/agent-events';
import { initialState } from '@/core/status-reducer';
import type { CreateSessionInput, SessionState } from '@/core/types';

const BASE: CreateSessionInput = {
  id: 's1',
  title: 'test',
  prompt: 'do it',
  branch: 'codiva/test',
  worktreePath: '/tmp/wt',
  startedAt: 0,
};

const running = (over: Partial<SessionState> = {}): SessionState => ({
  ...initialState(BASE),
  status: 'running',
  ...over,
});

/** 1 本の列を順に畳む（アダプタが渡す形と同じ）。 */
const fold = (state: SessionState, events: AgentEvent[], at = 1, agent?: 'claude' | 'codex') =>
  events.reduce((s, e) => applyAgentEvent(s, e, at, agent), state);

describe('applyAgentEvent / session_started', () => {
  it('records the resume id under the driving agent so a switch can come back to it', () => {
    const s = applyAgentEvent(
      running(),
      { kind: 'session_started', sessionId: 'cx-1', model: 'gpt-5' },
      1,
      'codex',
    );
    expect(s.sdkSessionId).toBe('cx-1');
    expect(s.agentSessions).toEqual({ codex: 'cx-1' });
    expect(s.model).toBe('gpt-5');
  });

  it('leaves agentSessions untouched when no agent is attributed (single-agent session)', () => {
    const s = applyAgentEvent(running(), { kind: 'session_started', sessionId: 'c-1' }, 1);
    expect(s.sdkSessionId).toBe('c-1');
    expect(s.agentSessions).toBeUndefined();
  });

  it('keeps a blocked session in awaiting_* rather than flipping it back to running', () => {
    const blocked = running({
      status: 'awaiting_input',
      pendingPermission: { id: 'p1', toolName: 'AskUserQuestion', input: {}, kind: 'question' },
    });
    const s = applyAgentEvent(blocked, { kind: 'session_started', sessionId: 'c-1' }, 1);
    expect(s.status).toBe('awaiting_input');
  });
});

describe('applyAgentEvent / model_resolved', () => {
  // Codex は解決済みモデルをストリームで運ばないので、別経路で調べた結果が
  // **ターンが終わったあとに**届くことがある。だから status を触らせない。
  it('fills in the model without touching the status of a finished session', () => {
    const finished = running({ status: 'completed', finishedAt: 5 });
    const s = applyAgentEvent(finished, { kind: 'model_resolved', model: 'gpt-5.6-sol' }, 9);
    expect(s.model).toBe('gpt-5.6-sol');
    expect(s.status).toBe('completed');
    expect(s.finishedAt).toBe(5);
  });

  it.each(['running', 'awaiting_input', 'interrupted', 'failed'] as const)(
    'leaves %s alone',
    (status) => {
      const s = applyAgentEvent(running({ status }), { kind: 'model_resolved', model: 'm' }, 1);
      expect(s.status).toBe(status);
      expect(s.model).toBe('m');
    },
  );

  it('returns the same object when the model is already known (no needless repaint)', () => {
    const known = running({ model: 'gpt-5.6-sol' });
    expect(applyAgentEvent(known, { kind: 'model_resolved', model: 'gpt-5.6-sol' }, 1)).toBe(known);
  });

  it('lets a later explicit choice win (last write, not first)', () => {
    const s = fold(running(), [
      { kind: 'model_resolved', model: 'gpt-5.6-sol' },
      { kind: 'assistant_message', model: 'gpt-5.4-mini' },
    ]);
    expect(s.model).toBe('gpt-5.4-mini');
  });
});

describe('applyAgentEvent / log attribution', () => {
  it('stamps the agent on log lines only when one is supplied', () => {
    const withAgent = fold(running(), [{ kind: 'assistant_text', text: 'hi' }], 1, 'codex');
    expect(withAgent.messages.at(-1)?.agent).toBe('codex');

    const without = fold(running(), [{ kind: 'assistant_text', text: 'hi' }]);
    expect(without.messages.at(-1)?.agent).toBeUndefined();
  });

  it('drops empty assistant text without consuming a seq', () => {
    const s = fold(running(), [{ kind: 'assistant_text', text: '   ' }]);
    expect(s.messages).toHaveLength(0);
    expect(s.logSeq).toBe(0);
  });
});

describe('applyAgentEvent / todo ops', () => {
  it('creates, updates and replaces the task list, keeping progress in step', () => {
    const created = fold(running(), [
      { kind: 'tool_use', summary: 'a', tool: 'todo', todo: { op: 'create', subject: 'first' } },
      { kind: 'tool_use', summary: 'b', tool: 'todo', todo: { op: 'create', subject: 'second' } },
    ]);
    expect(created.todos.map((t) => t.subject)).toEqual(['first', 'second']);
    expect(created.progress).toEqual({ done: 0, total: 2 });

    const updated = fold(created, [
      {
        kind: 'tool_use',
        summary: 'c',
        tool: 'todo',
        todo: { op: 'update', id: '1', status: 'completed' },
      },
    ]);
    expect(updated.progress).toEqual({ done: 1, total: 2 });

    const replaced = fold(updated, [
      {
        kind: 'tool_use',
        summary: 'd',
        tool: 'todo',
        todo: { op: 'replace', items: [{ subject: 'only', status: 'in_progress' }] },
      },
    ]);
    expect(replaced.todos).toHaveLength(1);
    expect(replaced.progress).toEqual({ done: 0, total: 1 });
  });
});

describe('applyAgentEvent / turn_stopped', () => {
  const cases = [
    ['auth', 'needs_login'],
    ['rate_limit', 'rate_limited'],
    ['connection', 'interrupted'],
    ['failed', 'failed'],
  ] as const;

  it.each(cases)('a %s cause lands on %s', (cause, status) => {
    const s = applyAgentEvent(running(), { kind: 'turn_stopped', cause, detail: 'why' }, 5);
    expect(s.status).toBe(status);
  });

  it('a rollup over an already-resumable state only takes the cost', () => {
    const stopped = applyAgentEvent(
      running(),
      { kind: 'turn_stopped', cause: 'auth', detail: 'expired' },
      5,
    );
    const rolled = applyAgentEvent(
      stopped,
      { kind: 'turn_stopped', cause: 'failed', detail: 'error', totalCostUsd: 0.5, rollup: true },
      6,
    );
    // 分類はやり直さない（認証切れが「よく分からない失敗」に格下げされない）。
    expect(rolled.status).toBe('needs_login');
    expect(rolled.totalCostUsd).toBe(0.5);
    // ログも増えない。
    expect(rolled.messages).toHaveLength(stopped.messages.length);
  });
});

describe('applyAgentEvent / sub-agent completion gate', () => {
  it('holds a completion while a sub-agent task is still in flight', () => {
    const withTask = fold(running(), [{ kind: 'task_started', taskId: 't1' }]);
    const early = applyAgentEvent(withTask, { kind: 'turn_completed', text: 'done' }, 5);
    // バックグラウンド Task が走っている間は「完了」にしない。
    expect(early.status).toBe('running');
    expect(early.deferredResult?.resultText).toBe('done');

    const settled = applyAgentEvent(early, { kind: 'task_settled', taskId: 't1' }, 6);
    expect(settled.status).toBe('completed');
    expect(settled.finishedAt).toBe(6);
    expect(settled.activeTaskIds).toBeUndefined();
  });

  it('does not let a late notification complete a session that already failed', () => {
    const withTask = fold(running(), [{ kind: 'task_started', taskId: 't1' }]);
    const early = applyAgentEvent(withTask, { kind: 'turn_completed', text: 'done' }, 5);
    const failed = applyAgentEvent(
      early,
      { kind: 'turn_stopped', cause: 'failed', detail: 'x' },
      6,
    );
    const settled = applyAgentEvent(failed, { kind: 'task_settled', taskId: 't1' }, 7);
    expect(settled.status).toBe('failed');
  });

  it('keeps the held completion when the gate drains during a permission prompt', () => {
    // 「ずっと Running」の再現: バックグラウンド Task が質問を上げている最中に
    // 最後のタスクが片付くと、その瞬間は `running` ではないので完了できない。
    // ゲートは空になるので `task_settled` も二度と来ない — 完了を捨てると
    // セッションが永久に `running` のまま張り付く（→ `permission_resolved` が拾う）。
    const withTask = fold(running(), [{ kind: 'task_started', taskId: 't1' }]);
    const early = applyAgentEvent(withTask, { kind: 'turn_completed', text: 'done' }, 5);
    const asking: SessionState = {
      ...early,
      status: 'awaiting_input',
      pendingPermission: { id: 'p1', toolName: 'AskUserQuestion', input: {}, kind: 'question' },
    };
    const settled = applyAgentEvent(asking, { kind: 'task_settled', taskId: 't1' }, 6);
    expect(settled.status).toBe('awaiting_input');
    expect(settled.activeTaskIds).toEqual([]);
    // 完了は捨てずに持ったまま（回答したときに確定される）。
    expect(settled.deferredResult?.resultText).toBe('done');
  });

  it('drains the whole gate on a settle notice that names no task', () => {
    // 帰属できない決着通知でゲートが埋まったままになると、片付いたタスクへの
    // `task_settled` はもう来ないので `running` から出られない。早すぎる完了より
    // 張り付きのほうが害が大きいので、安全側は「空にする」。
    const withTasks = fold(running(), [
      { kind: 'task_started', taskId: 't1' },
      { kind: 'task_started', taskId: 't2' },
    ]);
    const early = applyAgentEvent(withTasks, { kind: 'turn_completed', text: 'done' }, 5);
    expect(early.status).toBe('running');

    const settled = applyAgentEvent(early, { kind: 'task_settled' }, 6);
    expect(settled.status).toBe('completed');
    expect(settled.activeTaskIds).toBeUndefined();
  });

  it('drops the gate when the turn fails, so the next turn can still complete', () => {
    // ゲートはそのターン限りの記録。失敗のあとも残すと、追加指示で再開した次の
    // ターンの `turn_completed` まで保留され続ける（= ずっと Running）。
    const withTask = fold(running(), [{ kind: 'task_started', taskId: 't1' }]);
    const failed = applyAgentEvent(
      withTask,
      { kind: 'turn_stopped', cause: 'failed', detail: 'x' },
      6,
    );
    expect(failed.activeTaskIds).toBeUndefined();
    expect(failed.deferredResult).toBeUndefined();

    const retried = applyAgentEvent(
      { ...failed, status: 'running' },
      { kind: 'turn_completed', text: 'done' },
      7,
    );
    expect(retried.status).toBe('completed');
  });
});

describe('applyAgentEvent / notices coalesce', () => {
  it('rewrites the previous retry line instead of appending a new one', () => {
    const first = fold(running(), [
      { kind: 'notice', text: 'api retry 1/3: overloaded', coalesceKey: 'api retry' },
    ]);
    const second = applyAgentEvent(
      first,
      { kind: 'notice', text: 'api retry 2/3: overloaded', coalesceKey: 'api retry' },
      2,
    );
    expect(second.messages).toHaveLength(1);
    expect(second.messages[0]?.text).toBe('api retry 2/3: overloaded');
    // seq は据え置き（描画キーが変わらない）。
    expect(second.messages[0]?.seq).toBe(first.messages[0]?.seq);
  });

  it('appends when there is no coalesce key', () => {
    const s = fold(running(), [
      { kind: 'notice', text: 'one' },
      { kind: 'notice', text: 'two' },
    ]);
    expect(s.messages).toHaveLength(2);
  });
});

describe('applyAgentEvent / PR detection', () => {
  it('only scans the result of a tool_use that actually created a PR', () => {
    const created = fold(running(), [
      { kind: 'tool_use', id: 'tu1', summary: 'Bash gh pr create', tool: 'shell', prCreate: true },
    ]);
    expect(created.prCreateToolIds).toEqual(['tu1']);

    const matched = applyAgentEvent(
      created,
      {
        kind: 'tool_result',
        toolUseId: 'tu1',
        summary: 'ok',
        scanText: 'https://github.com/o/r/pull/42',
      },
      2,
    );
    expect(matched.extraPrs?.map((p) => p.number)).toEqual([42]);
    // 対応が取れたら控えから外す。
    expect(matched.prCreateToolIds).toBeUndefined();
  });

  it('ignores PR urls in the output of unrelated tools', () => {
    const s = applyAgentEvent(
      running(),
      {
        kind: 'tool_result',
        toolUseId: 'other',
        summary: 'listing',
        scanText: 'https://github.com/o/r/pull/99',
      },
      2,
    );
    expect(s.extraPrs).toBeUndefined();
  });
});

describe('applyAgentEvent / streaming preview', () => {
  it('accumulates deltas and is cleared by the full message', () => {
    const streamed = fold(running(), [
      { kind: 'stream_text', text: 'he' },
      { kind: 'stream_text', text: 'llo' },
    ]);
    expect(streamed.streamingText).toBe('hello');

    const full = applyAgentEvent(streamed, { kind: 'assistant_message' }, 2);
    expect(full.streamingText).toBeUndefined();
  });

  it('usage is out-of-band and never changes session state', () => {
    const s0 = running();
    const s1 = applyAgentEvent(
      s0,
      { kind: 'usage', info: { rateLimitType: 'five_hour', status: 'allowed' } },
      1,
    );
    expect(s1).toBe(s0);
  });
});

/**
 * サブエージェントの**表示**を足したことで、**完了ゲートの挙動が 1 ミリも変わって
 * いない**ことの番人。ゲートは「素の id 集合 + レベル信号の自己修復」という一番
 * 壊れにくい形で、そこへ上限付き・決着済みも保持する表示用の構造体を混ぜると
 * 「早すぎる完了」か「`running` の永久張り付き」を作り込む。
 *
 * 同じシナリオを「表示用メタなし」「あり」の 2 通りで畳み、ゲートに関わる 3 つの
 * フィールドが完全一致することを確かめる。
 */
describe('applyAgentEvent / 完了ゲートは表示に影響されない', () => {
  const gateOf = (s: SessionState) => ({
    activeTaskIds: s.activeTaskIds,
    deferredResult: s.deferredResult,
    status: s.status,
  });

  const meta = { toolUseId: 'tu1', description: 'work', kind: 'general-purpose' };
  const scenarios: Array<{ name: string; plain: AgentEvent[]; rich: AgentEvent[] }> = [
    {
      name: '起動だけ（ゲートに積む）',
      plain: [{ kind: 'task_started', taskId: 't1' }],
      rich: [{ kind: 'task_started', taskId: 't1', subagent: meta }],
    },
    {
      name: '起動 → 決着',
      plain: [
        { kind: 'task_started', taskId: 't1' },
        { kind: 'task_settled', taskId: 't1' },
      ],
      rich: [
        { kind: 'task_started', taskId: 't1', subagent: meta },
        { kind: 'task_settled', taskId: 't1', outcome: 'completed', summary: 'ok' },
      ],
    },
    {
      name: '起動 → 完了が先に届く（保留） → 決着で確定',
      plain: [
        { kind: 'task_started', taskId: 't1' },
        { kind: 'turn_completed', text: 'done', totalCostUsd: 1 },
        { kind: 'task_settled', taskId: 't1' },
      ],
      rich: [
        { kind: 'task_started', taskId: 't1', subagent: meta },
        { kind: 'turn_completed', text: 'done', totalCostUsd: 1 },
        { kind: 'task_settled', taskId: 't1', outcome: 'completed' },
      ],
    },
    {
      name: '起動 2 本 → id 無しの決着（ゲートを畳む安全側）',
      plain: [
        { kind: 'task_started', taskId: 't1' },
        { kind: 'task_started', taskId: 't2' },
        { kind: 'turn_completed', text: 'done' },
        { kind: 'task_settled' },
      ],
      rich: [
        { kind: 'task_started', taskId: 't1', subagent: meta },
        { kind: 'task_started', taskId: 't2', subagent: { toolUseId: 'tu2' } },
        { kind: 'turn_completed', text: 'done' },
        { kind: 'task_settled' },
      ],
    },
    {
      name: '起動 → レベル信号で空集合（自己修復）',
      plain: [
        { kind: 'task_started', taskId: 't1' },
        { kind: 'turn_completed', text: 'done' },
        { kind: 'tasks_changed', taskIds: [] },
      ],
      rich: [
        { kind: 'task_started', taskId: 't1', subagent: meta },
        { kind: 'turn_completed', text: 'done' },
        { kind: 'tasks_changed', taskIds: [] },
      ],
    },
    {
      // 進捗はエッジでもレベル信号でもないので、ゲートに触れてはいけない。
      name: '起動 → 進捗（ゲートを触らない） → 決着',
      plain: [
        { kind: 'task_started', taskId: 't1' },
        { kind: 'task_settled', taskId: 't1' },
      ],
      rich: [
        { kind: 'task_started', taskId: 't1', subagent: meta },
        { kind: 'task_progress', taskId: 't1', description: 'Writing', lastTool: 'Write' },
        { kind: 'task_progress', taskId: 'unknown-task', lastTool: 'Bash' },
        { kind: 'task_settled', taskId: 't1', outcome: 'completed' },
      ],
    },
  ];

  it.each(scenarios.map((s) => [s.name, s] as const))('%s', (_name, scenario) => {
    expect(gateOf(fold(running(), scenario.rich))).toEqual(gateOf(fold(running(), scenario.plain)));
  });
});

describe('applyAgentEvent / サブエージェントの記録', () => {
  const started = (state = running()) =>
    applyAgentEvent(
      state,
      {
        kind: 'task_started',
        taskId: 't1',
        subagent: { toolUseId: 'tu1', description: 'Create report', kind: 'general-purpose' },
      },
      1,
    );

  it('起動でメタを記録する', () => {
    expect(started().subagents?.[0]).toMatchObject({
      id: 't1',
      toolUseId: 'tu1',
      description: 'Create report',
      kind: 'general-purpose',
      status: 'running',
      startedAt: 1,
    });
  });

  it('進捗で説明・直近のツール・使用状況が入れ替わる', () => {
    const s = applyAgentEvent(
      started(),
      {
        kind: 'task_progress',
        taskId: 't1',
        description: 'Writing report.txt',
        lastTool: 'Write',
        usage: { totalTokens: 100, toolUses: 1, durationMs: 500 },
      },
      2,
    );
    expect(s.subagents?.[0]).toMatchObject({
      description: 'Writing report.txt',
      lastTool: 'Write',
      usage: { totalTokens: 100, toolUses: 1, durationMs: 500 },
    });
  });

  it('決着で成否と要約・出力先が入る', () => {
    const s = applyAgentEvent(
      started(),
      {
        kind: 'task_settled',
        taskId: 't1',
        outcome: 'failed',
        summary: 'could not write',
        outputFile: '/tmp/t1.output',
      },
      9,
    );
    expect(s.subagents?.[0]).toMatchObject({
      status: 'failed',
      summary: 'could not write',
      outputFile: '/tmp/t1.output',
      finishedAt: 9,
    });
  });

  // ターンが終わったあとに詳細ログを開けることが機能要件なので、記録は消さない。
  it('ターンが終わると記録は残り、走っている印だけが封じられる', () => {
    const s = applyAgentEvent(started(), { kind: 'turn_stopped', cause: 'failed', detail: 'x' }, 5);
    expect(s.activeTaskIds).toBeUndefined();
    expect(s.deferredResult).toBeUndefined();
    expect(s.subagents?.[0]).toMatchObject({
      description: 'Create report',
      status: 'stopped',
      finishedAt: 5,
    });
  });

  // 前のプロセスのタスクは決着を報告しない → 封じないとスピナーが永久に回る。
  it('CLI プロセスが起き直っても記録は残り、印だけ封じられる', () => {
    const s = applyAgentEvent(started(), { kind: 'session_started', sessionId: 'x' }, 7);
    expect(s.activeTaskIds).toBeUndefined();
    expect(s.subagents?.[0]).toMatchObject({ status: 'stopped', finishedAt: 7 });
  });

  // レベル信号は *background* タスクの全集合で、前景の Task では一度も出ない。
  // これで表示を置き換えると、走っている前景サブエージェントが終わったように見える。
  it('tasks_changed は表示を触らない', () => {
    const before = started();
    const s = applyAgentEvent(before, { kind: 'tasks_changed', taskIds: [] }, 2);
    expect(s.subagents).toBe(before.subagents);
  });
});

describe('applyAgentEvent / ログの振り分け', () => {
  const withSub = () =>
    applyAgentEvent(
      running(),
      { kind: 'task_started', taskId: 't1', subagent: { toolUseId: 'tu1' } },
      1,
    );

  const textsOf = (s: SessionState) => ({
    parent: s.messages.map((m) => m.text),
    sub: (s.subagents?.[0]?.messages ?? []).map((m) => m.text),
  });

  it.each([
    ['帰属キーが無ければ本体のログへ', undefined, 'parent'],
    ['既知の帰属キーならサブエージェント専用ログへ', 'tu1', 'sub'],
    // 未知の id でも**行を捨てない**（従来どおりの見た目に degrade するだけ）。
    ['未知の帰属キーは本体のログへ落とす', 'nope', 'parent'],
  ] as const)('%s', (_name, ref, dest) => {
    const s = applyAgentEvent(
      withSub(),
      { kind: 'assistant_text', text: 'hello', subagentRef: ref },
      2,
    );
    const { parent, sub } = textsOf(s);
    expect(dest === 'sub' ? sub : parent).toContain('hello');
    expect(dest === 'sub' ? parent : sub).not.toContain('hello');
  });

  it('記録が 1 本も無いセッションでは帰属キーがあっても本体へ', () => {
    const s = applyAgentEvent(
      running(),
      { kind: 'tool_use', summary: 'Write x', tool: 'edit', subagentRef: 'tu1' },
      2,
    );
    expect(s.messages.map((m) => m.text)).toContain('Write x');
  });

  it('seq は本体とサブで通し番号（重複しない）', () => {
    let s = withSub();
    s = applyAgentEvent(s, { kind: 'assistant_text', text: 'p1' }, 2);
    s = applyAgentEvent(s, { kind: 'assistant_text', text: 's1', subagentRef: 'tu1' }, 3);
    s = applyAgentEvent(s, { kind: 'assistant_text', text: 'p2' }, 4);
    const seqs = [...s.messages, ...(s.subagents?.[0]?.messages ?? [])].map((e) => e.seq);
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(s.logSeq).toBe(3);
  });

  // PR 検出は振り分けと独立に走る（サブエージェントが立てた PR も取りこぼさない）。
  it('サブエージェントが作った PR も取り込む', () => {
    let s = withSub();
    s = applyAgentEvent(
      s,
      {
        kind: 'tool_use',
        id: 'x1',
        summary: 'gh pr create',
        tool: 'shell',
        prCreate: true,
        subagentRef: 'tu1',
      },
      2,
    );
    s = applyAgentEvent(
      s,
      {
        kind: 'tool_result',
        toolUseId: 'x1',
        summary: 'created',
        scanText: 'https://github.com/o/r/pull/7',
        subagentRef: 'tu1',
      },
      3,
    );
    expect(s.extraPrs?.map((p) => p.number)).toContain(7);
  });
});
