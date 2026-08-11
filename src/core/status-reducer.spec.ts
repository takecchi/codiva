import { describe, expect, it } from 'vitest';
import { MAX_LOG_ENTRIES, MAX_LOG_ENTRY_CHARS } from '@/core/log-buffer';
import {
  accrueActive,
  activeElapsedMs,
  appendLog,
  initialState,
  reduce,
  toInterrupted,
} from '@/core/status-reducer';
import type { CreateSessionInput, PermissionRequest, SessionState } from '@/core/types';

const BASE: CreateSessionInput = {
  id: 's1',
  title: 'demo',
  prompt: 'demo prompt',
  branch: 'codiva/demo',
  worktreePath: '/tmp/demo',
  startedAt: 1000,
};

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

  it('permission_request (question) logs the first question text', () => {
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
    expect(state.messages.at(-1)?.text).toBe('AskUserQuestion: Which one?');
  });

  it('permission_resolved clears the pending request and resumes', () => {
    const req: PermissionRequest = { id: 'p1', toolName: 'Bash', input: {}, kind: 'tool' };
    let state = reduce(initialState(BASE), { kind: 'permission_request', request: req, at: 2000 });
    state = reduce(state, { kind: 'permission_resolved', at: 2001 });
    expect(state.status).toBe('running');
    expect(state.pendingPermission).toBeUndefined();
  });

  it('permission_resolved confirms a completion that was held during the prompt', () => {
    // 「ずっと Running」の再現: サブエージェントの完了ゲートが空になったのが
    // 許可/質問待ちの最中だと、その場では完了できない（`applyAgentEvent` は
    // `running` のときだけ確定する）。ゲートは空なので `task_settled` も
    // もう来ない — 回答して `running` に戻るここで拾わないと完了が永久に失われる。
    const req: PermissionRequest = { id: 'p1', toolName: 'Bash', input: {}, kind: 'tool' };
    let state = reduce(initialState(BASE), { kind: 'permission_request', request: req, at: 2000 });
    state = { ...state, activeTaskIds: [], deferredResult: { at: 2100, resultText: 'done' } };
    state = reduce(state, { kind: 'permission_resolved', at: 2200 });
    expect(state.status).toBe('completed');
    expect(state.finishedAt).toBe(2200);
    expect(state.deferredResult).toBeUndefined();
    expect(state.messages.at(-1)?.text).toBe('done');
  });

  it('permission_resolved stays running while sub-agent tasks are still in flight', () => {
    const req: PermissionRequest = { id: 'p1', toolName: 'Bash', input: {}, kind: 'tool' };
    let state = reduce(initialState(BASE), { kind: 'permission_request', request: req, at: 2000 });
    state = { ...state, activeTaskIds: ['t1'], deferredResult: { at: 2100, resultText: 'done' } };
    state = reduce(state, { kind: 'permission_resolved', at: 2200 });
    expect(state.status).toBe('running');
    expect(state.deferredResult?.resultText).toBe('done');
  });

  it('agent_switched drops the sub-agent completion gate (it is per-turn, per-provider)', () => {
    const state = reduce(
      {
        ...initialState(BASE),
        status: 'interrupted',
        activeTaskIds: ['t1'],
        deferredResult: { at: 1, resultText: 'x' },
      },
      { kind: 'agent_switched', agent: 'codex', at: 2 },
    );
    expect(state.agent).toBe('codex');
    expect(state.activeTaskIds).toBeUndefined();
    expect(state.deferredResult).toBeUndefined();
  });

  it('user_input resumes a completed session and clears finishedAt', () => {
    let state: SessionState = { ...initialState(BASE), status: 'completed', finishedAt: 5000 };
    state = reduce(state, { kind: 'user_input', text: 'do more', at: 6000 });
    expect(state.status).toBe('running');
    expect(state.finishedAt).toBeUndefined();
    expect(state.messages.at(-1)?.text).toBe('do more');
  });

  it('user_input keeps a pending question in awaiting_input (does not flip to Running)', () => {
    // Regression: sending a follow-up while an AskUserQuestion is pending must not
    // downgrade the session to running — the dialog stays up, so the badge must
    // remain "Question", not "Running" (pendingPermission is untouched).
    const req: PermissionRequest = {
      id: 'q1',
      toolName: 'AskUserQuestion',
      input: {},
      kind: 'question',
      questions: [{ question: 'Which one?', header: 'x', multiSelect: false, options: [] }],
    };
    let state = reduce(initialState(BASE), { kind: 'permission_request', request: req, at: 2000 });
    state = reduce(state, { kind: 'user_input', text: 'also do X', at: 2500 });
    expect(state.status).toBe('awaiting_input');
    expect(state.pendingPermission?.kind).toBe('question');
  });

  it('user_input keeps a pending tool prompt in awaiting_permission', () => {
    const req: PermissionRequest = { id: 'p1', toolName: 'Bash', input: {}, kind: 'tool' };
    let state = reduce(initialState(BASE), { kind: 'permission_request', request: req, at: 2000 });
    state = reduce(state, { kind: 'user_input', text: 'note', at: 2500 });
    expect(state.status).toBe('awaiting_permission');
    expect(state.pendingPermission?.toolName).toBe('Bash');
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

// 分類そのもの（どの文言がどの `cause` か）はアダプタの仕事なので
// `claude-errors.spec.ts` の `classifyClaudeError` が担当する。ここで見るのは
// 「`cause` を受け取った reducer がどの状態へ落とすか」だけ。
describe('reduce routes aborted stops by the adapter-supplied cause', () => {
  const running: SessionState = { ...initialState(BASE), status: 'running' };

  it('a rate-limit cause is rate_limited, not failed', () => {
    const state = reduce(running, {
      kind: 'aborted',
      error: "Error: You've hit your limit",
      cause: 'rate_limit',
      at: 5000,
    });
    expect(state.status).toBe('rate_limited');
  });

  it('a connection cause is interrupted (resumable), not failed', () => {
    const state = reduce(running, {
      kind: 'aborted',
      error: 'connection reset',
      cause: 'connection',
      at: 5000,
    });
    expect(state.status).toBe('interrupted');
  });

  it('an unclassified abort (no cause) still fails', () => {
    const state = reduce(running, { kind: 'aborted', error: 'connection reset', at: 5000 });
    expect(state.status).toBe('failed');
  });

  it('clears the streaming preview when aborted or archived mid-stream', () => {
    const streaming: SessionState = {
      ...initialState(BASE),
      status: 'running',
      streamingText: 'half',
    };
    const aborted = reduce(streaming, { kind: 'aborted', at: 9 });
    expect(aborted.status).toBe('failed');
    expect(aborted.streamingText).toBeUndefined();

    const archived = reduce(streaming, { kind: 'archived', at: 9 });
    expect(archived.status).toBe('archived');
    expect(archived.streamingText).toBeUndefined();
  });
});

describe('reduce routes an auth cause to needs_login', () => {
  const running: SessionState = { ...initialState(BASE), status: 'running' };

  it('an aborted event with an auth cause is needs_login, not failed', () => {
    const error = 'Failed to authenticate: OAuth session expired and could not be refreshed';
    const state = reduce(running, { kind: 'aborted', error, cause: 'auth', at: 5000 });
    expect(state.status).toBe('needs_login');
    expect(state.finishedAt).toBe(5000);
    // The reason is kept so the detail view can show what the CLI reported.
    expect(state.error).toBe(error);
    expect(state.messages.at(-1)).toMatchObject({ kind: 'error', text: error });
  });

  it('drops a pending permission that can never resolve now', () => {
    const pending: SessionState = {
      ...running,
      status: 'awaiting_permission',
      pendingPermission: { id: 'p1', toolName: 'Bash', input: {}, kind: 'tool' },
      streamingText: 'half',
    };
    const state = reduce(pending, {
      kind: 'aborted',
      error: 'invalid x-api-key',
      cause: 'auth',
      at: 7,
    });
    expect(state.status).toBe('needs_login');
    expect(state.pendingPermission).toBeUndefined();
    expect(state.streamingText).toBeUndefined();
  });
});

describe('agent_switched', () => {
  const running: SessionState = {
    ...initialState(BASE),
    status: 'running',
    sdkSessionId: 'claude-1',
    model: 'claude-opus-4-8',
  };

  it('stashes the current resume id under the outgoing agent', () => {
    const state = reduce(running, { kind: 'agent_switched', agent: 'codex', at: 1 });
    expect(state.agent).toBe('codex');
    expect(state.agentSessions?.claude).toBe('claude-1');
    // Codex は初めてなので resume 先が無い（= 次のターンは新しい会話）。
    expect(state.sdkSessionId).toBeUndefined();
    // 解決済みモデルは provider ごとに別物なので持ち越さない。
    expect(state.model).toBeUndefined();
  });

  it('restores the target agent’s own resume id when switching back', () => {
    const switched = reduce(running, { kind: 'agent_switched', agent: 'codex', at: 1 });
    const withCodex: SessionState = { ...switched, sdkSessionId: 'codex-1' };
    const back = reduce(withCodex, { kind: 'agent_switched', agent: 'claude', at: 2 });
    expect(back.agent).toBe('claude');
    expect(back.sdkSessionId).toBe('claude-1');
    expect(back.agentSessions?.codex).toBe('codex-1');
  });

  it('is a no-op when the agent is unchanged', () => {
    const same = reduce(running, { kind: 'agent_switched', agent: 'claude', at: 1 });
    expect(same).toBe(running);
  });
});

describe('interrupted event (connection drop)', () => {
  const running: SessionState = {
    ...initialState(BASE),
    status: 'running',
    sdkSessionId: 'sdk-1',
  };

  it('marks the session interrupted (idle, resumable) — not failed', () => {
    const state = reduce(running, { kind: 'interrupted', error: 'fetch failed', at: 5000 });
    expect(state.status).toBe('interrupted');
    expect(state.finishedAt).toBe(5000);
    // interrupted is not an error state — no error field is set (unlike `aborted`).
    expect(state.error).toBeUndefined();
    // The reason is recorded as a system log line, not an error line.
    expect(state.messages.at(-1)).toMatchObject({ kind: 'system', text: 'fetch failed' });
  });

  it('defaults the reason text when none is given', () => {
    const state = reduce(running, { kind: 'interrupted', at: 5000 });
    expect(state.status).toBe('interrupted');
    expect(state.messages.at(-1)?.text).toBe('connection interrupted');
  });

  it('clears transient turn state (streaming preview, pending, deferred/task bookkeeping)', () => {
    const messy: SessionState = {
      ...running,
      streamingText: 'half a sentence',
      pendingPermission: { id: 'p', toolName: 'Bash', input: {}, kind: 'tool' },
      activeTaskIds: ['t1'],
      deferredResult: { at: 1, resultText: 'x' },
    };
    const state = toInterrupted(messy, 6000, 'socket hang up');
    expect(state.status).toBe('interrupted');
    expect(state.streamingText).toBeUndefined();
    expect(state.pendingPermission).toBeUndefined();
    expect(state.activeTaskIds).toBeUndefined();
    expect(state.deferredResult).toBeUndefined();
  });

  it('is idempotent for the same reason (the SDK reports it twice)', () => {
    // A mid-response API failure arrives as the flagged assistant message and again
    // as the result that rolls it up, so the second call must add nothing.
    const first = toInterrupted(running, 5000, 'connection closed mid-response');
    const second = toInterrupted(first, 6000, 'connection closed mid-response');
    expect(second).toBe(first);
    expect(second.finishedAt).toBe(5000);
  });

  it('still logs a second interruption once the session moved on', () => {
    // The dedup is scoped to the current stop: after the user sends a follow-up the
    // session is running again, so the same wording next turn is a new event.
    const first = toInterrupted(running, 5000, 'connection closed mid-response');
    const resumed = reduce(first, { kind: 'user_input', text: 'continue', at: 6000 });
    expect(resumed.status).toBe('running');
    const again = toInterrupted(resumed, 7000, 'connection closed mid-response');
    expect(again.status).toBe('interrupted');
    expect(again.finishedAt).toBe(7000);
    expect(again.messages.filter((m) => m.text === 'connection closed mid-response')).toHaveLength(
      2,
    );
  });

  it('does not confuse a later interruption with an older, unrelated system line', () => {
    // The key is the last *system* entry, so intervening entries of other kinds
    // (tool results, assistant text) must not break the dedup either way.
    const first = toInterrupted(running, 5000, 'socket hang up');
    const withNoise = appendLog(first, 'tool_result', 'aborted');
    const state = toInterrupted(
      { ...first, messages: withNoise.messages, logSeq: withNoise.logSeq },
      6000,
      'socket hang up',
    );
    expect(state.messages.filter((m) => m.text === 'socket hang up')).toHaveLength(1);
  });
});

describe('pr event', () => {
  it('splits the lookup into a stable ref and a volatile status', () => {
    const s0 = initialState(BASE);
    expect(s0.pr).toBeUndefined();
    expect(s0.prStatus).toBeUndefined();

    const withPr = reduce(s0, {
      kind: 'pr',
      pr: { number: 12, url: 'https://x/12', mergeStatus: 'unknown' },
      at: 1,
    });
    expect(withPr.pr).toEqual({ number: 12, url: 'https://x/12' });
    expect(withPr.prStatus).toEqual({ mergeStatus: 'unknown' });

    // Same PR again → same reference (no re-render on every poll).
    expect(
      reduce(withPr, {
        kind: 'pr',
        pr: { number: 12, url: 'https://x/12', mergeStatus: 'unknown' },
        at: 2,
      }),
    ).toBe(withPr);

    // A different PR replaces it; undefined clears both halves.
    expect(
      reduce(withPr, {
        kind: 'pr',
        pr: { number: 13, url: 'https://x/13', mergeStatus: 'mergeable' },
        at: 3,
      }).pr,
    ).toEqual({ number: 13, url: 'https://x/13' });
    const cleared = reduce(withPr, { kind: 'pr', pr: undefined, at: 4 });
    expect(cleared.pr).toBeUndefined();
    expect(cleared.prStatus).toBeUndefined();
    // Already undefined → same reference.
    expect(reduce(s0, { kind: 'pr', pr: undefined, at: 5 })).toBe(s0);
  });

  // The status half moves on its own (CI progress, draft → ready, mergeability), and
  // must repaint the glyph — while leaving `pr` untouched so the (persisted) identity
  // doesn't look dirty on every poll.
  it.each([
    {
      label: 'the draft flag flips',
      before: { mergeStatus: 'unknown', isDraft: true },
      after: { mergeStatus: 'unknown', isDraft: false },
      check: (s: SessionState) => expect(s.prStatus?.isDraft).toBe(false),
    },
    {
      label: 'checks progress',
      before: { mergeStatus: 'mergeable', checks: 'pending' },
      after: { mergeStatus: 'mergeable', checks: 'failing' },
      check: (s: SessionState) => expect(s.prStatus?.checks).toBe('failing'),
    },
    {
      label: 'mergeability is computed',
      before: { mergeStatus: 'unknown' },
      after: { mergeStatus: 'merged' },
      check: (s: SessionState) => expect(s.prStatus?.mergeStatus).toBe('merged'),
    },
  ] as const)('re-renders (keeping the ref) when $label', (c) => {
    const state: SessionState = {
      ...initialState(BASE),
      pr: { number: 3, url: 'u' },
      prStatus: { ...c.before },
    };
    const next = reduce(state, { kind: 'pr', pr: { number: 3, url: 'u', ...c.after }, at: 1 });
    expect(next).not.toBe(state);
    expect(next.pr).toBe(state.pr); // identity untouched → no needless persist
    c.check(next);
  });

  it('no-ops when neither half changed', () => {
    const state: SessionState = {
      ...initialState(BASE),
      pr: { number: 3, url: 'u' },
      prStatus: { mergeStatus: 'unknown', isDraft: true },
    };
    const next = reduce(state, {
      kind: 'pr',
      pr: { number: 3, url: 'u', mergeStatus: 'unknown', isDraft: true },
      at: 1,
    });
    expect(next).toBe(state);
  });

  // "The number is already known" — a restored session has the ref but no status yet,
  // and the first successful poll must fill the status in without touching the ref.
  it('fills in the status for an already-known PR (restored from disk)', () => {
    const restored: SessionState = { ...initialState(BASE), pr: { number: 8, url: 'u' } };
    const next = reduce(restored, {
      kind: 'pr',
      pr: { number: 8, url: 'u', mergeStatus: 'mergeable', checks: 'passing' },
      at: 1,
    });
    expect(next.pr).toBe(restored.pr);
    expect(next.prStatus).toEqual({ mergeStatus: 'mergeable', checks: 'passing' });
  });
});

describe('pr_lookup event', () => {
  it('stores the lookup state and no-ops when unchanged', () => {
    const s0 = initialState(BASE);
    expect(s0.prLookup).toBeUndefined();

    const loading = reduce(s0, { kind: 'pr_lookup', lookup: 'loading', at: 1 });
    expect(loading.prLookup).toBe('loading');
    expect(reduce(loading, { kind: 'pr_lookup', lookup: 'loading', at: 2 })).toBe(loading);

    const failed = reduce(loading, { kind: 'pr_lookup', lookup: 'error', at: 3 });
    expect(failed.prLookup).toBe('error');
    expect(
      reduce(failed, { kind: 'pr_lookup', lookup: undefined, at: 4 }).prLookup,
    ).toBeUndefined();
  });

  it('marking the lookup failed never touches a known PR', () => {
    const withPr: SessionState = {
      ...initialState(BASE),
      pr: { number: 7, url: 'u' },
      prStatus: { mergeStatus: 'mergeable' },
    };
    const next = reduce(withPr, { kind: 'pr_lookup', lookup: 'error', at: 1 });
    expect(next.pr).toBe(withPr.pr);
  });

  it('a pr event clears the lookup mark even when the PR is unchanged', () => {
    const pr = { number: 7, url: 'u' };
    const stale: SessionState = {
      ...initialState(BASE),
      pr,
      prStatus: { mergeStatus: 'mergeable' },
      prLookup: 'error',
    };
    // A retry that finds the same PR must drop the "couldn't check" mark…
    const next = reduce(stale, { kind: 'pr', pr: { ...pr, mergeStatus: 'mergeable' }, at: 1 });
    expect(next.prLookup).toBeUndefined();
    // …while keeping the existing PR object identity (no needless re-render below).
    expect(next.pr).toBe(pr);
  });

  it('a pr event clears a loading mark for a branch with no PR', () => {
    const looking: SessionState = { ...initialState(BASE), prLookup: 'loading' };
    const next = reduce(looking, { kind: 'pr', pr: undefined, at: 1 });
    expect(next.prLookup).toBeUndefined();
    expect(next.pr).toBeUndefined();
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

describe('active-time accounting', () => {
  it('initialState starts the clock (creating is active)', () => {
    const s0 = initialState(BASE);
    expect(s0.activeMs).toBe(0);
    expect(s0.activeSince).toBe(BASE.startedAt);
  });

  it('activeElapsedMs adds the open segment while active', () => {
    const s = { ...initialState(BASE), activeMs: 2_000, activeSince: 10_000 };
    expect(activeElapsedMs(s, 12_500)).toBe(2_000 + 2_500);
  });

  it('activeElapsedMs returns only the accumulated total while idle', () => {
    const s = {
      ...initialState(BASE),
      status: 'completed' as const,
      activeMs: 2_000,
      activeSince: undefined,
    };
    expect(activeElapsedMs(s, 999_999)).toBe(2_000);
  });

  it('never returns a negative open segment if now precedes activeSince', () => {
    const s = { ...initialState(BASE), activeMs: 500, activeSince: 10_000 };
    expect(activeElapsedMs(s, 9_000)).toBe(500);
  });

  it('accrueActive closes the segment when leaving an active status', () => {
    const prev = {
      ...initialState(BASE),
      status: 'running' as const,
      activeMs: 1_000,
      activeSince: 5_000,
    };
    const next = { ...prev, status: 'completed' as const };
    const out = accrueActive(prev, next, 8_000);
    // 1_000 accumulated + (8_000 - 5_000) open segment, clock stopped.
    expect(out.activeMs).toBe(4_000);
    expect(out.activeSince).toBeUndefined();
  });

  it('accrueActive opens a fresh segment when entering an active status', () => {
    const prev = {
      ...initialState(BASE),
      status: 'completed' as const,
      activeMs: 4_000,
      activeSince: undefined,
    };
    const next = { ...prev, status: 'running' as const };
    const out = accrueActive(prev, next, 20_000);
    expect(out.activeMs).toBe(4_000); // untouched until this new segment closes
    expect(out.activeSince).toBe(20_000);
  });

  it('accrueActive is a no-op across active→active (creating→running) and idle→idle', () => {
    const creating = initialState(BASE);
    const running = { ...creating, status: 'running' as const };
    const stayed = accrueActive(creating, running, 9_999);
    // Same side of the boundary: activeSince carried, nothing accrued, ref unchanged.
    expect(stayed).toBe(running);
    expect(stayed.activeSince).toBe(BASE.startedAt);

    const completed = { ...creating, status: 'completed' as const, activeSince: undefined };
    const failed = { ...completed, status: 'failed' as const };
    expect(accrueActive(completed, failed, 5)).toBe(failed);
  });
});

// ログの上限（`core/log-buffer.ts`）は reducer 経路でも効く。無制限に伸ばしていたのが
// ヒープ枯渇の原因だった。
describe('appendLog is bounded', () => {
  it('drops the oldest entries once the cap is reached', () => {
    let state: SessionState = initialState(BASE);
    for (let i = 0; i < MAX_LOG_ENTRIES + 3; i += 1) {
      const withLog = appendLog(state, 'system', `line ${i}`);
      state = { ...state, messages: withLog.messages, logSeq: withLog.logSeq };
    }
    expect(state.messages).toHaveLength(MAX_LOG_ENTRIES);
    expect(state.messages[0]?.text).toBe('line 3');
    expect(state.logSeq).toBe(MAX_LOG_ENTRIES + 3);
  });

  it('clips a huge pasted instruction', () => {
    const withLog = appendLog(initialState(BASE), 'user', 'v'.repeat(MAX_LOG_ENTRY_CHARS + 1));
    expect(withLog.messages[0]?.text.endsWith('…')).toBe(true);
  });
});
