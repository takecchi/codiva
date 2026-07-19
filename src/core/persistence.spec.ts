import { describe, expect, it } from 'vitest';
import {
  emptyPersistedState,
  fromPersistedJson,
  type PersistedSession,
  restorableStatus,
  restoredSessionState,
  toPersistedSession,
} from '@/core/persistence';
import { initialState } from '@/core/status-reducer';
import type { SessionState, SessionStatus } from '@/core/types';

function state(overrides: Partial<SessionState> = {}): SessionState {
  return {
    ...initialState({
      id: '1',
      title: 'Add login',
      prompt: 'add login',
      branch: 'codiva/add-login',
      worktreePath: '/tmp/wt/add-login',
      startedAt: 5,
    }),
    ...overrides,
  };
}

describe('restorableStatus', () => {
  it.each<[SessionStatus, 'completed' | 'interrupted' | 'failed' | undefined]>([
    ['creating', undefined],
    ['running', 'interrupted'],
    ['awaiting_permission', 'interrupted'],
    ['awaiting_input', 'interrupted'],
    ['completed', 'completed'],
    ['interrupted', 'interrupted'],
    ['rate_limited', 'interrupted'],
    ['failed', 'failed'],
    ['archived', undefined],
  ])('maps %s → %s', (status, expected) => {
    expect(restorableStatus(status)).toBe(expected);
  });
});

describe('toPersistedSession', () => {
  it('captures the fields needed to rebuild and resume', () => {
    const s = state({
      status: 'completed',
      sdkSessionId: 'sdk-123',
      totalCostUsd: 0.05,
      finishedAt: 20,
      todos: [{ id: '1', subject: 'step', status: 'completed' }],
    });
    expect(toPersistedSession(s, { slug: 'add-login', base: 'main' })).toEqual({
      id: '1',
      title: 'Add login',
      prompt: 'add login',
      slug: 'add-login',
      branch: 'codiva/add-login',
      worktreePath: '/tmp/wt/add-login',
      base: 'main',
      sdkSessionId: 'sdk-123',
      status: 'completed',
      startedAt: 5,
      finishedAt: 20,
      totalCostUsd: 0.05,
      todos: [{ id: '1', subject: 'step', status: 'completed' }],
    });
  });

  it('round-trips the resolved model through persist → restore', () => {
    const s = state({ status: 'completed', sdkSessionId: 'sdk-1', model: 'claude-opus-4-8' });
    const persisted = toPersistedSession(s, { slug: 'x', base: 'main' });
    expect(persisted?.model).toBe('claude-opus-4-8');
    // biome-ignore lint/style/noNonNullAssertion: guarded by the assertion above
    expect(restoredSessionState(persisted!).model).toBe('claude-opus-4-8');
    // and the JSON validator preserves it from untrusted input
    expect(fromPersistedJson({ sessions: [persisted] }).sessions[0]?.model).toBe('claude-opus-4-8');
  });

  it('maps an in-flight status to interrupted (resumable, not a clean finish)', () => {
    const s = state({ status: 'running', sdkSessionId: 'sdk-9' });
    expect(toPersistedSession(s, { slug: 'x', base: 'main' })?.status).toBe('interrupted');
  });

  it('round-trips an interrupted session through persist → restore → JSON', () => {
    const s = state({ status: 'interrupted', sdkSessionId: 'sdk-int' });
    const persisted = toPersistedSession(s, { slug: 'x', base: 'main' });
    expect(persisted?.status).toBe('interrupted');
    // biome-ignore lint/style/noNonNullAssertion: guarded by the assertion above
    expect(restoredSessionState(persisted!).status).toBe('interrupted');
    expect(fromPersistedJson({ sessions: [persisted] }).sessions[0]?.status).toBe('interrupted');
  });

  it('drops archived/creating sessions', () => {
    expect(
      toPersistedSession(state({ status: 'archived' }), { slug: 'x', base: 'm' }),
    ).toBeUndefined();
    expect(
      toPersistedSession(state({ status: 'creating' }), { slug: 'x', base: 'm' }),
    ).toBeUndefined();
  });

  it('drops sessions without a worktree path', () => {
    const s = state({ status: 'completed', worktreePath: '', sdkSessionId: 'sdk-1' });
    expect(toPersistedSession(s, { slug: 'x', base: 'm' })).toBeUndefined();
  });

  it('drops sessions without an sdkSessionId (nothing to resume)', () => {
    const s = state({ status: 'completed' }); // initialState leaves sdkSessionId undefined
    expect(toPersistedSession(s, { slug: 'x', base: 'm' })).toBeUndefined();
  });
});

