import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { type AgentEvent, applyAgentEvent } from '@/core/agent-events';
import { GROK_RETRY_PREFIX } from '@/core/grok-errors';
import { type GrokSessionUpdate, grokUpdateOf, toGrokMessage } from '@/core/grok-events';
import { createGrokParser } from '@/core/grok-parse';
import { initialState } from '@/core/status-reducer';
import type { CreateSessionInput } from '@/core/types';

/**
 * 実際の `grok agent stdio`（grok 1.0.0）が流した JSON-RPC を再生して、
 * `createGrokParser` の parse / flush を確かめる。
 *
 * Grok は Claude / Codex と違って「メッセージが 1 通終わった」区切りを送らないので、
 * パーサは**状態を持つ**（本文と思考を溜め、ツール呼び出し・ターン終了で確定する）。
 * だから 1 件ずつではなく**ストリーム全体を 1 つのパーサに通して**検証する。
 * 形は想定で書かない（規約: `.claude/rules/sdk-integration.md`）。
 */
function loadUpdates(name: string): GrokSessionUpdate[] {
  const path = fileURLToPath(new URL(`./__fixtures__/${name}`, import.meta.url));
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => {
      const message = toGrokMessage(JSON.parse(line) as unknown);
      if (!message) {
        throw new Error(`fixture ${name} carries a line toGrokMessage rejected: ${line}`);
      }
      const update = grokUpdateOf(message);
      return update ? [update] : [];
    });
}

interface Replayed {
  /** parse() が返したイベント（ターン中に流れるぶん）。 */
  readonly parsed: AgentEvent[];
  /** flush() が返したイベント（ターン終了で確定するぶん）。 */
  readonly flushed: AgentEvent[];
  readonly all: AgentEvent[];
}

function replay(updates: readonly GrokSessionUpdate[]): Replayed {
  const parser = createGrokParser();
  const parsed: AgentEvent[] = [];
  for (const update of updates) {
    parsed.push(...parser.parse(update));
  }
  const flushed = parser.flush();
  return { parsed, flushed, all: [...parsed, ...flushed] };
}

/** kind ごとの取り出し（`filter` は型を絞らないので flatMap で narrowing する）。 */
function pick<K extends AgentEvent['kind']>(
  events: readonly AgentEvent[],
  kind: K,
): Extract<AgentEvent, { kind: K }>[] {
  return events.flatMap((e) => (e.kind === kind ? [e as Extract<AgentEvent, { kind: K }>] : []));
}

const BASE: CreateSessionInput = {
  id: 's1',
  title: 'demo',
  prompt: 'demo prompt',
  branch: 'codiva/demo',
  worktreePath: '/tmp/demo',
  startedAt: 1000,
};

