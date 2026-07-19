import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { beforeAll, describe, expect, it } from 'vitest';
import { applySdkMessage } from '@/core/sdk-parse';
import { initialState, reduce } from '@/core/status-reducer';
import type { CreateSessionInput, PermissionRequest, SessionState } from '@/core/types';

function loadFixture(name: string): SDKMessage[] {
  const path = fileURLToPath(new URL(`./__fixtures__/${name}`, import.meta.url));
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as SDKMessage);
}

const BASE: CreateSessionInput = {
  id: 's1',
  title: 'demo',
  prompt: 'demo prompt',
  branch: 'codiva/demo',
  worktreePath: '/tmp/demo',
  startedAt: 1000,
};

/** Replay an SDK message stream through applySdkMessage with synthetic timestamps. */
function replay(messages: SDKMessage[], from = initialState(BASE)): SessionState {
  let state = from;
  let at = BASE.startedAt;
  for (const message of messages) {
    at += 1;
    state = applySdkMessage(state, message, at);
  }
  return state;
}

/** Apply a single (possibly synthetic) SDK message. */
function sdk(state: SessionState, message: unknown, at = 1): SessionState {
  return applySdkMessage(state, message as SDKMessage, at);
}

describe('applySdkMessage over real fixtures', () => {
  let basic: SDKMessage[];
  let followup: SDKMessage[];
  let interrupted: SDKMessage[];

  beforeAll(() => {
    basic = loadFixture('session-basic.jsonl');
    followup = loadFixture('session-followup.jsonl');
    interrupted = loadFixture('session-interrupt.jsonl');
  });

  it('reaches completed on a successful session', () => {
    const state = replay(basic);
    expect(state.status).toBe('completed');
    expect(state.finishedAt).toBeGreaterThan(BASE.startedAt);
  });

  it('captures the SDK session_id from system/init', () => {
    const state = replay(basic);
    expect(state.sdkSessionId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('captures the resolved model from the SDK stream', () => {
    const state = replay(basic);
    expect(state.model).toBe('claude-opus-4-8');
  });

  it('builds the todo list from TaskCreate/TaskUpdate and marks it done', () => {
    const state = replay(basic);
    expect(state.todos.length).toBeGreaterThanOrEqual(2);
    expect(state.progress).toEqual({ done: state.todos.length, total: state.todos.length });
    expect(state.todos.every((t) => t.status === 'completed')).toBe(true);
    // ids are the sequential strings the SDK assigns
    expect(state.todos[0]?.id).toBe('1');
  });

  it('records assistant text and a final result in the log', () => {
    const state = replay(basic);
    expect(state.messages.some((m) => m.kind === 'assistant_text')).toBe(true);
    expect(state.messages.some((m) => m.kind === 'tool_use')).toBe(true);
    expect(state.messages.some((m) => m.kind === 'result')).toBe(true);
  });

  it('keeps a stable session_id across a multi-turn (followup) session', () => {
    const state = replay(followup);
    expect(state.status).toBe('completed');
    const ids = new Set(followup.filter((m) => 'session_id' in m).map((m) => m.session_id));
    expect(ids.size).toBe(1);
    expect(state.sdkSessionId).toBe([...ids][0]);
  });

  it('marks a session failed when the turn ends in error_during_execution', () => {
    const state = replay(interrupted);
    expect(state.status).toBe('failed');
    expect(state.error).toContain('error');
  });
});

describe('applySdkMessage interaction with pending control state', () => {
  it('captures the resolved model from system/init even when config left it unset', () => {
    const init = {
      type: 'system',
      subtype: 'init',
      session_id: 'abc',
      model: 'claude-haiku-4-5',
    } as unknown as SDKMessage;
    const state = applySdkMessage(initialState(BASE), init, 1);
    expect(state.model).toBe('claude-haiku-4-5');
  });

  it('tracks a mid-session model switch from an assistant message', () => {
    const s0: SessionState = { ...initialState(BASE), status: 'running', model: 'claude-opus-4-8' };
    const assistant = {
      type: 'assistant',
      message: { model: 'claude-sonnet-4-5', content: [{ type: 'text', text: 'hi' }] },
    } as unknown as SDKMessage;
    const state = applySdkMessage(s0, assistant, 2);
    expect(state.model).toBe('claude-sonnet-4-5');
  });

  it('keeps awaiting_input when the assistant message carrying the question is processed after it', () => {
    // The `assistant` message (with the AskUserQuestion tool_use) and the
    // canUseTool control callback arrive out-of-band. If canUseTool wins the
    // race we're already in awaiting_input; processing the assistant message
    // must NOT downgrade the badge back to Running.
    const req: PermissionRequest = {
      id: 'q1',
      toolName: 'AskUserQuestion',
      input: { questions: [{ question: 'Which one?' }] },
      kind: 'question',
      questions: [{ question: 'Which one?', header: 'x', multiSelect: false, options: [] }],
    };
    let state = reduce(initialState(BASE), { kind: 'permission_request', request: req, at: 2000 });
    expect(state.status).toBe('awaiting_input');
    state = sdk(
      state,
      {
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', id: 't1', name: 'AskUserQuestion', input: req.input }],
        },
      },
      2001,
    );
    expect(state.status).toBe('awaiting_input');
    expect(state.pendingPermission?.kind).toBe('question');
  });

  it('keeps awaiting_permission when a stream delta arrives while a tool prompt is pending', () => {
    const req: PermissionRequest = { id: 'p1', toolName: 'Bash', input: {}, kind: 'tool' };
    let state = reduce(initialState(BASE), { kind: 'permission_request', request: req, at: 2000 });
    expect(state.status).toBe('awaiting_permission');
    state = sdk(
      state,
      {
        type: 'stream_event',
        event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'x' } },
      },
      2001,
    );
    expect(state.status).toBe('awaiting_permission');
  });
});

