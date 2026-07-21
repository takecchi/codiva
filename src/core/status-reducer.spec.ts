import { describe, expect, it } from 'vitest';
import {
  accrueActive,
  activeElapsedMs,
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

describe('reduce classifies aborted rate-limit errors', () => {
  const running: SessionState = { ...initialState(BASE), status: 'running' };

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
});

describe('pr event', () => {
  it('stores the PR and no-ops when unchanged', () => {
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