describe('createGrokParser over real fixtures', () => {
  let basic: GrokSessionUpdate[];
  let reasoning: GrokSessionUpdate[];
  let shell: GrokSessionUpdate[];
  let edit: GrokSessionUpdate[];
  let todo: GrokSessionUpdate[];
  let question: GrokSessionUpdate[];
  let authError: GrokSessionUpdate[];

  beforeAll(() => {
    basic = loadUpdates('grok-basic.jsonl');
    reasoning = loadUpdates('grok-reasoning.jsonl');
    shell = loadUpdates('grok-shell.jsonl');
    edit = loadUpdates('grok-edit.jsonl');
    todo = loadUpdates('grok-todo.jsonl');
    question = loadUpdates('grok-question.jsonl');
    authError = loadUpdates('grok-autherror.jsonl');
  });

  it('本文は assistant_message + デルタで流れ、flush で 1 行に確定する', () => {
    const { parsed, flushed } = replay(basic);
    // 1 通の始まりは 1 回だけ（デルタごとに running へ巻き戻さない）。
    expect(parsed.map((e) => e.kind)).toEqual([
      'assistant_message',
      'stream_text',
      'stream_text',
      'stream_text',
    ]);
    expect(pick(parsed, 'stream_text').map((e) => e.text)).toEqual(['Hello', ' from', ' Grok.']);
    // ターンの終わりに本文が 1 行として残り、ライブプレビューは畳まれる。
    expect(flushed).toEqual([
      { kind: 'assistant_text', text: 'Hello from Grok.' },
      { kind: 'stream_reset' },
    ]);
  });

  it('flush を呼ばないと本文がログに残らない（アダプタが必ず呼ぶ契約の番人）', () => {
    const parser = createGrokParser();
    const parsed = basic.flatMap((u) => parser.parse(u));
    expect(pick(parsed, 'assistant_text')).toHaveLength(0);
    expect(pick(parser.flush(), 'assistant_text')).toHaveLength(1);
    // 二度目の flush では何も出ない（溜めは吐いたら空）。
    expect(parser.flush()).toEqual([]);
  });

  it('思考はチャンクごとではなく 1 本の notice になり、本文より先に出る', () => {
    const { all } = replay(reasoning);
    const notices = pick(all, 'notice');
    expect(notices).toHaveLength(1);
    expect(notices[0]?.text).toBe('Checking the repository layout first.');
    // 思考 → 本文の順（本文が始まった時点で思考を確定させる）。
    expect(all.findIndex((e) => e.kind === 'notice')).toBeLessThan(
      all.findIndex((e) => e.kind === 'assistant_message'),
    );
    expect(pick(all, 'assistant_text').map((e) => e.text)).toEqual([
      'The project is a TypeScript CLI.',
    ]);
  });

  it('思考が複数チャンクに割れても notice は 1 本のまま', () => {
    const thoughts = reasoning.flatMap((u) =>
      u.sessionUpdate === 'agent_thought_chunk' ? [u] : [],
    );
    expect(thoughts).toHaveLength(1);
    const parser = createGrokParser();
    // 実データのチャンクを 3 回流す（チャンクの割れ方は上流次第なので数は保証されない）。
    const parsed = [...thoughts, ...thoughts, ...thoughts].flatMap((u) => parser.parse(u));
    expect(parsed).toEqual([]);
    const notices = pick(parser.flush(), 'notice');
    expect(notices).toHaveLength(1);
    expect(notices[0]?.text).toBe(
      'Checking the repository layout first.Checking the repository layout first.Checking the repository layout first.',
    );
  });

  it('シェルは `$ <command>` の tool_use と、その出力を運ぶ tool_result になる', () => {
    const { all } = replay(shell);
    const toolUses = pick(all, 'tool_use');
    const toolResults = pick(all, 'tool_result');
    expect(toolUses).toHaveLength(1);
    expect(toolResults).toHaveLength(1);
    expect(toolUses[0]?.tool).toBe('shell');
    // title（`run_terminal_command`）ではなく rawInput.command から組む。
    expect(toolUses[0]?.summary).toBe('$ echo hi');
    expect(toolUses[0]?.summary.startsWith('$ ')).toBe(true);
    // 突き合わせの id が一致していないと、PR URL の検出も結果の対応も壊れる。
    expect(toolUses[0]?.id).toBe('call_mock1');
    expect(toolResults[0]?.toolUseId).toBe(toolUses[0]?.id);
    expect(toolResults[0]?.summary).toBe('hi');
    expect(toolResults[0]?.scanText).toBe('hi\n');
    // `gh pr create` ではないので PR 検出の印は立てない。
    expect(toolUses[0]?.prCreate).toBeUndefined();
  });

  it('実行中（in_progress）の tool_call_update はログ行を増やさない', () => {
    // 実データには status 無し 1 件 + in_progress 2 件 + completed 1 件が入っている。
    const updates = shell.flatMap((u) => (u.sessionUpdate === 'tool_call_update' ? [u] : []));
    expect(updates).toHaveLength(4);
    expect(updates.filter((u) => u.status === 'in_progress')).toHaveLength(2);
    expect(pick(replay(shell).all, 'tool_result')).toHaveLength(1);
  });

  it('編集はファイルパス入りの tool_use になり、完了で tool_result がちょうど 1 本出る', () => {
    const { all } = replay(edit);
    const toolUses = pick(all, 'tool_use');
    expect(toolUses).toHaveLength(1);
    expect(toolUses[0]?.tool).toBe('edit');
    expect(toolUses[0]?.summary).toBe('search_replace /repo/target.txt');
    expect(toolUses[0]?.summary).toContain('/repo/target.txt');
    expect(pick(all, 'tool_result')).toHaveLength(1);
    // 本文はツールの後に来るので、ツール行 → 本文行の順に並ぶ。
    expect(all.map((e) => e.kind)).toEqual([
      'tool_use',
      'tool_result',
      'assistant_message',
      'stream_text',
      'stream_text',
      'stream_text',
      'assistant_text',
      'stream_reset',
    ]);
  });

  it('TODO は plan 通知から作り、todo_write のツール呼び出しは黙らせる', () => {
    const { all } = replay(todo);
    const toolUses = pick(all, 'tool_use');
    // plan は 2 回届く（作成時と 1 件目完了時）。todo_write のぶんは 1 行も増やさない。
    expect(toolUses).toHaveLength(2);
    expect(toolUses.every((e) => e.tool === 'todo')).toBe(true);
    expect(toolUses.map((e) => e.summary)).toEqual([
      'plan 0/2: Read the code',
      'plan 1/2: Write tests',
    ]);
    expect(toolUses[0]?.todo).toEqual({
      op: 'replace',
      items: [
        { subject: 'Read the code', status: 'in_progress' },
        { subject: 'Write tests', status: 'pending' },
      ],
    });
    expect(toolUses[1]?.todo).toEqual({
      op: 'replace',
      items: [
        { subject: 'Read the code', status: 'completed' },
        { subject: 'Write tests', status: 'pending' },
      ],
    });
    // 黙らせたツールの完了が宙ぶらりんの tool_result を残さない。
    expect(pick(all, 'tool_result')).toHaveLength(0);
    // 要約は必ず本文を持つ（空だとログに空行が並ぶ）。
    expect(all.every((e) => e.kind !== 'tool_use' || e.summary.trim().length > 0)).toBe(true);
  });

  it('質問は tool:"question" の tool_use になる', () => {
    const { all } = replay(question);
    const toolUses = pick(all, 'tool_use');
    expect(toolUses).toHaveLength(1);
    expect(toolUses[0]?.tool).toBe('question');
    expect(toolUses[0]?.id).toBe('call_mock1');
    // 回答は要求（`_x.ai/ask_user_question`）側で扱うので、ここは結果行だけ。
    expect(pick(all, 'tool_result')[0]?.summary).toContain('User has answered your questions');
  });

  it('retry_state は notice になり、coalesceKey で 1 行に畳まれる', () => {
    const retries = authError.flatMap((u) => (u.sessionUpdate === 'retry_state' ? [u] : []));
    expect(retries).toHaveLength(1);
    const parser = createGrokParser();
    const [first] = parser.parse(retries[0] as GrokSessionUpdate);
    expect(first).toMatchObject({ kind: 'notice', coalesceKey: GROK_RETRY_PREFIX });
    expect(first?.kind === 'notice' && first.text.startsWith(GROK_RETRY_PREFIX)).toBe(true);
    // 本文は複数行なので先頭 1 行だけ（実測の文言）。
    expect(first).toMatchObject({
      text: `${GROK_RETRY_PREFIX} Unauthorized (401) from http://127.0.0.1:8899/v1/responses: unauthenticated: Incorrect API key provided.`,
    });

    // 再接続のたびに流れてくるので、畳み込み側でログ行が増えないことまで確かめる。
    const events = [
      ...parser.parse(retries[0] as GrokSessionUpdate),
      ...parser.parse(retries[0] as GrokSessionUpdate),
    ];
    let state = initialState(BASE);
    events.forEach((event, i) => {
      state = applyAgentEvent(state, event, BASE.startedAt + i, 'grok');
    });
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]?.kind).toBe('system');
  });

  it('retry_state はターンを終わらせない（実況であって終了ではない）', () => {
    const { all } = replay(authError);
    expect(pick(all, 'turn_stopped')).toHaveLength(0);
    expect(pick(all, 'turn_completed')).toHaveLength(0);
    // 401 のターンは本文を出さないので、流れるのは notice 1 本だけ。
    expect(all.map((e) => e.kind)).toEqual(['notice']);
  });
});