describe('applySdkMessage over synthetic SDK messages', () => {
  it('supports the legacy TodoWrite tool (whole-list replace)', () => {
    const msg = {
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            id: 't1',
            name: 'TodoWrite',
            input: {
              todos: [
                { content: 'a', status: 'completed' },
                { content: 'b', status: 'in_progress' },
                { content: 'c', status: 'pending' },
              ],
            },
          },
        ],
      },
    };
    const state = sdk(initialState(BASE), msg);
    expect(state.todos.map((t) => t.subject)).toEqual(['a', 'b', 'c']);
    expect(state.progress).toEqual({ done: 1, total: 3 });
  });

  it('excludes deleted tasks from progress', () => {
    let state = sdk(initialState(BASE), {
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', id: '1', name: 'TaskCreate', input: { subject: 'x' } },
          { type: 'tool_use', id: '2', name: 'TaskCreate', input: { subject: 'y' } },
        ],
      },
    });
    state = sdk(state, {
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            id: '3',
            name: 'TaskUpdate',
            input: { taskId: '2', status: 'deleted' },
          },
        ],
      },
    });
    expect(state.progress).toEqual({ done: 0, total: 1 });
  });

  it('summarizes Edit/Bash/unknown tools in the log', () => {
    const state = sdk(initialState(BASE), {
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', id: '1', name: 'Edit', input: { file_path: 'x.ts' } },
          { type: 'tool_use', id: '2', name: 'Bash', input: { command: 'ls' } },
          { type: 'tool_use', id: '3', name: 'Grep', input: { pattern: 'foo' } },
        ],
      },
    });
    const texts = state.messages.map((m) => m.text);
    expect(texts).toContain('Edit x.ts');
    expect(texts).toContain('Bash ls');
    expect(texts).toContain('Grep');
  });

  it('running with empty assistant content flips status but adds no log', () => {
    const state = sdk(initialState(BASE), { type: 'assistant', message: { content: [] } });
    expect(state.status).toBe('running');
    expect(state.messages).toHaveLength(0);
  });

  it('logs a tool_result line from a user message', () => {
    const state = sdk(initialState(BASE), {
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: '1', content: 'Task #1 created' }] },
    });
    expect(state.messages.at(-1)).toMatchObject({ kind: 'tool_result', text: 'Task #1 created' });
  });

  it('completes without a result string and without a cost', () => {
    const state = sdk(
      { ...initialState(BASE), status: 'running' },
      { type: 'result', subtype: 'success' },
    );
    expect(state.status).toBe('completed');
    expect(state.totalCostUsd).toBeUndefined();
    expect(state.messages.some((m) => m.kind === 'result')).toBe(false);
  });

  it('fails with the error subtype as the error text', () => {
    const state = sdk(
      { ...initialState(BASE), status: 'running' },
      {
        type: 'result',
        subtype: 'error_max_turns',
      },
    );
    expect(state.status).toBe('failed');
    expect(state.error).toBe('error_max_turns');
  });

  it('ignores unrelated system subtypes and noise messages', () => {
    const s0: SessionState = { ...initialState(BASE), status: 'running' };
    expect(sdk(s0, { type: 'system', subtype: 'thinking_tokens' })).toBe(s0);
    expect(sdk(s0, { type: 'rate_limit_event' })).toBe(s0);
  });
});

