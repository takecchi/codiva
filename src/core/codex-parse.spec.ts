import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { applyAgentEvent } from '@/core/agent-events';
import { type CodexEvent, toCodexEvent } from '@/core/codex-events';
import { parseCodexEvent } from '@/core/codex-parse';
import { initialState } from '@/core/status-reducer';
import type { CreateSessionInput, SessionState } from '@/core/types';

/**
 * 実際の `codex exec --json`（codex 0.144.5）の出力を再生して、
 * `parseCodexEvent` → `applyAgentEvent` の end-to-end を確かめる。
 * 形は想定で書かない（規約: `.claude/rules/sdk-integration.md`）。
 */
function loadFixture(name: string): CodexEvent[] {
  const path = fileURLToPath(new URL(`./__fixtures__/${name}`, import.meta.url));
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const event = toCodexEvent(JSON.parse(line) as unknown);
      if (!event) {
        throw new Error(`fixture ${name} carries a line toCodexEvent rejected: ${line}`);
      }
      return event;
    });
}

const BASE: CreateSessionInput = {
  id: 's1',
  title: 'demo',
  prompt: 'demo prompt',
  branch: 'codiva/demo',
  worktreePath: '/tmp/demo',
  startedAt: 1000,
};

/** Replay a Codex JSONL stream through parse → fold with synthetic timestamps. */
function replay(events: readonly CodexEvent[], from = initialState(BASE)): SessionState {
  let state = from;
  let at = BASE.startedAt;
  for (const event of events) {
    at += 1;
    for (const agentEvent of parseCodexEvent(event)) {
      state = applyAgentEvent(state, agentEvent, at, 'codex');
    }
  }
  return state;
}

describe('parseCodexEvent over real fixtures', () => {
  let basic: CodexEvent[];
  let shell: CodexEvent[];
  let shellFail: CodexEvent[];
  let patch: CodexEvent[];
  let reasoning: CodexEvent[];
  let todo: CodexEvent[];
  let failure: CodexEvent[];
  let authError: CodexEvent[];

  beforeAll(() => {
    basic = loadFixture('codex-basic.jsonl');
    shell = loadFixture('codex-shell.jsonl');
    shellFail = loadFixture('codex-shell-fail.jsonl');
    patch = loadFixture('codex-patch.jsonl');
    reasoning = loadFixture('codex-reasoning.jsonl');
    todo = loadFixture('codex-todo.jsonl');
    failure = loadFixture('codex-failure.jsonl');
    authError = loadFixture('codex-auth-error.jsonl');
  });

  it('takes the resume id from thread.started and completes on turn.completed', () => {
    const state = replay(basic);
    expect(state.sdkSessionId).toBe('019feb2e-babc-7e50-8980-233d0f282207');
    // 切替で戻ってきたときに resume できるよう provider ごとに控える。
    expect(state.agentSessions).toEqual({ codex: '019feb2e-babc-7e50-8980-233d0f282207' });
    expect(state.status).toBe('completed');
    expect(state.finishedAt).toBeGreaterThan(BASE.startedAt);
  });

  it('logs the agent_message as assistant text (not as a duplicated result line)', () => {
    const state = replay(basic);
    expect(state.messages).toEqual([
      {
        seq: 1,
        kind: 'assistant_text',
        text: 'Hello from the mock model.',
        timestamp: undefined,
        agent: 'codex',
      },
    ]);
    // `turn.completed` は本文を運ばないので緑の result 行は出ない。
    expect(state.messages.some((m) => m.kind === 'result')).toBe(false);
  });

  it('Codex reports no USD cost, so the session must not invent one', () => {
    expect(replay(basic).totalCostUsd).toBeUndefined();
  });

  it('shows a shell command as a tool_use line and its output as the tool_result', () => {
    const state = replay(shell);
    expect(state.status).toBe('completed');
    const toolUse = state.messages.find((m) => m.kind === 'tool_use');
    expect(toolUse?.text).toBe("$ /bin/zsh -lc 'echo hello-from-mock-shell'");
    const toolResult = state.messages.find((m) => m.kind === 'tool_result');
    expect(toolResult?.text).toBe('hello-from-mock-shell');
    // started → completed の 2 段で、1 コマンド = 2 行。
    expect(state.messages.map((m) => m.kind)).toEqual([
      'tool_use',
      'tool_result',
      'assistant_text',
    ]);
  });

  it('reflects a non-zero exit in the tool_result summary', () => {
    const state = replay(shellFail);
    const toolResult = state.messages.find((m) => m.kind === 'tool_result');
    expect(toolResult?.text).toBe('to-stderr (exit 3)');
    // 失敗したのはコマンドであってターンではない（モデルが続けて説明している）。
    expect(state.status).toBe('completed');
  });

  it('shows a file_change as an apply_patch tool_use line', () => {
    const state = replay(patch);
    const texts = state.messages.map((m) => m.text);
    expect(texts).toContain('apply_patch add /private/tmp/codex-capture/hello.md');
    // 成功した patch の完了は要約が空なので行を増やさない。
    expect(state.messages.filter((m) => m.kind === 'tool_result')).toHaveLength(0);
    expect(state.status).toBe('completed');
  });

  it('keeps the reasoning summary as a system line', () => {
    const state = replay(reasoning);
    const system = state.messages.find((m) => m.kind === 'system');
    expect(system?.text).toContain('Planning the answer');
    expect(state.messages.at(-1)).toMatchObject({
      kind: 'assistant_text',
      text: 'Done thinking.',
    });
  });

  it('builds the todo list from todo_list items and never logs a blank line', () => {
    const state = replay(todo);
    expect(state.todos.map((t) => t.subject)).toEqual(['Read the repo', 'Write the answer']);
    expect(state.todos.map((t) => t.status)).toEqual(['completed', 'pending']);
    expect(state.progress).toEqual({ done: 1, total: 2 });
    // 要約が空の tool_use はログに空行として残る（`summarizeTodo` が必ず本文を持つ）。
    expect(state.messages.every((m) => m.text.trim().length > 0)).toBe(true);
    expect(state.messages.map((m) => m.text)).toEqual([
      'update_plan 0/2: Read the repo',
      'update_plan 1/2: Write the answer',
      'Plan finished.',
    ]);
    expect(state.status).toBe('completed');
  });

  it('coalesces the Reconnecting… retry notices into a single log line', () => {
    const state = replay(failure);
    const reconnecting = state.messages.filter((m) => m.text.startsWith('Reconnecting'));
    // 5 本流れてくるが、増えるのは 1 行だけ（最新の試行に書き換わる）。
    expect(reconnecting).toHaveLength(1);
    expect(reconnecting[0]?.text).toBe(
      'Reconnecting... 5/5 (stream disconnected before completion: mock upstream exploded)',
    );
    expect(reconnecting[0]?.kind).toBe('system');
  });

  it('a turn.failed for a dead stream ends resumable (interrupted), not completed', () => {
    const state = replay(failure);
    expect(state.status).toBe('interrupted');
    expect(state.status).not.toBe('completed');
    // 通信断は失敗ではないので error は立てない（再開できる）。
    expect(state.error).toBeUndefined();
    expect(state.messages.at(-1)?.text).toBe(
      'stream disconnected before completion: mock upstream exploded',
    );
  });

  it('a token-refresh failure is needs_login, not a plain failure', () => {
    const state = replay(authError);
    // 実文言: リフレッシュトークンの使い回し。再試行では直らないので再ログインへ誘導する。
    expect(state.status).toBe('needs_login');
    expect(state.status).not.toBe('failed');
    expect(state.error).toContain('access token could not be refreshed');
    expect(state.finishedAt).toBeGreaterThan(BASE.startedAt);
  });
});