describe('createGrokParser streaming invariants', () => {
  it('デルタを重ねても assistant_message は 1 回・stream_text は増分だけ', () => {
    const parser = createGrokParser();
    const chunks = ['Hel', 'lo', ' wo', 'rld'];
    const parsed = chunks.flatMap((text) =>
      parser.parse({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } }),
    );
    expect(pick(parsed, 'assistant_message')).toHaveLength(1);
    // 累積を送り直さない（送ると Ink の測定キャッシュが毎フレーム全文ぶん積まれる）。
    expect(pick(parsed, 'stream_text').map((e) => e.text)).toEqual(chunks);
    expect(parser.flush()).toEqual([
      { kind: 'assistant_text', text: 'Hello world' },
      { kind: 'stream_reset' },
    ]);
  });

  it('空のデルタは stream_text を増やさない', () => {
    const parser = createGrokParser();
    const parsed = parser.parse({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: '' },
    });
    expect(parsed).toEqual([{ kind: 'assistant_message' }]);
  });

  it('本文が空のまま終わってもプレビューは畳む（stream_reset だけ出る）', () => {
    const parser = createGrokParser();
    parser.parse({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '  ' } });
    expect(parser.flush()).toEqual([{ kind: 'stream_reset' }]);
  });

  it('本文が始まっていなければ flush は何も出さない', () => {
    expect(createGrokParser().flush()).toEqual([]);
  });

  it('ツール呼び出しの直前に、それまでの本文を確定させる', () => {
    const parser = createGrokParser();
    parser.parse({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'Let me look.' },
    });
    const events = parser.parse({
      sessionUpdate: 'tool_call',
      toolCallId: 'call_1',
      title: 'run_terminal_command',
      rawInput: { command: 'ls' },
      _meta: { 'x.ai/tool': { name: 'run_terminal_command', kind: 'execute' } },
    });
    expect(events).toEqual([
      { kind: 'assistant_text', text: 'Let me look.' },
      { kind: 'stream_reset' },
      { kind: 'tool_use', id: 'call_1', summary: '$ ls', tool: 'shell', prCreate: undefined },
    ]);
  });

  it('`gh pr create` には PR 検出の印を立てる', () => {
    const [event] = createGrokParser().parse({
      sessionUpdate: 'tool_call',
      toolCallId: 'call_1',
      title: 'run_terminal_command',
      rawInput: { command: 'gh pr create --draft --fill' },
      _meta: { 'x.ai/tool': { name: 'run_terminal_command', kind: 'execute' } },
    });
    expect(event).toMatchObject({ kind: 'tool_use', tool: 'shell', prCreate: true });
  });

  it.each([
    // 手がかりの優先順は command → path → query（Claude / Codex と同じ書式）。
    [{ command: 'echo hi' }, '$ echo hi'],
    [{ file_path: '/repo/a.ts' }, 'my_tool /repo/a.ts'],
    [{ target_file: '/repo/b.ts' }, 'my_tool /repo/b.ts'],
    [{ path: '/repo/c.ts' }, 'my_tool /repo/c.ts'],
    [{ query: 'ink flexbox' }, 'my_tool ink flexbox'],
    [{ pattern: 'TODO' }, 'my_tool TODO'],
    // 何も無ければ CLI の題（ツール名と違うときだけ）。
    [{}, 'Doing something'],
  ])('rawInput %j を %j と要約する', (rawInput, expected) => {
    const [event] = createGrokParser().parse({
      sessionUpdate: 'tool_call',
      toolCallId: 'call_1',
      title: 'Doing something',
      rawInput,
      _meta: { 'x.ai/tool': { name: 'my_tool', kind: 'other' } },
    });
    expect(event).toMatchObject({ summary: expected });
  });

  it('手がかりも題も無いツールでも空の要約にしない', () => {
    const [event] = createGrokParser().parse({
      sessionUpdate: 'tool_call',
      toolCallId: 'call_1',
      _meta: { 'x.ai/tool': { name: 'my_tool' } },
    });
    expect(event).toMatchObject({ summary: 'my_tool', tool: 'other' });
    const [fallback] = createGrokParser().parse({ sessionUpdate: 'tool_call' });
    expect(fallback).toMatchObject({ summary: 'tool', tool: 'other' });
  });

  it.each([
    ['execute', 'shell'],
    ['edit', 'edit'],
    ['ask_user', 'question'],
    ['read', 'other'],
    [undefined, 'other'],
  ] as const)('_meta の kind %s を %s へ写す', (kind, expected) => {
    const [event] = createGrokParser().parse({
      sessionUpdate: 'tool_call',
      toolCallId: 'call_1',
      _meta: { 'x.ai/tool': { name: 'x', kind } },
    });
    expect(event).toMatchObject({ tool: expected });
  });

  it.each([
    ['hi\n', 'completed', undefined, 'hi'],
    ['boom\n', 'failed', 3, 'boom (exit 3)'],
    // 出力の無い失敗は終了コードだけ（二重に書かない）。
    ['', 'failed', 3, 'failed (exit 3)'],
    ['', 'failed', undefined, 'failed'],
    ['', 'completed', undefined, ''],
  ] as const)('結果 (%j, %s, exit %s) を %j と要約する', (text, status, exit, expected) => {
    const parser = createGrokParser();
    parser.parse({
      sessionUpdate: 'tool_call',
      toolCallId: 'call_1',
      _meta: { 'x.ai/tool': { name: 'run_terminal_command', kind: 'execute' } },
    });
    const events = parser.parse({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call_1',
      status,
      content: [{ type: 'content', content: { type: 'text', text } }],
      rawOutput: exit === undefined ? {} : { exit_code: exit },
    });
    expect(events).toEqual([
      { kind: 'tool_result', toolUseId: 'call_1', summary: expected, scanText: text },
    ]);
  });

  it.each(['pending', 'in_progress', undefined] as const)(
    'status %s の tool_call_update は何も出さない',
    (status) => {
      expect(
        createGrokParser().parse({
          sessionUpdate: 'tool_call_update',
          toolCallId: 'call_1',
          status,
          content: [{ type: 'content', content: { type: 'text', text: 'partial' } }],
        }),
      ).toEqual([]);
    },
  );

  it('解釈しない sessionUpdate は 1 件もイベントを出さない', () => {
    const parser = createGrokParser();
    // 受理ガード（`toGrokUpdate`）が捨てる種別。パーサ側の default も無反応であること。
    for (const kind of [
      'available_commands_update',
      'session_info_update',
      'session_summary_generated',
      'user_message_chunk',
      'response_completed',
      'pending_interaction',
      'interaction_resolved',
      'tool_call_delta_chunk',
      'turn_completed',
      'last_turn_summary',
    ]) {
      expect(parser.parse({ sessionUpdate: kind } as unknown as GrokSessionUpdate)).toEqual([]);
    }
    // 溜めているものも無いので flush も空。
    expect(parser.flush()).toEqual([]);
  });
});