describe('restoredSessionState', () => {
  it('rebuilds an idle UI state with derived progress and an empty log', () => {
    const p: PersistedSession = {
      id: '2',
      title: 'Fix bug',
      prompt: 'fix bug',
      slug: 'fix-bug',
      branch: 'codiva/fix-bug',
      worktreePath: '/tmp/wt/fix-bug',
      base: 'main',
      sdkSessionId: 'sdk-2',
      status: 'completed',
      startedAt: 1,
      finishedAt: 9,
      totalCostUsd: 0.02,
      todos: [
        { id: '1', subject: 'a', status: 'completed' },
        { id: '2', subject: 'b', status: 'pending' },
      ],
    };
    const s = restoredSessionState(p);
    expect(s.status).toBe('completed');
    expect(s.messages).toEqual([]);
    expect(s.logSeq).toBe(0);
    expect(s.progress).toEqual({ done: 1, total: 2 });
    expect(s.sdkSessionId).toBe('sdk-2');
    expect(s.totalCostUsd).toBe(0.02);
    expect(s.finishedAt).toBe(9);
  });

  it('seeds the log from a transcript-rebuilt history and continues seq after it', () => {
    const p: PersistedSession = {
      id: '4',
      title: 'With history',
      prompt: 'p',
      slug: 's',
      branch: 'codiva/s',
      worktreePath: '/tmp/wt/s',
      base: 'main',
      sdkSessionId: 'sdk-4',
      status: 'completed',
      startedAt: 1,
      todos: [],
    };
    const history = [
      { seq: 1, kind: 'user' as const, text: 'do the thing' },
      { seq: 2, kind: 'assistant_text' as const, text: 'done' },
    ];
    const s = restoredSessionState(p, history);
    expect(s.messages).toEqual(history);
    // New turns must append after the restored entries, not collide with seq 1.
    expect(s.logSeq).toBe(2);
  });

  it('freezes elapsed time at startedAt when the session had no finishedAt', () => {
    const p: PersistedSession = {
      id: '3',
      title: 'In-flight at quit',
      prompt: 'p',
      slug: 's',
      branch: 'codiva/s',
      worktreePath: '/tmp/wt/s',
      base: 'main',
      sdkSessionId: 'sdk-3',
      status: 'completed',
      startedAt: 42,
      todos: [],
    };
    // Avoids an ever-growing timer for a restored, never-really-finished session.
    expect(restoredSessionState(p).finishedAt).toBe(42);
  });
});

describe('fromPersistedJson', () => {
  it('round-trips a valid persisted state', () => {
    const s = toPersistedSession(state({ status: 'completed', sdkSessionId: 'sdk-1' }), {
      slug: 'add-login',
      base: 'main',
    });
    const parsed = fromPersistedJson({ version: 1, sessions: [s] });
    expect(parsed.sessions).toEqual([s]);
  });

  it.each([[null], [undefined], [42], ['x'], [{}], [{ sessions: 'nope' }]])(
    'returns empty state for malformed input: %o',
    (input) => {
      expect(fromPersistedJson(input)).toEqual(emptyPersistedState());
    },
  );

  it('drops individual malformed sessions but keeps valid ones', () => {
    const valid = toPersistedSession(state({ status: 'completed', sdkSessionId: 'sdk-1' }), {
      slug: 's',
      base: 'main',
    });
    const parsed = fromPersistedJson({
      version: 1,
      sessions: [
        valid,
        { id: '2', worktreePath: '/x', status: 'completed' }, // missing sdkSessionId
        { worktreePath: '/x', status: 'completed', sdkSessionId: 'sdk-z' }, // missing id
        'garbage',
      ],
    });
    expect(parsed.sessions).toHaveLength(1);
    expect(parsed.sessions[0]?.id).toBe('1');
  });

  it('backfills sensible defaults for optional fields', () => {
    const parsed = fromPersistedJson({
      sessions: [{ id: '7', worktreePath: '/tmp/w', status: 'failed', sdkSessionId: 'sdk-7' }],
    });
    expect(parsed.sessions[0]).toMatchObject({
      id: '7',
      title: '7',
      slug: '7',
      branch: 'codiva/7',
      base: 'HEAD',
      sdkSessionId: 'sdk-7',
      startedAt: 0,
      todos: [],
    });
  });

  it('drops a persisted session that lacks an sdkSessionId', () => {
    const parsed = fromPersistedJson({
      sessions: [{ id: '9', worktreePath: '/tmp/w', status: 'completed' }],
    });
    expect(parsed.sessions).toEqual([]);
  });

  it('filters malformed todos inside a session', () => {
    const parsed = fromPersistedJson({
      sessions: [
        {
          id: '1',
          worktreePath: '/w',
          status: 'completed',
          sdkSessionId: 'sdk-1',
          todos: [{ id: '1', subject: 'ok', status: 'weird' }, { id: '2' }, 'x'],
        },
      ],
    });
    expect(parsed.sessions[0]?.todos).toEqual([{ id: '1', subject: 'ok', status: 'pending' }]);
  });
});
