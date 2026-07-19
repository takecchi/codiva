import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { beforeAll, describe, expect, it } from 'vitest';
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

/** Replay an SDK message stream through the reducer with synthetic timestamps. */
function replay(messages: SDKMessage[], from = initialState(BASE)): SessionState {
  let state = from;
  let at = BASE.startedAt;
  for (const message of messages) {
    at += 1;
    state = reduce(state, { kind: 'sdk', message, at });
  }
  return state;
}

describe('reduce over real fixtures', () => {
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

describe('control events', () => {
  it('creating → running on first init', () => {
    const s0 = initialState(BASE);
    expect(s0.status).toBe('creating');
  });

  it('permission_request (tool) → awaiting_permission and stores the request', () => {
    const req: PermissionRequest = { id: 'p1', toolName: 'Bash', input: {}, kind: 'tool' };
    const state = reduce(initialState(BASE), {
      kind: 'permission_request',
      request: req,
      at: 2000,
    });
    expect(state.status).toBe('awaiting_permission');
    expect(state.pendingPermission?.toolName).toBe('Bash');
  });

  it('permission_request (question) → awaiting_input', () => {
    const req: PermissionRequest = {
      id: 'q1',
      toolName: 'AskUserQuestion',
      input: { questions: [{ question: 'Which one?' }] },
      kind: 'question',
      questions: [{ question: 'Which one?', header: 'x', multiSelect: false, options: [] }],
    };
    const state = reduce(initialState(BASE), {
      kind: 'permission_request',
      request: req,
      at: 2000,
    });
    expect(state.status).toBe('awaiting_input');
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
    state = reduce(state, {
      kind: 'sdk',
      message: {
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', id: 't1', name: 'AskUserQuestion', input: req.input }],
        },
      } as unknown as SDKMessage,
      at: 2001,
    });
    expect(state.status).toBe('awaiting_input');
    expect(state.pendingPermission?.kind).toBe('question');
  });

  it('keeps awaiting_permission when a stream delta arrives while a tool prompt is pending', () => {
    const req: PermissionRequest = { id: 'p1', toolName: 'Bash', input: {}, kind: 'tool' };
    let state = reduce(initialState(BASE), { kind: 'permission_request', request: req, at: 2000 });
    expect(state.status).toBe('awaiting_permission');
    state = reduce(state, {
      kind: 'sdk',
      message: {
        type: 'stream_event',
        event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'x' } },
      } as unknown as SDKMessage,
      at: 2001,
    });
    expect(state.status).toBe('awaiting_permission');
  });

  it('permission_resolved clears the pending request and resumes', () => {
    const req: PermissionRequest = { id: 'p1', toolName: 'Bash', input: {}, kind: 'tool' };
    let state = reduce(initialState(BASE), { kind: 'permission_request', request: req, at: 2000 });
    state = reduce(state, { kind: 'permission_resolved', at: 2001 });
    expect(state.status).toBe('running');
    expect(state.pendingPermission).toBeUndefined();
  });

  it('user_input resumes a completed session and clears finishedAt', () => {
    let state: SessionState = { ...initialState(BASE), status: 'completed', finishedAt: 5000 };
    state = reduce(state, { kind: 'user_input', text: 'do more', at: 6000 });
    expect(state.status).toBe('running');
    expect(state.finishedAt).toBeUndefined();
    expect(state.messages.at(-1)?.text).toBe('do more');
  });

  it('aborted → failed with an error', () => {
    const state = reduce(initialState(BASE), { kind: 'aborted', error: 'killed', at: 7000 });
    expect(state.status).toBe('failed');
    expect(state.error).toBe('killed');
  });

  it('returns the same reference for ignored/no-op events', () => {
    const s0: SessionState = { ...initialState(BASE), status: 'running' };
    const s1 = reduce(s0, { kind: 'permission_resolved', at: 1 }); // no pending → no-op
    expect(s1).toBe(s0);
  });

  it('captures the resolved model from system/init even when config left it unset', () => {
    const init = {
      type: 'system',
      subtype: 'init',
      session_id: 'abc',
      model: 'claude-haiku-4-5',
    } as unknown as SDKMessage;
    const state = reduce(initialState(BASE), { kind: 'sdk', message: init, at: 1 });
    expect(state.model).toBe('claude-haiku-4-5');
  });

  it('tracks a mid-session model switch from an assistant message', () => {
    const s0: SessionState = { ...initialState(BASE), status: 'running', model: 'claude-opus-4-8' };
    const assistant = {
      type: 'assistant',
      message: { model: 'claude-sonnet-4-5', content: [{ type: 'text', text: 'hi' }] },
    } as unknown as SDKMessage;
    const state = reduce(s0, { kind: 'sdk', message: assistant, at: 2 });
    expect(state.model).toBe('claude-sonnet-4-5');
  });

  it('reflects a per-session model switch, and no-ops when unchanged', () => {
    const s0: SessionState = { ...initialState(BASE), status: 'running', model: 'claude-opus-4-8' };
    const s1 = reduce(s0, { kind: 'model', model: 'claude-fable-5', at: 1 });
    expect(s1.model).toBe('claude-fable-5');
    // Same model again → same reference (subscribers don't re-render).
    expect(reduce(s1, { kind: 'model', model: 'claude-fable-5', at: 2 })).toBe(s1);
    // Switching back to the CLI default clears the resolved model.
    expect(reduce(s1, { kind: 'model', model: undefined, at: 3 }).model).toBeUndefined();
  });

  it('archives once, then is idempotent', () => {
    const s1 = reduce({ ...initialState(BASE), status: 'completed' }, { kind: 'archived', at: 1 });
    expect(s1.status).toBe('archived');
    expect(reduce(s1, { kind: 'archived', at: 2 })).toBe(s1);
  });

  it('defaults aborted error text to "aborted"', () => {
    const s = reduce(initialState(BASE), { kind: 'aborted', at: 1 });
    expect(s.error).toBe('aborted');
  });

  it('replaces the title from a generated title event (normalized)', () => {
    const s = reduce(initialState(BASE), {
      kind: 'title',
      title: '  Add   OAuth login\nflow  ',
      at: 1,
    });
    expect(s.title).toBe('Add OAuth login flow');
  });

  it('ignores an empty/whitespace generated title (keeps placeholder)', () => {
    const s0 = initialState(BASE);
    expect(reduce(s0, { kind: 'title', title: '   ', at: 1 })).toBe(s0);
  });

  it('is a no-op when the generated title equals the current one', () => {
    const s0 = initialState(BASE);
    expect(reduce(s0, { kind: 'title', title: s0.title, at: 1 })).toBe(s0);
  });
});

