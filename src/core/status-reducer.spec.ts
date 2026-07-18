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