describe('parseCodexEvent unit behaviour', () => {
  it('maps thread.started / turn.started / turn.completed to the neutral vocabulary', () => {
    expect(parseCodexEvent({ type: 'thread.started', thread_id: 'th-1' })).toEqual([
      { kind: 'session_started', sessionId: 'th-1' },
    ]);
    expect(parseCodexEvent({ type: 'turn.started' })).toEqual([{ kind: 'assistant_message' }]);
    expect(parseCodexEvent({ type: 'turn.completed' })).toEqual([
      { kind: 'turn_completed', text: '' },
    ]);
  });

  it.each([
    ['Your access token could not be refreshed. Please log out and sign in again.', 'auth'],
    ['stream disconnected before completion: boom', 'connection'],
    ['rate limit: slow down', 'rate_limit'],
    ['something nobody has seen', 'failed'],
  ])('turn.failed %j stops the turn with cause %s', (message, cause) => {
    expect(parseCodexEvent({ type: 'turn.failed', error: { message } })).toEqual([
      { kind: 'turn_stopped', cause, detail: message },
    ]);
  });

  it('marks only the retry notices as coalescable', () => {
    const retry = parseCodexEvent({ type: 'error', message: 'Reconnecting... 1/5 (boom)' });
    expect(retry).toEqual([
      { kind: 'notice', text: 'Reconnecting... 1/5 (boom)', coalesceKey: 'Reconnecting' },
    ]);
    const plain = parseCodexEvent({ type: 'error', message: 'stream disconnected' });
    expect(plain).toEqual([
      { kind: 'notice', text: 'stream disconnected', coalesceKey: undefined },
    ]);
  });

  it('flags a `gh pr create` command so its result gets scanned for the PR URL', () => {
    const [event] = parseCodexEvent({
      type: 'item.started',
      item: {
        id: 'item_0',
        type: 'command_execution',
        command: 'gh pr create --draft --fill',
        aggregated_output: '',
        exit_code: null,
        status: 'in_progress',
      },
    });
    expect(event).toMatchObject({ kind: 'tool_use', tool: 'shell', prCreate: true });
  });

  it('ignores item.updated for anything but todo_list (only todos update in place)', () => {
    expect(
      parseCodexEvent({
        type: 'item.updated',
        item: { id: 'item_0', type: 'agent_message', text: 'partial' },
      }),
    ).toEqual([]);
  });

  it('drops an empty reasoning summary instead of logging a blank system line', () => {
    expect(
      parseCodexEvent({
        type: 'item.completed',
        item: { id: 'item_0', type: 'reasoning', text: '   \n ' },
      }),
    ).toEqual([]);
  });

  it('summarizes web_search and mcp_tool_call as generic tool lines', () => {
    expect(
      parseCodexEvent({
        type: 'item.started',
        item: { id: 'i1', type: 'web_search', query: 'ink flexbox' },
      }),
    ).toEqual([{ kind: 'tool_use', id: 'i1', summary: 'web_search ink flexbox', tool: 'other' }]);
    expect(
      parseCodexEvent({
        type: 'item.started',
        item: {
          id: 'i2',
          type: 'mcp_tool_call',
          server: 'fs',
          tool: 'read',
          status: 'in_progress',
        },
      }),
    ).toEqual([{ kind: 'tool_use', id: 'i2', summary: 'fs/read', tool: 'other' }]);
  });

  it.each([
    ['to-stderr\n', 3, 'failed', 'to-stderr (exit 3)'],
    ['hello\n', 0, 'completed', 'hello'],
    // 出力の無い失敗は終了コードだけ（`exited 3 (exit 3)` と二重に書かない）。
    ['', 3, 'failed', 'exited 3'],
    ['', null, 'declined', 'exited ?'],
    ['', 0, 'completed', ''],
  ] as const)(
    'summarizes a command result (%j, exit %s, %s) as %j',
    (aggregated_output, exit_code, status, expected) => {
      expect(
        parseCodexEvent({
          type: 'item.completed',
          item: {
            id: 'i1',
            type: 'command_execution',
            command: 'x',
            aggregated_output,
            exit_code,
            status,
          },
        }),
      ).toEqual([
        { kind: 'tool_result', toolUseId: 'i1', summary: expected, scanText: aggregated_output },
      ]);
    },
  );

  it('an item-level error is a notice, not a turn failure (the turn keeps going)', () => {
    expect(
      parseCodexEvent({
        type: 'item.completed',
        item: { id: 'i1', type: 'error', message: 'model not found' },
      }),
    ).toEqual([{ kind: 'notice', text: 'model not found' }]);
  });
});

