import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { beforeAll, describe, expect, it } from 'vitest';
import { MAX_LOG_ENTRIES, MAX_LOG_ENTRY_CHARS, MAX_STREAM_PREVIEW_CHARS } from '@/core/log-buffer';
import { applySdkMessage, summarizeToolUse, toolResultSummary } from '@/core/sdk-parse';
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
  let subagent: SDKMessage[];

  beforeAll(() => {
    basic = loadFixture('session-basic.jsonl');
    followup = loadFixture('session-followup.jsonl');
    interrupted = loadFixture('session-interrupt.jsonl');
    subagent = loadFixture('session-subagent.jsonl');
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

  it('records assistant text and tool use, without doubling the final message', () => {
    const state = replay(basic);
    expect(state.messages.some((m) => m.kind === 'assistant_text')).toBe(true);
    expect(state.messages.some((m) => m.kind === 'tool_use')).toBe(true);
    // The success `result` echoes the final assistant text (identical string in
    // real transcripts), so it must NOT be logged again as a green `result` line
    // — otherwise the last message shows twice (white assistant_text + green).
    expect(state.messages.some((m) => m.kind === 'result')).toBe(false);
    const finalText = state.messages.findLast((m) => m.kind === 'assistant_text')?.text;
    expect(state.messages.filter((m) => m.text === finalText)).toHaveLength(1);
  });

  it('keeps a stable session_id across a multi-turn (followup) session', () => {
    const state = replay(followup);
    expect(state.status).toBe('completed');
    const ids = new Set(followup.filter((m) => 'session_id' in m).map((m) => m.session_id));
    expect(ids.size).toBe(1);
    expect(state.sdkSessionId).toBe([...ids][0]);
  });

  // 実データ: interrupt() を呼ぶと CLI は `[Request interrupted by user]` の user メッセージ →
  // `error_during_execution` + `terminal_reason: 'aborted_streaming'` の result でターンを閉じる。
  // 自分で止めたのだから失敗ではない = 再開できる `interrupted` に落とす（`failed` だと
  // 再開アクションが出ず、内部診断テキストがエラーとしてログに残る）。
  it('lands on interrupted (resumable) when the user aborted the turn', () => {
    const state = replay(interrupted);
    expect(state.status).toBe('interrupted');
    expect(state.error).toBeUndefined();
    expect(state.messages.at(-1)?.text).toBe('interrupted by user');
    // CLI の内部診断（[ede_diagnostic] …）はログに出さない。
    expect(state.messages.some((entry) => entry.text.includes('ede_diagnostic'))).toBe(false);
  });

  it('reaches completed on a session that delegated to a sub-agent (Task tool)', () => {
    // Real capture: the sub-agent settled (task_notification) before the top-level
    // result, so the session completes cleanly and no task stays in flight.
    const state = replay(subagent);
    expect(state.status).toBe('completed');
    expect(state.activeTaskIds ?? []).toHaveLength(0);
    expect(state.deferredResult).toBeUndefined();
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

  it('keeps awaiting_input when a system/init arrives while a question is pending', () => {
    // Defensive: a (re)started query emits system/init → running. It must not
    // downgrade a session that is blocked on a pending question back to Running.
    const req: PermissionRequest = {
      id: 'q1',
      toolName: 'AskUserQuestion',
      input: {},
      kind: 'question',
      questions: [{ question: 'Which one?', header: 'x', multiSelect: false, options: [] }],
    };
    let state = reduce(initialState(BASE), { kind: 'permission_request', request: req, at: 2000 });
    expect(state.status).toBe('awaiting_input');
    state = sdk(state, { type: 'system', subtype: 'init', session_id: 'abc' }, 2001);
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

  it('classifies an error result that carries its reason in errors[] rather than result', () => {
    const state = sdk(running, {
      type: 'result',
      subtype: 'error_during_execution',
      errors: ['fetch failed'],
    });
    expect(state.status).toBe('interrupted');
  });

  it('a connection-error result is interrupted (resumable), not failed', () => {
    const state = sdk(running, {
      type: 'result',
      subtype: 'error_during_execution',
      result: 'Connection error.',
      total_cost_usd: 0.25,
    });
    expect(state.status).toBe('interrupted');
    expect(state.error).toBeUndefined();
    expect(state.totalCostUsd).toBe(0.25);
    expect(state.messages.at(-1)).toMatchObject({ kind: 'system', text: 'Connection error.' });
  });
});

describe('applySdkMessage over authentication failures', () => {
  const running: SessionState = { ...initialState(BASE), status: 'running' };
  const AUTH = 'Failed to authenticate: OAuth session expired and could not be refreshed';

  /**
   * The wire shape the CLI actually produces for an aged-out login: a synthesized
   * assistant message flagged with the typed `error` kind, carrying the reason as
   * its text — immediately followed by the `result` that rolls it up.
   */
  const authAssistant = {
    type: 'assistant',
    error: 'authentication_failed',
    message: {
      role: 'assistant',
      stop_reason: 'stop_sequence',
      content: [{ type: 'text', text: AUTH }],
    },
  };
  const authResult = {
    type: 'result',
    subtype: 'success',
    is_error: true,
    api_error_status: null,
    terminal_reason: 'api_error',
    result: AUTH,
    total_cost_usd: 0,
  };

  it("an assistant message with error 'authentication_failed' flips to needs_login", () => {
    // The primary signal: typed, so it works whatever wording the CLI uses.
    const state = sdk(running, authAssistant);
    expect(state.status).toBe('needs_login');
    expect(state.error).toBe(AUTH);
    expect(state.finishedAt).toBeGreaterThan(0);
    expect(state.streamingText).toBeUndefined();
    // The reason is logged once, and NOT as a normal assistant_text line.
    expect(state.messages).toEqual([{ seq: 1, kind: 'error', text: AUTH, timestamp: undefined }]);
  });

  it("treats 'oauth_org_not_allowed' as needing a login too", () => {
    const state = sdk(running, {
      type: 'assistant',
      error: 'oauth_org_not_allowed',
      message: { content: [{ type: 'text', text: 'Your organization has disabled access' }] },
    });
    expect(state.status).toBe('needs_login');
  });

  it('a `success` result flagged is_error is NOT a completion — an expired login is needs_login', () => {
    // The regression this state exists for: the CLI reports an expired OAuth
    // session with subtype 'success' + is_error, which used to show up as a
    // green "Completed" badge for a session that never ran.
    const state = sdk(running, authResult);
    expect(state.status).toBe('needs_login');
    expect(state.error).toBe(AUTH);
    expect(state.messages.at(-1)).toMatchObject({ kind: 'error', text: AUTH });
  });

  it('logs the failure once when both the assistant message and its result arrive', () => {
    // The two messages describe the same failure, so the roll-up result must not
    // append a second log line (it only records the cost the result carries).
    const first = sdk(running, authAssistant, 10);
    const second = sdk(first, authResult, 11);
    expect(second.status).toBe('needs_login');
    expect(second.messages).toBe(first.messages);
    expect(second.messages.filter((msg) => msg.text === AUTH)).toHaveLength(1);
    expect(second.finishedAt).toBe(first.finishedAt);
  });

  it('an error-subtype result carrying an auth failure in errors[] is needs_login, not failed', () => {
    // The error result variants carry `errors: string[]`, not `result`.
    const state = sdk(running, {
      type: 'result',
      subtype: 'error_during_execution',
      errors: [AUTH],
      total_cost_usd: 0.125,
    });
    expect(state.status).toBe('needs_login');
    expect(state.totalCostUsd).toBe(0.125);
  });

  it('an is_error success with an unclassifiable message still fails (never completes)', () => {
    const state = sdk(running, {
      type: 'result',
      subtype: 'success',
      is_error: true,
      result: 'Credit balance is too low',
    });
    expect(state.status).toBe('failed');
    expect(state.error).toBe('Credit balance is too low');
  });

  it('a plain success result is unaffected (is_error absent or false)', () => {
    expect(sdk(running, { type: 'result', subtype: 'success', result: 'done' }).status).toBe(
      'completed',
    );
    expect(
      sdk(running, { type: 'result', subtype: 'success', is_error: false, result: 'done' }).status,
    ).toBe('completed');
  });

  it('does not mistake Claude reporting on auth work for a real auth failure', () => {
    // A successful turn whose text merely mentions authentication must still
    // complete — only the SDK's own is_error flag routes result text to a stop.
    const state = sdk(running, {
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'Fixed the login flow: the OAuth session now refreshes before it expires.',
    });
    expect(state.status).toBe('completed');
  });
});

describe('applySdkMessage over mid-response API errors', () => {
  const running: SessionState = { ...initialState(BASE), status: 'running', sdkSessionId: 'sdk-1' };
  const CUT = 'API Error: Connection closed mid-response. The response above may be incomplete.';

  /**
   * The wire shape the CLI actually produces when the response stream dies after
   * some content was already delivered: it finalizes the partial answer as an
   * assistant message flagged `error: 'server_error'` whose text is the notice,
   * then rolls it up into a `success` result flagged `is_error` with
   * `terminal_reason: 'api_error'` and `api_error_status: null` (no HTTP response).
   */
  const cutAssistant = {
    type: 'assistant',
    error: 'server_error',
    message: { role: 'assistant', content: [{ type: 'text', text: CUT }] },
  };
  const cutResult = {
    type: 'result',
    subtype: 'success',
    is_error: true,
    api_error_status: null,
    terminal_reason: 'api_error',
    result: CUT,
    total_cost_usd: 0.75,
  };

  it('a truncated response is interrupted (resumable), not a completion', () => {
    // The regression: the notice used to be logged as ordinary assistant text and
    // the roll-up result showed a green "Completed" for a half-written answer.
    const state = sdk({ ...running, streamingText: 'half a sen' }, cutAssistant);
    expect(state.status).toBe('interrupted');
    expect(state.finishedAt).toBeGreaterThan(0);
    expect(state.streamingText).toBeUndefined();
    // Not a failure: `error` stays unset and the notice is a system line.
    expect(state.error).toBeUndefined();
    expect(state.messages).toEqual([{ seq: 1, kind: 'system', text: CUT, timestamp: undefined }]);
  });

  it('logs the interruption once when both the assistant message and its result arrive', () => {
    const first = sdk(running, cutAssistant, 10);
    const second = sdk(first, cutResult, 11);
    expect(second.status).toBe('interrupted');
    expect(second.messages).toBe(first.messages);
    expect(second.messages.filter((msg) => msg.text === CUT)).toHaveLength(1);
    // The result still contributes the turn's cost.
    expect(second.totalCostUsd).toBe(0.75);
  });

  it('the roll-up result alone is enough (the assistant message may not be seen)', () => {
    const state = sdk(running, cutResult);
    expect(state.status).toBe('interrupted');
    expect(state.messages.at(-1)).toMatchObject({ kind: 'system', text: CUT });
  });

  it("an assistant message with error 'overloaded' is interrupted too", () => {
    const state = sdk(running, {
      type: 'assistant',
      error: 'overloaded',
      message: { content: [{ type: 'text', text: 'API Error: The API is at capacity' }] },
    });
    expect(state.status).toBe('interrupted');
  });

  it('falls back to the error kind when the flagged message carries no text', () => {
    const state = sdk(running, { type: 'assistant', error: 'server_error', message: {} });
    expect(state.status).toBe('interrupted');
    expect(state.messages.at(-1)).toMatchObject({ kind: 'system', text: 'server_error' });
  });

  it('an api_error result with an unfamiliar wording is still interrupted', () => {
    // terminal_reason + api_error_status are the wording-independent signals: a
    // 5xx (or no HTTP response) means the turn can simply be resumed.
    const state = sdk(running, {
      type: 'result',
      subtype: 'success',
      is_error: true,
      api_error_status: 529,
      terminal_reason: 'api_error',
      result: 'API Error: Please wait a moment and try again.',
    });
    expect(state.status).toBe('interrupted');
  });

  it('logs it once even when other messages land in between', () => {
    // The dead stream can leave a tool_use dangling, whose synthesized tool_result
    // arrives between the notice and the roll-up result — the dedup must not key on
    // "the previous log line".
    const first = sdk(running, cutAssistant, 10);
    const between = sdk(
      first,
      { type: 'user', message: { content: [{ type: 'tool_result', content: 'aborted' }] } },
      11,
    );
    const state = sdk(between, cutResult, 12);
    expect(state.status).toBe('interrupted');
    expect(state.messages.filter((msg) => msg.text === CUT)).toHaveLength(1);
    expect(state.finishedAt).toBe(first.finishedAt);
  });

  it('an error-subtype result is not resumable just because it ended on an api_error', () => {
    // `api_error_status` only exists on the *success* result variant, so its absence
    // here says nothing — a hard 400 must stay `failed` rather than inviting a
    // resume that hits the same error forever.
    const state = sdk(running, {
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      terminal_reason: 'api_error',
      errors: ['API Error: 400 duplicate tool_use ID in conversation history.'],
    });
    expect(state.status).toBe('failed');
  });

  it('does not downgrade an already-diagnosed auth stop to a plain interruption', () => {
    // The CLI reports an expired login with `terminal_reason: 'api_error'` too. The
    // typed assistant error kind already identified it, so the roll-up result must
    // not turn it into "press r to resume" — no retry fixes an expired login.
    const loggedOut = sdk(
      running,
      {
        type: 'assistant',
        error: 'authentication_failed',
        message: { content: [{ type: 'text', text: 'API Error: subscription lapsed' }] },
      },
      10,
    );
    expect(loggedOut.status).toBe('needs_login');
    const state = sdk(
      loggedOut,
      {
        type: 'result',
        subtype: 'success',
        is_error: true,
        api_error_status: null,
        terminal_reason: 'api_error',
        result: 'API Error: subscription lapsed',
      },
      11,
    );
    expect(state.status).toBe('needs_login');
  });

  it('an api_error result with a 4xx status stays a real failure', () => {
    const state = sdk(running, {
      type: 'result',
      subtype: 'success',
      is_error: true,
      api_error_status: 400,
      terminal_reason: 'api_error',
      result: 'API Error: 400 duplicate tool_use ID in conversation history.',
    });
    expect(state.status).toBe('failed');
  });

  it('does not mistake Claude reporting on this very bug for an interruption', () => {
    // A clean turn completes whatever its text says — only the SDK's own is_error
    // flag routes result text through the classifiers.
    const state = sdk(running, {
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'Fixed: a connection closed mid-response now marks the session interrupted.',
    });
    expect(state.status).toBe('completed');
  });

  it('a sub-agent hitting the same error does not stop the session', () => {
    // The sub-agent's failure comes back to the main turn as a failed tool_result,
    // which Claude can retry or work around — the top-level turn is still alive.
    const state = sdk(running, { ...cutAssistant, parent_tool_use_id: 'toolu_1' });
    expect(state.status).toBe('running');
    expect(state.messages.at(-1)).toMatchObject({ kind: 'assistant_text', text: CUT });
  });

  it("an assistant 'max_output_tokens' notice does not stop the session", () => {
    // The CLI recovers from it by continuing the turn, so it must stay running and
    // be logged as ordinary assistant text.
    const notice = "API Error: Claude's response exceeded the 32000 output token maximum.";
    const state = sdk(running, {
      type: 'assistant',
      error: 'max_output_tokens',
      message: { content: [{ type: 'text', text: notice }] },
    });
    expect(state.status).toBe('running');
    expect(state.messages.at(-1)).toMatchObject({ kind: 'assistant_text', text: notice });
  });

  it('logs an api_retry without changing the status', () => {
    const state = sdk(running, {
      type: 'system',
      subtype: 'api_retry',
      attempt: 2,
      max_retries: 10,
      retry_delay_ms: 5000,
      error_status: null,
      error: 'server_error',
    });
    expect(state.status).toBe('running');
    expect(state.messages.at(-1)).toMatchObject({
      kind: 'system',
      text: 'api retry 2/10: server_error',
    });
  });

  it('includes the HTTP status in the retry line when the request got a response', () => {
    const state = sdk(running, {
      type: 'system',
      subtype: 'api_retry',
      attempt: 1,
      max_retries: 10,
      error_status: 529,
      error: 'overloaded',
    });
    expect(state.messages.at(-1)).toMatchObject({ text: 'api retry 1/10: overloaded 529' });
  });

  it('rewrites the retry line per attempt instead of stacking one line each', () => {
    // Up to max_retries messages arrive per request; appending each would push the
    // conversation out of the log viewport.
    const retry = (attempt: number) => ({
      type: 'system',
      subtype: 'api_retry',
      attempt,
      max_retries: 10,
      error_status: null,
      error: 'server_error',
    });
    let state = sdk(running, retry(1));
    state = sdk(state, retry(2));
    state = sdk(state, retry(3));
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]).toMatchObject({ seq: 1, text: 'api retry 3/10: server_error' });
    // A following log line ends the run, so the next burst starts a new line.
    const resumedText = { type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } };
    const after = sdk(sdk(state, resumedText), retry(1));
    expect(after.messages).toHaveLength(3);
    expect(after.messages.at(-1)).toMatchObject({ seq: 3, text: 'api retry 1/10: server_error' });
  });
});

describe('applySdkMessage gates completion on in-flight sub-agent tasks', () => {
  const running: SessionState = { ...initialState(BASE), status: 'running' };
  const taskStarted = (task_id: string, extra: Record<string, unknown> = {}) => ({
    type: 'system',
    subtype: 'task_started',
    task_id,
    ...extra,
  });
  const taskNotification = (task_id: string, status = 'completed') => ({
    type: 'system',
    subtype: 'task_notification',
    task_id,
    status,
  });
  const success = (result = 'all done') => ({ type: 'result', subtype: 'success', result });

  it('does NOT complete while a backgrounded task is still running; defers the result', () => {
    // A backgrounded Task returns its tool_result immediately, so the top-level
    // `result` can arrive before the sub-agent finishes. The session must stay
    // Running (not flip to Completed) until the task settles.
    let state = sdk(running, taskStarted('t1'), 1);
    expect(state.activeTaskIds).toEqual(['t1']);
    state = sdk(state, success('done'), 2);
    expect(state.status).toBe('running');
    expect(state.deferredResult).toMatchObject({ resultText: 'done' });
    // Result log is held back until the turn is truly done.
    expect(state.messages.some((m) => m.kind === 'result')).toBe(false);
  });

  it('completes once the last sub-agent task settles after a deferred result', () => {
    let state = sdk(running, taskStarted('t1'), 1);
    state = sdk(state, success('done'), 2);
    expect(state.status).toBe('running');
    state = sdk(state, taskNotification('t1'), 3);
    expect(state.status).toBe('completed');
    expect(state.finishedAt).toBe(3);
    expect(state.activeTaskIds ?? []).toHaveLength(0);
    expect(state.deferredResult).toBeUndefined();
    expect(state.messages.at(-1)).toMatchObject({ kind: 'result', text: 'done' });
  });

  it('waits for ALL tasks: a deferred result completes only when the set empties', () => {
    let state = sdk(running, taskStarted('t1'), 1);
    state = sdk(state, taskStarted('t2'), 2);
    state = sdk(state, success(), 3);
    expect(state.status).toBe('running');
    state = sdk(state, taskNotification('t1'), 4);
    expect(state.status).toBe('running');
    expect(state.activeTaskIds).toEqual(['t2']);
    state = sdk(state, taskNotification('t2'), 5);
    expect(state.status).toBe('completed');
  });

  it('completes immediately when a task settled before the result arrived (foreground)', () => {
    let state = sdk(running, taskStarted('t1'), 1);
    state = sdk(state, taskNotification('t1'), 2);
    expect(state.status).toBe('running');
    expect(state.activeTaskIds).toEqual([]);
    state = sdk(state, success('ok'), 3);
    expect(state.status).toBe('completed');
  });

  it('ignores ambient housekeeping tasks (skip_transcript) so they never gate completion', () => {
    let state = sdk(running, taskStarted('t1', { skip_transcript: true }), 1);
    expect(state.activeTaskIds).toBeUndefined();
    state = sdk(state, success('ok'), 2);
    expect(state.status).toBe('completed');
  });

  it('a late task_notification does not resurrect a failed session as completed', () => {
    let state = sdk(running, taskStarted('t1'), 1);
    // Turn errors while the task is still in flight.
    state = sdk(state, { type: 'result', subtype: 'error_during_execution' }, 2);
    expect(state.status).toBe('failed');
    state = sdk(state, taskNotification('t1'), 3);
    expect(state.status).toBe('failed');
  });

  it('deduplicates repeated task_started for the same id', () => {
    let state = sdk(running, taskStarted('t1'), 1);
    const before = state;
    state = sdk(state, taskStarted('t1'), 2);
    expect(state).toBe(before);
    expect(state.activeTaskIds).toEqual(['t1']);
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

  it('keeps only the tail of a long stream (プレビューは最後の行しか出さない)', () => {
    let state = sdk(initialState(BASE), streamText('x'.repeat(MAX_STREAM_PREVIEW_CHARS)));
    state = sdk(state, streamText('TAIL'));
    expect(state.streamingText).toHaveLength(MAX_STREAM_PREVIEW_CHARS);
    expect(state.streamingText?.endsWith('TAIL')).toBe(true);
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

describe('applySdkMessage does not double the final message on completion', () => {
  const assistant = (text: string) => ({
    type: 'assistant',
    message: { content: [{ type: 'text', text }] },
  });

  it('drops the success result when it echoes the final assistant text', () => {
    let state: SessionState = { ...initialState(BASE), status: 'running' };
    state = sdk(state, assistant('All done.'), 1);
    state = sdk(state, { type: 'result', subtype: 'success', result: 'All done.' }, 2);
    expect(state.status).toBe('completed');
    // Only the assistant_text remains — no duplicate green `result` line.
    expect(state.messages.filter((m) => m.text === 'All done.')).toHaveLength(1);
    expect(state.messages.some((m) => m.kind === 'result')).toBe(false);
  });

  it('ignores surrounding whitespace when matching the echo', () => {
    let state: SessionState = { ...initialState(BASE), status: 'running' };
    state = sdk(state, assistant('Answer.'), 1);
    // The SDK result text is untrimmed; assistant_text is stored trimmed.
    state = sdk(state, { type: 'result', subtype: 'success', result: '  Answer.\n' }, 2);
    expect(state.messages.some((m) => m.kind === 'result')).toBe(false);
  });

  // 上限で切られた assistant_text と、切られていない result 文字列を素で比べると
  // 一致しなくなり、長い回答が「白 + 緑」で二重に出ていた（レビューで発覚）。
  it('drops the echo even when the answer was clipped by the log cap', () => {
    const long = 'L'.repeat(MAX_LOG_ENTRY_CHARS + 5);
    let state: SessionState = { ...initialState(BASE), status: 'running' };
    state = sdk(state, assistant(long), 1);
    state = sdk(state, { type: 'result', subtype: 'success', result: long }, 2);
    expect(state.status).toBe('completed');
    expect(state.messages).toHaveLength(1);
    expect(state.messages.some((m) => m.kind === 'result')).toBe(false);
  });

  it('still logs a result that carries new content', () => {
    let state: SessionState = { ...initialState(BASE), status: 'running' };
    state = sdk(state, assistant('Working on it.'), 1);
    state = sdk(state, { type: 'result', subtype: 'success', result: 'Different summary.' }, 2);
    expect(state.messages.at(-1)).toMatchObject({ kind: 'result', text: 'Different summary.' });
  });
});

// ログが無制限に伸びる（追記ごとに全体コピー）のがヒープ枯渇の原因だったので、
// SDK 経路の追記も必ず上限を通ることを担保する（`core/log-buffer.ts`）。
describe('applySdkMessage keeps the log bounded', () => {
  it('caps the number of entries, keeping the newest', () => {
    let state: SessionState = { ...initialState(BASE), status: 'running' };
    for (let i = 0; i < MAX_LOG_ENTRIES + 20; i += 1) {
      state = sdk(
        state,
        { type: 'assistant', message: { content: [{ type: 'text', text: `line ${i}` }] } },
        i,
      );
    }
    expect(state.messages).toHaveLength(MAX_LOG_ENTRIES);
    expect(state.messages.at(-1)?.text).toBe(`line ${MAX_LOG_ENTRIES + 19}`);
    // seq は振り直さない（描画キー・スクロール位置の同一性）
    expect(state.messages.at(-1)?.seq).toBe(MAX_LOG_ENTRIES + 20);
  });

  it('clips a pathological entry (a Bash heredoc carrying a whole file)', () => {
    const command = `cat <<'EOF' > big.txt\n${'x'.repeat(MAX_LOG_ENTRY_CHARS)}\nEOF`;
    const state = sdk(
      { ...initialState(BASE), status: 'running' },
      {
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command } }],
        },
      },
    );
    const entry = state.messages.at(-1);
    expect(entry?.kind).toBe('tool_use');
    expect(entry?.text.length).toBeLessThanOrEqual(MAX_LOG_ENTRY_CHARS + 2);
    expect(entry?.text.endsWith('…')).toBe(true);
  });
});

describe('summarizeToolUse', () => {
  it('caps a Bash heredoc instead of building the whole command first', () => {
    const command = `cat <<'EOF' > big\n${'x'.repeat(MAX_LOG_ENTRY_CHARS * 2)}\nEOF`;
    expect(summarizeToolUse('Bash', { command }).length).toBeLessThanOrEqual(
      MAX_LOG_ENTRY_CHARS + 'Bash '.length,
    );
  });

  it.each([
    ['Write', { file_path: '/tmp/a.ts' }, 'Write /tmp/a.ts'],
    ['Edit', { path: '/tmp/b.ts' }, 'Edit /tmp/b.ts'],
    ['Write', {}, 'Write'],
    ['TaskCreate', { subject: 'do it' }, 'TaskCreate "do it"'],
    ['TaskCreate', {}, 'TaskCreate ""'],
    ['Grep', { pattern: 'x' }, 'Grep'],
  ])('%s → %s', (name, input, expected) => {
    expect(summarizeToolUse(name, input as Record<string, unknown>)).toBe(expected);
  });
});

describe('toolResultSummary', () => {
  it.each([
    ['first line only', 'hello\nworld\n!', 'hello'],
    ['CR も行区切り扱い', 'hello\r\nworld', 'hello'],
    ['no newline', 'hello', 'hello'],
    ['empty', '', ''],
  ])('%s', (_name, content, expected) => {
    expect(toolResultSummary(content)).toBe(expected);
  });

  it('caps a long first line at 200 chars', () => {
    expect(toolResultSummary('a'.repeat(5000))).toHaveLength(200);
  });

  it('never materializes more than the summary out of a huge payload', () => {
    // 10MB 相当のツール結果（Read / Bash の実測ケース）。従来は全体を 1 本の文字列に
    // 平坦化して全行に split していた = 使わない数 MB を毎ツール呼び出しで確保していた。
    const huge = { type: 'text', text: `${'z'.repeat(10_000_000)}\ntail` };
    expect(toolResultSummary([huge])).toHaveLength(200);
  });

  it('stringifies non-string, non-array content (structured tool results)', () => {
    expect(toolResultSummary({ ok: true })).toBe('{"ok":true}');
    expect(toolResultSummary(42)).toBe('42');
    expect(toolResultSummary(null)).toBe('');
    expect(toolResultSummary(undefined)).toBe('');
  });

  it('ignores blocks without a text field', () => {
    expect(toolResultSummary([{ type: 'image' }, { type: 'text', text: 'after' }])).toBe('after');
  });

  it('reads text blocks in order (同じ形式で復元ログと一致させる)', () => {
    expect(
      toolResultSummary([
        { type: 'text', text: 'ab' },
        { type: 'text', text: 'cd' },
      ]),
    ).toBe('abcd');
  });
});

/**
 * 1 セッションが複数 PR を出すケース。メッセージの形（tool_use → tool_result の対）は
 * `__fixtures__/session-basic.jsonl` の Bash 呼び出しと同じで、コマンドと出力だけを
 * `gh pr create` のものに差し替えている。
 */
describe('self-created PRs (extraPrs)', () => {
  const CREATED = 'https://github.com/acme/app/pull/42';

  /** A Bash tool_use, shaped like the real fixtures. */
  const bash = (id: string, command: string) => ({
    type: 'assistant',
    message: {
      model: 'claude-opus-4-8',
      content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }],
    },
  });
  const result = (id: string, content: string) => ({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: id, content }] },
  });

  it('records the PR a `gh pr create` result reports', () => {
    const created = sdk(initialState(BASE), bash('t1', 'gh pr create --draft --fill'));
    expect(created.prCreateToolIds).toEqual(['t1']);
    const state = sdk(
      created,
      result('t1', `Creating pull request for codiva/x into main in acme/app\n\n${CREATED}\n`),
    );
    expect(state.extraPrs).toEqual([{ number: 42, url: CREATED }]);
    // 対応が済んだら保留 id は残さない。
    expect(state.prCreateToolIds).toBeUndefined();
  });

  it('ignores PR URLs printed by commands that only read PRs', () => {
    const listed = sdk(initialState(BASE), bash('t1', 'gh pr list --state all'));
    const state = sdk(listed, result('t1', `#7 something ${CREATED}`));
    expect(state.extraPrs).toBeUndefined();
  });

  it('keeps the array identity when the same PR is reported again', () => {
    const first = sdk(sdk(initialState(BASE), bash('t1', 'gh pr create')), result('t1', CREATED));
    const second = sdk(sdk(first, bash('t2', 'gh pr create')), result('t2', CREATED));
    expect(second.extraPrs).toBe(first.extraPrs);
  });

  it('drops the PR from extras once it turns out to be the branch PR', () => {
    const created = sdk(sdk(initialState(BASE), bash('t1', 'gh pr create')), result('t1', CREATED));
    const state = reduce(created, {
      kind: 'pr',
      pr: { number: 42, url: CREATED, mergeStatus: 'mergeable' },
      at: 5,
    });
    expect(state.extraPrs).toBeUndefined();
    expect(state.pr).toEqual({ number: 42, url: CREATED });
  });

  // 並列の tool_use は 1 メッセージに複数ブロックで届き、結果は別々の user メッセージで
  // 順不同に返る。id で対応付けているので順序に依らないこと。
  it('pairs parallel creates by id, whatever order the results arrive in', () => {
    const started = sdk(initialState(BASE), {
      type: 'assistant',
      message: {
        model: 'claude-opus-4-8',
        content: [
          { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'gh pr create --fill' } },
          { type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'gh pr create --fill' } },
        ],
      },
    });
    expect(started.prCreateToolIds).toEqual(['t1', 't2']);
    const second = sdk(started, result('t2', 'https://github.com/acme/app/pull/2'));
    const both = sdk(second, result('t1', 'https://github.com/acme/app/pull/1'));
    expect(both.extraPrs).toEqual([
      { number: 2, url: 'https://github.com/acme/app/pull/2' },
      { number: 1, url: 'https://github.com/acme/app/pull/1' },
    ]);
    expect(both.prCreateToolIds).toBeUndefined();
  });

  // サブエージェント（Task）の中で作られた PR もセッションの PR。tool_use / tool_result は
  // `parent_tool_use_id` 付きで届くが、id の対応付けは同じ。
  it('records a PR created inside a sub-agent', () => {
    const started = sdk(initialState(BASE), {
      ...bash('t9', 'gh pr create --fill'),
      parent_tool_use_id: 'toolu_parent',
    });
    const state = sdk(started, {
      ...result('t9', CREATED),
      parent_tool_use_id: 'toolu_parent',
    });
    expect(state.extraPrs).toEqual([{ number: 42, url: CREATED }]);
  });

  // `gh pr create` は既に PR があるとその PR の URL を出す。ブランチの PR として
  // 既に持っているものを extras に積むと `+1` が嘘になる。
  it('does not re-add the branch PR when create reports it already exists', () => {
    const withPr = reduce(initialState(BASE), {
      kind: 'pr',
      pr: { number: 42, url: CREATED, mergeStatus: 'mergeable' },
      at: 1,
    });
    const state = sdk(
      sdk(withPr, bash('t1', 'gh pr create --fill')),
      result('t1', `a pull request for branch "codiva/x" into "main" already exists: ${CREATED}`),
    );
    expect(state.extraPrs).toBeUndefined();
  });

  it('does not touch extras when an unrelated PR is discovered for the branch', () => {
    const created = sdk(sdk(initialState(BASE), bash('t1', 'gh pr create')), result('t1', CREATED));
    const state = reduce(created, {
      kind: 'pr',
      pr: { number: 41, url: 'https://github.com/acme/app/pull/41', mergeStatus: 'unknown' },
      at: 5,
    });
    expect(state.extraPrs).toBe(created.extraPrs);
  });
});