describe('applySdkMessage over rate-limit signals', () => {
  const running: SessionState = { ...initialState(BASE), status: 'running' };

  it('a rejected rate_limit_event stops the session as rate_limited with its reset time', () => {
    const state = sdk(running, {
      type: 'rate_limit_event',
      rate_limit_info: { status: 'rejected', resetsAt: 4242, rateLimitType: 'five_hour' },
    });
    expect(state.status).toBe('rate_limited');
    expect(state.rateLimitResetsAt).toBe(4242);
    expect(state.finishedAt).toBeGreaterThan(0);
    expect(state.streamingText).toBeUndefined();
    expect(state.messages.at(-1)).toMatchObject({ kind: 'system' });
  });

  it('an allowed / warning rate_limit_event leaves state untouched', () => {
    expect(sdk(running, { type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } })).toBe(
      running,
    );
    expect(
      sdk(running, { type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning' } }),
    ).toBe(running);
  });

  it("an assistant message with error 'rate_limit' flips to rate_limited", () => {
    const state = sdk(running, {
      type: 'assistant',
      error: 'rate_limit',
      message: { content: [] },
    });
    expect(state.status).toBe('rate_limited');
  });

  it('a usage-limit result is rate_limited, not failed', () => {
    const state = sdk(running, {
      type: 'result',
      subtype: 'error_during_execution',
      result: "You've reached your usage limit. Try again later.",
      total_cost_usd: 0.5,
    });
    expect(state.status).toBe('rate_limited');
    expect(state.totalCostUsd).toBe(0.5);
  });
});

/** A partial-assistant stream_event (from includePartialMessages). */
function streamText(text: string) {
  return {
    type: 'stream_event',
    event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
  };
}

describe('applySdkMessage over streaming partial messages', () => {
  it('accumulates text_delta into streamingText and flips to running', () => {
    let state = sdk(initialState(BASE), streamText('Hel'));
    expect(state.status).toBe('running');
    expect(state.streamingText).toBe('Hel');
    state = sdk(state, streamText('lo'));
    expect(state.streamingText).toBe('Hello');
  });

  it('message_start resets the streaming preview', () => {
    const running = sdk(initialState(BASE), streamText('stale'));
    const reset = sdk(running, { type: 'stream_event', event: { type: 'message_start' } });
    expect(reset.streamingText).toBeUndefined();
  });

  it('the full assistant message clears the streaming preview and logs the text', () => {
    const streaming = sdk(initialState(BASE), streamText('partial answer'));
    const final = sdk(streaming, {
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'partial answer done' }] },
    });
    expect(final.streamingText).toBeUndefined();
    expect(final.messages.at(-1)).toMatchObject({
      kind: 'assistant_text',
      text: 'partial answer done',
    });
  });

  it('a result clears any dangling streaming preview', () => {
    const streaming = sdk({ ...initialState(BASE), status: 'running' }, streamText('half'));
    const done = sdk(streaming, { type: 'result', subtype: 'success', result: 'ok' });
    expect(done.status).toBe('completed');
    expect(done.streamingText).toBeUndefined();
  });

  it('non-text and empty-text deltas are no-ops (same reference)', () => {
    const s0: SessionState = { ...initialState(BASE), status: 'running' };
    expect(
      sdk(s0, {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '{}' },
        },
      }),
    ).toBe(s0);
    // An empty text_delta changes nothing observable → must keep the same reference.
    expect(
      sdk(s0, {
        type: 'stream_event',
        event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '' } },
      }),
    ).toBe(s0);
    expect(sdk(s0, { type: 'stream_event' })).toBe(s0);
    expect(sdk(s0, { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } })).toBe(
      s0,
    );
  });
});