describe('toCodexEvent', () => {
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'thread.started'],
    ['a number', 42],
    ['an array', []],
    ['an object without a type', {}],
    ['a non-string type', { type: 123 }],
    ['an unknown event type', { type: 'thread.finished' }],
  ])('rejects %s', (_name, value) => {
    expect(toCodexEvent(value)).toBeUndefined();
  });

  it.each([
    ['thread.started', { type: 'thread.started', thread_id: 'th-1' }],
    ['turn.started', { type: 'turn.started' }],
    ['turn.completed', { type: 'turn.completed' }],
    ['turn.failed', { type: 'turn.failed', error: { message: 'boom' } }],
    ['item.started', { type: 'item.started', item: { id: 'i', type: 'todo_list', items: [] } }],
    ['item.updated', { type: 'item.updated', item: { id: 'i', type: 'todo_list', items: [] } }],
    ['item.completed', { type: 'item.completed', item: { id: 'i', type: 'reasoning', text: 'x' } }],
    ['error', { type: 'error', message: 'boom' }],
  ])('accepts a well-formed %s', (_name, value) => {
    expect(toCodexEvent(value)).toBe(value);
  });

  // parseCodexEvent は受理されたイベントの中身を無条件に読む（`event.error.message` /
  // `event.item.type`）ので、欠けた行を通すとパースが TypeError で落ち、
  // アダプタのジェネレータごとターンが死ぬ。
  it.each([
    ['turn.failed without an error object', { type: 'turn.failed' }],
    ['turn.failed whose error carries no message', { type: 'turn.failed', error: {} }],
    ['item.started without an item', { type: 'item.started' }],
    ['item.completed whose item has no type', { type: 'item.completed', item: { id: 'i' } }],
    ['error without a message', { type: 'error' }],
    ['thread.started without a thread_id', { type: 'thread.started' }],
  ])('rejects %s rather than letting the parser throw on it', (_name, value) => {
    const event = toCodexEvent(value);
    expect(event).toBeUndefined();
    // 受理してしまった場合に何が起きるかの番人（捨てていれば呼ばれない）。
    if (event) {
      expect(() => parseCodexEvent(event)).not.toThrow();
    }
  });
});