/** Synthetic SDK messages to exercise edge paths not present in the fixtures. */
function sdk(state: SessionState, message: unknown, at = 1): SessionState {
  return reduce(state, { kind: 'sdk', message: message as SDKMessage, at });
}

describe('reduce over synthetic SDK messages', () => {
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

describe('reduce over rate-limit signals', () => {
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

  it('an aborted event carrying a rate-limit error is rate_limited, not failed', () => {
    const state = reduce(running, {
      kind: 'aborted',
      error: "Error: You've hit your limit",
      at: 5000,
    });
    expect(state.status).toBe('rate_limited');
  });

  it('a genuine (non-limit) error still fails', () => {
    const state = reduce(running, { kind: 'aborted', error: 'connection reset', at: 5000 });
    expect(state.status).toBe('failed');
  });
});

/** A partial-assistant stream_event (from includePartialMessages). */
function streamText(text: string) {
  return {
    type: 'stream_event',
    event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
  };
}

describe('reduce over streaming partial messages', () => {
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

  it('pr event stores the PR and no-ops when unchanged', () => {
    const s0 = initialState(BASE);
    expect(s0.pr).toBeUndefined();

    const withPr = reduce(s0, {
      kind: 'pr',
      pr: { number: 12, url: 'https://x/12', mergeStatus: 'unknown' },
      at: 1,
    });
    expect(withPr.pr).toEqual({ number: 12, url: 'https://x/12', mergeStatus: 'unknown' });

    // Same PR again → same reference (no re-render on every poll).
    expect(
      reduce(withPr, {
        kind: 'pr',
        pr: { number: 12, url: 'https://x/12', mergeStatus: 'unknown' },
        at: 2,
      }),
    ).toBe(withPr);

    // mergeStatus flipping on the same PR is a change → repaints the glyph.
    expect(
      reduce(withPr, {
        kind: 'pr',
        pr: { number: 12, url: 'https://x/12', mergeStatus: 'merged' },
        at: 2,
      }).pr?.mergeStatus,
    ).toBe('merged');

    // A different PR replaces it; undefined clears it.
    expect(
      reduce(withPr, {
        kind: 'pr',
        pr: { number: 13, url: 'https://x/13', mergeStatus: 'mergeable' },
        at: 3,
      }).pr,
    ).toEqual({ number: 13, url: 'https://x/13', mergeStatus: 'mergeable' });
    expect(reduce(withPr, { kind: 'pr', pr: undefined, at: 4 }).pr).toBeUndefined();
    // Already undefined → same reference.
    expect(reduce(s0, { kind: 'pr', pr: undefined, at: 5 })).toBe(s0);
  });

  it('clears the streaming preview when aborted or archived mid-stream', () => {
    const streaming = sdk({ ...initialState(BASE), status: 'running' }, streamText('half'));
    expect(streaming.streamingText).toBe('half');

    const aborted = reduce(streaming, { kind: 'aborted', at: 9 });
    expect(aborted.status).toBe('failed');
    expect(aborted.streamingText).toBeUndefined();

    const archived = reduce(streaming, { kind: 'archived', at: 9 });
    expect(archived.status).toBe('archived');
    expect(archived.streamingText).toBeUndefined();
  });
});

describe('conflict event', () => {
  it('sets status to conflict, records files, and logs a summary', () => {
    const completed: SessionState = { ...initialState(BASE), status: 'completed' };
    const next = reduce(completed, { kind: 'conflict', files: ['a.ts', 'b.ts'], at: 5 });
    expect(next.status).toBe('conflict');
    expect(next.conflictFiles).toEqual(['a.ts', 'b.ts']);
    expect(next.messages.at(-1)).toMatchObject({
      kind: 'error',
      text: 'merge conflict in a.ts, b.ts',
    });
  });

  it('handles an empty file list', () => {
    const next = reduce(initialState(BASE), { kind: 'conflict', files: [], at: 5 });
    expect(next.status).toBe('conflict');
    expect(next.messages.at(-1)?.text).toBe('merge conflict');
  });
});

describe('pr event with isDraft', () => {
  it('re-renders when only the draft flag changes', () => {
    const draft: SessionState = {
      ...initialState(BASE),
      pr: { number: 3, url: 'u', mergeStatus: 'unknown', isDraft: true },
    };
    const next = reduce(draft, {
      kind: 'pr',
      pr: { number: 3, url: 'u', mergeStatus: 'unknown', isDraft: false },
      at: 1,
    });
    expect(next).not.toBe(draft);
    expect(next.pr?.isDraft).toBe(false);
  });

  it('no-ops when number, url and draft flag are unchanged', () => {
    const draft: SessionState = {
      ...initialState(BASE),
      pr: { number: 3, url: 'u', mergeStatus: 'unknown', isDraft: true },
    };
    const next = reduce(draft, {
      kind: 'pr',
      pr: { number: 3, url: 'u', mergeStatus: 'unknown', isDraft: true },
      at: 1,
    });
    expect(next).toBe(draft);
  });
});
