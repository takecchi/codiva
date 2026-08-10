import { describe, expect, it, vi } from 'vitest';
import { type AgentAdapter, type AgentAvailability, NO_CAPABILITIES } from '@/core/agent-ports';
import { messages } from '@/core/i18n';
import type { RateLimitInfoJson } from '@/core/rate-limit';
import { SessionManager } from '@/core/session-manager';
import type { PrAutomation, SessionHandle, WorktreeService } from '@/core/session-ports';
import { initialState, reduce } from '@/core/status-reducer';
import type {
  AgentId,
  CreateSessionInput,
  PrInfo,
  PrLookupResult,
  PrLookupState,
  SessionState,
} from '@/core/types';
import { MergeConflictError } from '@/core/worktree';

function fakeWorktrees(overrides: Partial<WorktreeService> = {}): WorktreeService {
  return {
    baseBranch: async () => 'main',
    takenSlugs: async () => new Set<string>(),
    add: async (slug) => ({ slug, branch: `codiva/${slug}`, path: `/tmp/wt/${slug}` }),
    syncedStartPoint: async () => undefined,
    pushBranch: async () => {},
    diffStat: async () => ({ committed: '', uncommitted: [] }),
    merge: async () => {},
    syncBase: async () => ({ kind: 'upToDate' }),
    remove: async () => {},
    ...overrides,
  };
}

/** A fake session that records the wiring and lets tests drive its state. */
class FakeSession implements SessionHandle {
  state: SessionState;
  started = false;
  aborted = false;
  stopped = false;
  constructor(
    input: CreateSessionInput,
    private readonly onChange: (s: SessionState) => void,
    restored?: SessionState,
    private readonly onRateLimit?: (info: RateLimitInfoJson) => void,
  ) {
    this.state = restored ?? initialState(input);
  }
  /** Simulate the SDK reporting an account-wide usage limit through this session. */
  emitRateLimit(info: RateLimitInfoJson) {
    this.onRateLimit?.(info);
  }
  calls: string[] = [];
  getState() {
    return this.state;
  }
  start() {
    this.started = true;
  }
  /** When true, send() advances to `running` — like the real Session.send (synchronously). */
  sendMovesToRunning = false;
  send(text: string) {
    this.calls.push(`send:${text}`);
    if (this.sendMovesToRunning) {
      this.drive('running');
    }
  }
  answerPending(answers: Record<string, string>) {
    this.calls.push(`answer:${JSON.stringify(answers)}`);
  }
  allowPending() {
    this.calls.push('allow');
  }
  denyPending(message: string) {
    this.calls.push(`deny:${message}`);
  }
  async interrupt() {
    this.calls.push('interrupt');
  }
  setModel(model: string | undefined) {
    this.calls.push(`setModel:${model ?? 'default'}`);
  }
  abort() {
    this.aborted = true;
  }
  stop() {
    this.stopped = true;
  }
  archive() {
    this.calls.push('archive');
    this.state = { ...this.state, status: 'archived' };
    this.onChange(this.state);
  }
  setPr(pr: PrInfo | undefined) {
    this.calls.push(`setPr:${pr ? `#${pr.number}${pr.isDraft ? ':draft' : ''}` : 'none'}`);
    // Real reducer: it splits `pr` into the persisted ref + volatile status and keeps
    // each half's reference when unchanged, which is what the persist check reads.
    this.state = reduce(this.state, { kind: 'pr', pr, at: 0 });
    this.onChange(this.state);
  }
  setPrLookup(lookup: PrLookupState | undefined) {
    this.calls.push(`prLookup:${lookup ?? 'none'}`);
    this.state = reduce(this.state, { kind: 'pr_lookup', lookup, at: 0 });
    this.onChange(this.state);
  }
  markConflict(files: string[]) {
    this.calls.push(`conflict:${files.join(',')}`);
    this.state = { ...this.state, status: 'conflict', conflictFiles: files };
    this.onChange(this.state);
  }
  drive(status: SessionState['status'], sdkSessionId?: string) {
    this.state = { ...this.state, status, sdkSessionId: sdkSessionId ?? this.state.sdkSessionId };
    this.onChange(this.state);
  }
}

function makeManager() {
  const created: FakeSession[] = [];
  const manager = new SessionManager({
    worktrees: fakeWorktrees(),
    queryFn: (() => {
      throw new Error('should not be called with a fake factory');
    }) as never,
    now: () => 100,
    createSession: ({ input, onChange, restored, onRateLimit }) => {
      const s = new FakeSession(input, onChange, restored, onRateLimit);
      created.push(s);
      return s;
    },
  });
  return { manager, created };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('SessionManager', () => {
  it('create() returns synchronously with a creating snapshot', () => {
    const { manager } = makeManager();
    const listener = vi.fn();
    manager.subscribe(listener);
    const id = manager.create('Implement login');
    const snap = manager.getSnapshot();
    expect(snap).toHaveLength(1);
    expect(snap[0]?.id).toBe(id);
    expect(snap[0]?.status).toBe('creating');
    expect(snap[0]?.title).toBe('Implement login');
    expect(listener).toHaveBeenCalled();
  });

  it('provisions a worktree and starts the session in the background', async () => {
    const { manager, created } = makeManager();
    manager.create('Add feature');
    await flush();
    expect(created).toHaveLength(1);
    expect(created[0]?.started).toBe(true);
    expect(manager.getSnapshot()[0]?.branch).toBe('codiva/add-feature');
  });

  it('aggregates rate-limit events into a sorted, account-wide snapshot', async () => {
    const { manager, created } = makeManager();
    const listener = vi.fn();
    manager.subscribe(listener);
    expect(manager.getRateLimits()).toEqual([]);

    manager.create('task');
    await flush();
    listener.mockClear();

    // Weekly first, then the 5-hour window — the snapshot must sort five_hour first.
    created[0]?.emitRateLimit({
      status: 'allowed',
      rateLimitType: 'seven_day',
      utilization: 40,
      resetsAt: 2000,
    });
    created[0]?.emitRateLimit({
      status: 'allowed',
      rateLimitType: 'five_hour',
      utilization: 5,
      resetsAt: 1000,
    });
    const windows = manager.getRateLimits();
    expect(windows.map((w) => w.type)).toEqual(['five_hour', 'seven_day']);
    expect(windows[0]).toMatchObject({ utilization: 5, resetsAt: 1000_000 });
    expect(listener).toHaveBeenCalled();
  });

  it('ignores unchanged rate-limit events (stable reference, no re-render)', async () => {
    const { manager, created } = makeManager();
    manager.create('task');
    await flush();
    created[0]?.emitRateLimit({
      status: 'allowed',
      rateLimitType: 'five_hour',
      utilization: 5,
      resetsAt: 1000,
    });
    const first = manager.getRateLimits();
    const listener = vi.fn();
    manager.subscribe(listener);
    created[0]?.emitRateLimit({
      status: 'allowed',
      rateLimitType: 'five_hour',
      utilization: 5,
      resetsAt: 1000,
    });
    expect(manager.getRateLimits()).toBe(first); // same reference — no rebuild
    expect(listener).not.toHaveBeenCalled();
  });

  it('folds a polled usage snapshot into the account-wide state', () => {
    const { manager } = makeManager();
    const listener = vi.fn();
    manager.subscribe(listener);
    expect(manager.getAccount()).toBeUndefined();

    manager.applyUsage({
      account: { plan: 'Claude Team', organization: 'Example Inc' },
      usage: {
        plan: 'team',
        limitsAvailable: true,
        windows: [
          { type: 'seven_day', utilization: 48 },
          { type: 'five_hour', utilization: 12, resetsAt: 1000 },
        ],
      },
    });

    expect(manager.getAccount()).toEqual({ plan: 'Claude Team', organization: 'Example Inc' });
    // Sorted like event-derived windows: the 5-hour window leads.
    expect(manager.getRateLimits().map((w) => w.type)).toEqual(['five_hour', 'seven_day']);
    expect(manager.getRateLimits()[0]).toEqual({
      type: 'five_hour',
      status: 'allowed',
      utilization: 12,
      resetsAt: 1000,
    });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('lets a polled window fill in what the event omitted, keeping the event status', async () => {
    const { manager, created } = makeManager();
    manager.create('task');
    await flush();
    // The real five_hour event carries a reset time but no utilization.
    created[0]?.emitRateLimit({
      status: 'allowed_warning',
      rateLimitType: 'five_hour',
      resetsAt: 1000,
    });
    manager.applyUsage({
      usage: { limitsAvailable: true, windows: [{ type: 'five_hour', utilization: 42 }] },
    });
    expect(manager.getRateLimits()[0]).toEqual({
      type: 'five_hour',
      status: 'allowed_warning',
      utilization: 42,
      resetsAt: 1000_000,
    });
  });

  it("keeps the polled percentage when the next turn's event omits it", async () => {
    const { manager, created } = makeManager();
    manager.create('task');
    await flush();
    // Poll first: on some accounts this is the only source of a percentage.
    manager.applyUsage({
      usage: {
        limitsAvailable: true,
        windows: [{ type: 'five_hour', utilization: 42, resetsAt: 1000_000 }],
      },
    });
    // Then a turn starts: the real five_hour event has resetsAt but no utilization.
    created[0]?.emitRateLimit({ status: 'allowed', rateLimitType: 'five_hour', resetsAt: 1000 });
    expect(manager.getRateLimits()[0]).toEqual({
      type: 'five_hour',
      status: 'allowed',
      utilization: 42,
      resetsAt: 1000_000,
    });
  });

  it('drops the polled percentage once the window has rolled over', async () => {
    const { manager, created } = makeManager();
    manager.create('task');
    await flush();
    manager.applyUsage({
      usage: {
        limitsAvailable: true,
        windows: [{ type: 'five_hour', utilization: 42, resetsAt: 1000_000 }],
      },
    });
    // A later window (different reset time) — the old percentage no longer applies.
    created[0]?.emitRateLimit({ status: 'allowed', rateLimitType: 'five_hour', resetsAt: 5000 });
    expect(manager.getRateLimits()[0]).toEqual({
      type: 'five_hour',
      status: 'allowed',
      utilization: undefined,
      resetsAt: 5000_000,
    });
  });

  it('ignores a usage snapshot that changes nothing (stable reference, no re-render)', () => {
    const { manager } = makeManager();
    const snapshot = {
      account: { plan: 'Claude Team' },
      usage: {
        limitsAvailable: true,
        windows: [{ type: 'five_hour' as const, utilization: 12, resetsAt: 1000 }],
      },
    };
    manager.applyUsage(snapshot);
    const first = manager.getRateLimits();
    const listener = vi.fn();
    manager.subscribe(listener);
    manager.applyUsage(snapshot);
    expect(manager.getRateLimits()).toBe(first);
    expect(listener).not.toHaveBeenCalled();
  });

  it('keeps the previous account when a probe reports nothing', () => {
    const { manager } = makeManager();
    manager.applyUsage({ account: { plan: 'Claude Team' } });
    manager.applyUsage({});
    expect(manager.getAccount()).toEqual({ plan: 'Claude Team' });
  });

  it('avoids slug collisions across concurrent creates', async () => {
    const { manager } = makeManager();
    manager.create('feature');
    manager.create('feature');
    await flush();
    const branches = manager.getSnapshot().map((s) => s.branch);
    expect(new Set(branches).size).toBe(2);
    expect(branches).toContain('codiva/feature');
    expect(branches).toContain('codiva/feature-2');
  });

  it('marks the session failed if worktree creation throws', async () => {
    const manager = new SessionManager({
      worktrees: fakeWorktrees({
        add: async () => {
          throw new Error('disk full');
        },
      }),
      queryFn: (() => {
        throw new Error('unused');
      }) as never,
      now: () => 1,
      createSession: ({ input, onChange }) => new FakeSession(input, onChange),
    });
    manager.create('doomed');
    await flush();
    expect(manager.getSnapshot()[0]?.status).toBe('failed');
    expect(manager.getSnapshot()[0]?.error).toContain('disk full');
  });

  it('keeps object identity for unchanged sessions across rebuilds', async () => {
    const { manager, created } = makeManager();
    manager.create('a');
    manager.create('b');
    await flush();
    const before = manager.getSnapshot();
    const unchanged = before[0];
    // change only the second session
    created[1]?.drive('running');
    const after = manager.getSnapshot();
    expect(after).not.toBe(before); // new array
    expect(after[0]).toBe(unchanged); // untouched row keeps identity
    expect(after[1]).not.toBe(before[1]); // changed row is a new object
  });

  describe('remove()', () => {
    it('removes the worktree AND drops the row (gone from the list and state.json)', async () => {
      const remove = vi.fn(async () => {});
      const created: FakeSession[] = [];
      const onPersist = vi.fn();
      const manager = new SessionManager({
        worktrees: fakeWorktrees({ remove }),
        queryFn: (() => {
          throw new Error('unused');
        }) as never,
        now: () => 1,
        onPersist,
        createSession: ({ input, onChange }) => {
          const s = new FakeSession(input, onChange);
          created.push(s);
          return s;
        },
      });
      const id = manager.create('old pr');
      await flush();
      created[0]?.drive('completed', 'sdk-0');
      onPersist.mockClear();

      const result = await manager.remove(id, { force: true });

      expect(result.ok).toBe(true);
      expect(remove).toHaveBeenCalledWith(expect.anything(), { force: true });
      // Unlike discard, no `archived` row is left behind — the session is forgotten,
      // so the bulk recovery pass can never pick it up again.
      expect(manager.get(id)).toBeUndefined();
      expect(manager.getSnapshot()).toEqual([]);
      expect(manager.persistableState().sessions).toEqual([]);
      expect(created[0]?.stopped).toBe(true);
      expect(onPersist).toHaveBeenCalled(); // state.json を書き直させる
    });

    it('keeps the row when the worktree refuses to go', async () => {
      const manager = new SessionManager({
        worktrees: fakeWorktrees({
          remove: async () => {
            throw new Error('worktree is dirty');
          },
        }),
        queryFn: (() => {
          throw new Error('unused');
        }) as never,
        now: () => 1,
        createSession: ({ input, onChange }) => new FakeSession(input, onChange),
      });
      const id = manager.create('feature');
      await flush();

      const result = await manager.remove(id);

      expect(result.ok).toBe(false);
      expect(result.error).toContain('worktree is dirty');
      expect(manager.get(id)).toBeDefined(); // still listed — the directory is still there
    });

    it('forgets a row whose worktree is already gone (discarded earlier)', async () => {
      const { manager } = makeManager();
      const id = manager.create('feature');
      await flush();
      await manager.discard(id); // worktree + meta gone, row stays as archived

      const result = await manager.remove(id);

      expect(result.ok).toBe(true);
      expect(manager.get(id)).toBeUndefined();
    });

    it('remove on an unknown id returns an error', async () => {
      const { manager } = makeManager();
      expect((await manager.remove('nope')).ok).toBe(false);
    });
  });

  describe('clear()', () => {
    it('drops finished sessions (worktree removed, row forgotten) but keeps in-flight ones', async () => {
      const removed: string[] = [];
      const created: FakeSession[] = [];
      const manager = new SessionManager({
        worktrees: fakeWorktrees({
          remove: async (wt) => {
            removed.push(wt.slug);
          },
        }),
        queryFn: (() => {
          throw new Error('unused');
        }) as never,
        now: () => 100,
        createSession: ({ input, onChange }) => {
          const s = new FakeSession(input, onChange);
          created.push(s);
          return s;
        },
      });
      manager.create('done'); // 0 → completed
      manager.create('busy'); // 1 → running (kept)
      manager.create('gone'); // 2 → interrupted
      await flush();
      created[0]?.drive('completed', 'sdk-0');
      created[1]?.drive('running', 'sdk-1');
      created[2]?.drive('interrupted', 'sdk-2');

      const { cleared, error } = await manager.clear();

      expect(cleared).toBe(2);
      expect(error).toBeUndefined();
      // Worktrees of the finished sessions are gone; the running one is untouched.
      expect(removed).toEqual(['done', 'gone']);
      // Only the in-flight (running) session remains in the list.
      expect(manager.getSnapshot().map((s) => s.title)).toEqual(['busy']);
      // Cleared sessions were quietly stopped (not aborted), running one untouched.
      expect(created[0]?.stopped).toBe(true);
      expect(created[2]?.stopped).toBe(true);
      expect(created[1]?.stopped).toBe(false);
      expect(created.some((s) => s.aborted)).toBe(false);
    });

    it('excludes cleared sessions from the persisted snapshot (stay gone after restart)', async () => {
      const { manager, created } = makeManager();
      manager.create('done');
      await flush();
      created[0]?.drive('completed', 'sdk-0');
      expect(manager.persistableState().sessions).toHaveLength(1);

      await manager.clear();

      expect(manager.persistableState().sessions).toEqual([]);
    });

    it('signals a persist and notifies subscribers when it removes sessions', async () => {
      const onPersist = vi.fn();
      const created: FakeSession[] = [];
      const manager = new SessionManager({
        worktrees: fakeWorktrees(),
        queryFn: (() => {
          throw new Error('unused');
        }) as never,
        now: () => 100,
        onPersist,
        createSession: ({ input, onChange }) => {
          const s = new FakeSession(input, onChange);
          created.push(s);
          return s;
        },
      });
      manager.create('done');
      await flush();
      created[0]?.drive('completed', 'sdk-0');
      const listener = vi.fn();
      manager.subscribe(listener);
      onPersist.mockClear();

      await manager.clear();

      expect(onPersist).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalled(); // store rebuild notified subscribers
    });

    it('is a no-op (no persist) when there is nothing finished to clear', async () => {
      const onPersist = vi.fn();
      const manager = new SessionManager({
        worktrees: fakeWorktrees(),
        queryFn: (() => {
          throw new Error('unused');
        }) as never,
        now: () => 100,
        onPersist,
        createSession: ({ input, onChange }) => new FakeSession(input, onChange),
      });
      manager.create('busy');
      await flush();
      onPersist.mockClear();
      expect(await manager.clear()).toEqual({ cleared: 0, error: undefined });
      expect(onPersist).not.toHaveBeenCalled();
      expect(manager.getSnapshot()).toHaveLength(1);
    });

    it('keeps the rows whose worktree could not be removed and reports the failure', async () => {
      const created: FakeSession[] = [];
      const manager = new SessionManager({
        worktrees: fakeWorktrees({
          remove: async (wt) => {
            if (wt.slug === 'stuck') {
              throw new Error('worktree locked');
            }
          },
        }),
        queryFn: (() => {
          throw new Error('unused');
        }) as never,
        now: () => 100,
        createSession: ({ input, onChange }) => {
          const s = new FakeSession(input, onChange);
          created.push(s);
          return s;
        },
      });
      manager.create('stuck');
      manager.create('fine');
      await flush();
      created[0]?.drive('completed', 'sdk-0');
      created[1]?.drive('completed', 'sdk-1');

      const { cleared, error } = await manager.clear();

      // The directory is still on disk, so hiding its row would be a lie.
      expect(cleared).toBe(1);
      expect(error).toContain('worktree locked');
      expect(manager.getSnapshot().map((s) => s.title)).toEqual(['stuck']);
    });
  });

  it('dispose() quietly stops every session (resumable, not marked failed)', async () => {
    const { manager, created } = makeManager();
    manager.create('a');
    manager.create('b');
    await flush();
    manager.dispose();
    expect(created.every((s) => s.stopped)).toBe(true);
    expect(created.some((s) => s.aborted)).toBe(false);
  });

  it('exposes get() and forwards UI actions to the right session', async () => {
    const { manager, created } = makeManager();
    const id = manager.create('a');
    await flush();
    expect(manager.get(id)?.id).toBe(id);
    expect(manager.get('nope')).toBeUndefined();

    manager.send(id, 'more');
    manager.answer(id, { q: 'yes' });
    manager.allow(id);
    manager.deny(id, 'no');
    // interrupt はターンが走っているセッションだけが対象（下の describe を参照）。
    created[0]?.drive('running');
    await manager.interrupt(id);
    manager.setSessionModel(id, 'claude-fable-5');

    expect(created[0]?.calls).toEqual([
      'send:more',
      'answer:{"q":"yes"}',
      'allow',
      'deny:no',
      'interrupt',
      'setModel:claude-fable-5',
    ]);
  });

  it('setSessionModel targets one session and leaves the global default alone', async () => {
    const { manager, created } = makeManager();
    const id = manager.create('a');
    await flush();
    expect(manager.getModel()).toBeUndefined();
    manager.setSessionModel(id, 'claude-opus-4-8');
    // Only the session is told to switch; the global default (new sessions) is untouched.
    expect(created[0]?.calls).toContain('setModel:claude-opus-4-8');
    expect(manager.getModel()).toBeUndefined();
  });

  describe('resume() (one-key recovery)', () => {
    it('sends the instruction to a cut-off session', async () => {
      const { manager, created } = makeManager();
      const id = manager.create('a');
      await flush();
      const session = created[0];
      if (!session) {
        throw new Error('no session');
      }
      session.drive('interrupted');
      expect(manager.resume(id, 'continue')).toBe(true);
      expect(session.calls).toEqual(['send:continue']);
    });

    it('is a no-op for a session that is not cut off', async () => {
      const { manager, created } = makeManager();
      const id = manager.create('a');
      await flush();
      created[0]?.drive('running');
      // 実行中・完了済みを勝手に走らせない（completed は追加指示で continue できるが
      // それは「再開」ではないので、このキーの対象外）。
      expect(manager.resume(id, 'continue')).toBe(false);
      created[0]?.drive('completed');
      expect(manager.resume(id, 'continue')).toBe(false);
      expect(created[0]?.calls).toEqual([]);
    });

    it('ignores a repeated resume: the second press finds the session already running', async () => {
      // 一押し再開キーの連打・オートリピート対策。UI の購読はスロットルされるので、
      // 「もう再開済み」の判定はストアの現在値を持つここでしかできない。
      const { manager, created } = makeManager();
      const id = manager.create('a');
      await flush();
      const session = created[0];
      if (!session) {
        throw new Error('no session');
      }
      session.drive('interrupted');
      // 本物の Session.send は同期的に running へ進める。
      session.sendMovesToRunning = true;
      expect(manager.resume(id, 'continue')).toBe(true);
      expect(manager.resume(id, 'continue')).toBe(false);
      expect(session.calls).toEqual(['send:continue']);
    });

    it('is a no-op for an unknown id', () => {
      const { manager } = makeManager();
      expect(manager.resume('nope', 'continue')).toBe(false);
    });
  });

  describe('interrupt() (Ctrl+C in the detail view)', () => {
    it('forwards to a session whose turn is in flight', async () => {
      const { manager, created } = makeManager();
      const id = manager.create('a');
      await flush();
      created[0]?.drive('running');
      await expect(manager.interrupt(id)).resolves.toBe(true);
      expect(created[0]?.calls).toEqual(['interrupt']);
    });

    // 許可/質問待ちもターンは生きている（回答待ちで止まっているだけ）ので中断できる。
    it('forwards while the session waits on a permission/question', async () => {
      const { manager, created } = makeManager();
      const id = manager.create('a');
      await flush();
      created[0]?.drive('awaiting_permission');
      await expect(manager.interrupt(id)).resolves.toBe(true);
      created[0]?.drive('awaiting_input');
      await expect(manager.interrupt(id)).resolves.toBe(true);
      expect(created[0]?.calls).toEqual(['interrupt', 'interrupt']);
    });

    // 止めるターンが無い状態では何もしない。判定をここ（ストアの現在値）で行うのは
    // resume() と同じ理由 — UI の購読はスロットルされているので連打を弾けない。
    it.each<SessionState['status']>(['creating', 'completed', 'interrupted', 'failed', 'archived'])(
      'is a no-op for a %s session',
      async (status) => {
        const { manager, created } = makeManager();
        const id = manager.create('a');
        await flush();
        created[0]?.drive(status);
        await expect(manager.interrupt(id)).resolves.toBe(false);
        expect(created[0]?.calls).toEqual([]);
      },
    );

    it('is a no-op for an unknown id', async () => {
      const { manager } = makeManager();
      await expect(manager.interrupt('nope')).resolves.toBe(false);
    });
  });

  it('ignores UI actions for unknown session ids', async () => {
    const { manager } = makeManager();
    expect(() => manager.send('x', 'y')).not.toThrow();
    await expect(manager.interrupt('x')).resolves.toBe(false);
    expect(() => manager.setSessionModel('x', 'claude-fable-5')).not.toThrow();
  });

  describe('lifecycle', () => {
    it('diffStat delegates to the worktree service', async () => {
      const diffStat = vi.fn(async () => ({ committed: ' a.txt | 1 +', uncommitted: ['b.txt'] }));
      const manager = new SessionManager({
        worktrees: fakeWorktrees({ diffStat }),
        queryFn: (() => {
          throw new Error('unused');
        }) as never,
        now: () => 1,
        createSession: ({ input, onChange }) => new FakeSession(input, onChange),
      });
      const id = manager.create('feature');
      await flush();
      const stat = await manager.diffStat(id);
      expect(stat).toEqual({ committed: ' a.txt | 1 +', uncommitted: ['b.txt'] });
      expect(diffStat).toHaveBeenCalledWith(
        expect.objectContaining({ branch: 'codiva/feature' }),
        'main',
      );
    });

    it('merge succeeds → session archived', async () => {
      const { manager, created } = makeManager();
      const id = manager.create('feature');
      await flush();
      const result = await manager.merge(id);
      expect(result.ok).toBe(true);
      expect(created[0]?.calls).toContain('archive');
      expect(manager.get(id)?.status).toBe('archived');
    });

    it('merge failure surfaces the error and does NOT archive', async () => {
      const manager = new SessionManager({
        worktrees: fakeWorktrees({
          merge: async () => {
            throw new Error('conflict in README.md');
          },
        }),
        queryFn: (() => {
          throw new Error('unused');
        }) as never,
        now: () => 1,
        createSession: ({ input, onChange }) => new FakeSession(input, onChange),
      });
      const id = manager.create('feature');
      await flush();
      const result = await manager.merge(id);
      expect(result.ok).toBe(false);
      expect(result.error).toContain('conflict');
      expect(manager.get(id)?.status).not.toBe('archived');
    });

    it('discard aborts the session, removes the worktree, and archives', async () => {
      const remove = vi.fn(async () => {});
      const manager = new SessionManager({
        worktrees: fakeWorktrees({ remove }),
        queryFn: (() => {
          throw new Error('unused');
        }) as never,
        now: () => 1,
        createSession: ({ input, onChange }) => new FakeSession(input, onChange),
      });
      const id = manager.create('feature');
      await flush();
      const result = await manager.discard(id, { force: true });
      expect(result.ok).toBe(true);
      expect(remove).toHaveBeenCalledWith(expect.anything(), { force: true });
      expect(manager.get(id)?.status).toBe('archived');
    });

    it('merge/discard on an unknown id return an error', async () => {
      const { manager } = makeManager();
      expect((await manager.merge('nope')).ok).toBe(false);
      expect((await manager.discard('nope')).ok).toBe(false);
      expect(await manager.diffStat('nope')).toBeUndefined();
    });

    it('activeWorktreePaths lists provisioned worktrees and drops discarded ones', async () => {
      const { manager } = makeManager();
      const id = manager.create('feature');
      await flush();
      expect(manager.activeWorktreePaths()).toEqual(['/tmp/wt/feature']);
      await manager.discard(id);
      expect(manager.activeWorktreePaths()).toEqual([]);
    });
  });

  describe('persistence (restore / persistableState)', () => {
    it('persistableState captures restorable sessions with slug + base', async () => {
      const { manager, created } = makeManager();
      manager.create('add login');
      await flush();
      created[0]?.drive('completed', 'sdk-1');
      const persisted = manager.persistableState();
      expect(persisted.version).toBe(1);
      expect(persisted.sessions).toHaveLength(1);
      expect(persisted.sessions[0]).toMatchObject({
        title: 'add login',
        slug: 'add-login',
        branch: 'codiva/add-login',
        base: 'main',
        sdkSessionId: 'sdk-1',
        status: 'completed',
      });
    });

    it('persistableState omits sessions that never got an sdkSessionId', async () => {
      const { manager, created } = makeManager();
      manager.create('no session id');
      await flush();
      created[0]?.drive('completed'); // no sdkSessionId → not resumable
      expect(manager.persistableState().sessions).toEqual([]);
    });

    it('persistableState omits creating and archived sessions', async () => {
      const { manager, created } = makeManager();
      manager.create('still creating'); // stays 'creating' (fake never drives it)
      const id2 = manager.create('to archive');
      await flush();
      created[1]?.drive('completed');
      await manager.merge(id2); // → archived
      expect(manager.persistableState().sessions).toEqual([]);
    });

    it('restore rehydrates idle sessions without starting them', () => {
      const { manager, created } = makeManager();
      manager.restore({
        version: 1,
        sessions: [
          {
            id: '1',
            title: 'Restored task',
            prompt: 'do it',
            slug: 'restored',
            branch: 'codiva/restored',
            worktreePath: '/tmp/wt/restored',
            base: 'main',
            sdkSessionId: 'sdk-old',
            status: 'completed',
            startedAt: 3,
            todos: [],
          },
        ],
      });
      const snap = manager.getSnapshot();
      expect(snap).toHaveLength(1);
      expect(snap[0]).toMatchObject({ id: '1', title: 'Restored task', status: 'completed' });
      // Not started: it resumes lazily on the first follow-up.
      expect(created[0]?.started).toBe(false);
    });

    it('restore forwards resume + restored state to the session factory', () => {
      let seen: { resume?: string; restored?: SessionState } | undefined;
      const manager = new SessionManager({
        worktrees: fakeWorktrees(),
        queryFn: (() => {
          throw new Error('unused');
        }) as never,
        now: () => 1,
        createSession: ({ input, onChange, resume, restored }) => {
          seen = { resume, restored };
          return new FakeSession(input, onChange, restored);
        },
      });
      manager.restore({
        version: 1,
        sessions: [
          {
            id: '4',
            title: 't',
            prompt: 'p',
            slug: 's',
            branch: 'codiva/s',
            worktreePath: '/tmp/wt/s',
            base: 'main',
            sdkSessionId: 'sdk-4',
            status: 'completed',
            startedAt: 0,
            todos: [],
          },
        ],
      });
      expect(seen?.resume).toBe('sdk-4');
      expect(seen?.restored?.status).toBe('completed');
    });

    it('reserves restored ids/slugs so new sessions do not collide', async () => {
      const { manager } = makeManager();
      manager.restore({
        version: 1,
        sessions: [
          {
            id: '1',
            title: 't',
            prompt: 'p',
            slug: 'feature',
            branch: 'codiva/feature',
            worktreePath: '/tmp/wt/feature',
            base: 'main',
            sdkSessionId: 'sdk-1',
            status: 'completed',
            startedAt: 0,
            todos: [],
          },
        ],
      });
      const newId = manager.create('feature');
      await flush();
      expect(newId).toBe('2'); // seq advanced past restored id '1'
      const branches = manager.getSnapshot().map((s) => s.branch);
      expect(new Set(branches).size).toBe(2); // no slug collision
    });

    it('restore wires worktree meta so discard works', async () => {
      const remove = vi.fn(async () => {});
      const manager = new SessionManager({
        worktrees: fakeWorktrees({ remove }),
        queryFn: (() => {
          throw new Error('unused');
        }) as never,
        now: () => 1,
        createSession: ({ input, onChange, restored }) =>
          new FakeSession(input, onChange, restored),
      });
      manager.restore({
        version: 1,
        sessions: [
          {
            id: '1',
            title: 't',
            prompt: 'p',
            slug: 's',
            branch: 'codiva/s',
            worktreePath: '/tmp/wt/s',
            base: 'main',
            sdkSessionId: 'sdk-1',
            status: 'completed',
            startedAt: 0,
            todos: [],
          },
        ],
      });
      const result = await manager.discard('1', { force: true });
      expect(result.ok).toBe(true);
      expect(remove).toHaveBeenCalled();
    });

    it('onPersist fires when sessions change', () => {
      const onPersist = vi.fn();
      const manager = new SessionManager({
        worktrees: fakeWorktrees(),
        queryFn: (() => {
          throw new Error('unused');
        }) as never,
        now: () => 1,
        onPersist,
        createSession: ({ input, onChange, restored }) =>
          new FakeSession(input, onChange, restored),
      });
      manager.create('a');
      expect(onPersist).toHaveBeenCalled();
    });
  });

  describe('onTransition (desktop notifications)', () => {
    it('fires with (prev, next) only when the status changes', async () => {
      const transitions: [string, string][] = [];
      const manager = new SessionManager({
        worktrees: fakeWorktrees(),
        queryFn: (() => {
          throw new Error('unused');
        }) as never,
        now: () => 1,
        onTransition: (prev, next) => transitions.push([prev.status, next.status]),
        createSession: ({ input, onChange }) => new FakeSession(input, onChange),
      });
      const id = manager.create('feature');
      await flush();
      const session = (manager as unknown as { sessions: Map<string, FakeSession> }).sessions.get(
        id,
      );
      session?.drive('running'); // creating → running
      session?.drive('running'); // no-op: same status, no transition
      session?.drive('completed'); // running → completed
      expect(transitions).toEqual([
        ['creating', 'running'],
        ['running', 'completed'],
      ]);
    });

    it('is optional — omitting it does not throw on status changes', async () => {
      const { manager, created } = makeManager();
      manager.create('feature');
      await flush();
      expect(() => created[0]?.drive('running')).not.toThrow();
    });
  });

  describe('refreshPrs (gh PR detection)', () => {
    it('looks up each live session by worktree path + branch and feeds setPr', async () => {
      const lookupPr = vi.fn(
        async (_cwd: string, branch: string): Promise<PrLookupResult> =>
          branch === 'codiva/feature'
            ? {
                kind: 'found',
                pr: { number: 42, url: 'https://x/pr/42', mergeStatus: 'mergeable' },
              }
            : { kind: 'absent' },
      );
      const created: FakeSession[] = [];
      const manager = new SessionManager({
        worktrees: fakeWorktrees(),
        queryFn: (() => {
          throw new Error('unused');
        }) as never,
        now: () => 1,
        lookupPr,
        createSession: ({ input, onChange }) => {
          const s = new FakeSession(input, onChange);
          created.push(s);
          return s;
        },
      });
      manager.create('feature');
      await flush();
      await manager.refreshPrs();
      expect(lookupPr).toHaveBeenCalledWith('/tmp/wt/feature', 'codiva/feature');
      expect(manager.getSnapshot()[0]?.pr).toEqual({ number: 42, url: 'https://x/pr/42' });
      expect(manager.getSnapshot()[0]?.prStatus).toEqual({ mergeStatus: 'mergeable' });
      expect(created[0]?.calls).toContain('setPr:#42');
    });

    // The PR number is persisted, the status isn't — so a poll that only moves the
    // checks glyph must not mark state.json dirty (that would re-save every 20s).
    it('signals a persist for a newly found PR but not for a status-only change', async () => {
      const now = { value: 0 };
      let result: PrLookupResult = {
        kind: 'found',
        pr: { number: 7, url: 'u', mergeStatus: 'unknown', checks: 'pending' },
      };
      const onPersist = vi.fn();
      const created: FakeSession[] = [];
      const manager = new SessionManager({
        worktrees: fakeWorktrees(),
        queryFn: (() => {
          throw new Error('unused');
        }) as never,
        now: () => now.value,
        onPersist,
        lookupPr: async () => result,
        createSession: ({ input, onChange }) => {
          const s = new FakeSession(input, onChange);
          created.push(s);
          return s;
        },
      });
      manager.create('feature');
      await flush();
      created[0]?.drive('completed', 'sdk-1');
      onPersist.mockClear();

      // Discovering the PR is worth persisting (the number survives a restart).
      await manager.refreshPrs();
      expect(manager.getSnapshot()[0]?.pr).toEqual({ number: 7, url: 'u' });
      expect(onPersist).toHaveBeenCalledTimes(1);
      expect(manager.persistableState().sessions[0]?.pr).toEqual({ number: 7, url: 'u' });

      // CI finishing changes only the cached status half → no re-save.
      onPersist.mockClear();
      result = {
        kind: 'found',
        pr: { number: 7, url: 'u', mergeStatus: 'mergeable', checks: 'passing' },
      };
      now.value += 60_000;
      await manager.refreshPrs();
      expect(manager.getSnapshot()[0]?.prStatus).toEqual({
        mergeStatus: 'mergeable',
        checks: 'passing',
      });
      expect(onPersist).not.toHaveBeenCalled();
    });

    it('is a no-op when no lookupPr is wired', async () => {
      const { manager, created } = makeManager();
      manager.create('feature');
      await flush();
      await expect(manager.refreshPrs()).resolves.toBeUndefined();
      expect(created[0]?.calls.some((c) => c.startsWith('setPr'))).toBe(false);
    });

    it('skips archived sessions and survives a lookup that throws', async () => {
      const lookupPr = vi.fn(async () => {
        throw new Error('gh not installed');
      });
      const created: FakeSession[] = [];
      const manager = new SessionManager({
        worktrees: fakeWorktrees(),
        queryFn: (() => {
          throw new Error('unused');
        }) as never,
        now: () => 1,
        lookupPr,
        createSession: ({ input, onChange }) => {
          const s = new FakeSession(input, onChange);
          created.push(s);
          return s;
        },
      });
      const id = manager.create('feature');
      await flush();
      await manager.merge(id); // → archived
      await expect(manager.refreshPrs()).resolves.toBeUndefined();
      // Archived rows are skipped entirely, so lookup is never attempted.
      expect(lookupPr).not.toHaveBeenCalled();
    });

    it('readies a draft PR once its checks pass (auto-ready)', async () => {
      const lookupPr = vi.fn(
        async (): Promise<PrLookupResult> => ({
          kind: 'found',
          pr: { number: 5, url: 'u', mergeStatus: 'unknown', isDraft: true, checks: 'passing' },
        }),
      );
      const prAutomation: PrAutomation = {
        createPr: vi.fn(async () => undefined),
        markReady: vi.fn(async () => {}),
      };
      const created: FakeSession[] = [];
      const manager = new SessionManager({
        worktrees: fakeWorktrees(),
        queryFn: (() => {
          throw new Error('unused');
        }) as never,
        now: () => 1,
        lookupPr,
        autoPr: true,
        prAutomation,
        createSession: ({ input, onChange }) => {
          const s = new FakeSession(input, onChange);
          created.push(s);
          return s;
        },
      });
      manager.create('feature');
      await flush();
      await manager.refreshPrs();
      expect(prAutomation.markReady).toHaveBeenCalledWith('/tmp/wt/feature', 'codiva/feature');
      expect(manager.getSnapshot()[0]?.pr).toEqual({ number: 5, url: 'u' });
      expect(manager.getSnapshot()[0]?.prStatus).toEqual({
        mergeStatus: 'unknown',
        checks: 'passing',
        isDraft: false,
      });
    });

    it('does not ready a draft PR while checks are pending', async () => {
      const lookupPr = vi.fn(
        async (): Promise<PrLookupResult> => ({
          kind: 'found',
          pr: { number: 5, url: 'u', mergeStatus: 'unknown', isDraft: true, checks: 'pending' },
        }),
      );
      const prAutomation: PrAutomation = {
        createPr: vi.fn(async () => undefined),
        markReady: vi.fn(async () => {}),
      };
      const manager = new SessionManager({
        worktrees: fakeWorktrees(),
        queryFn: (() => {
          throw new Error('unused');
        }) as never,
        now: () => 1,
        lookupPr,
        autoPr: true,
        prAutomation,
        createSession: ({ input, onChange }) => new FakeSession(input, onChange),
      });
      manager.create('feature');
      await flush();
      await manager.refreshPrs();
      expect(prAutomation.markReady).not.toHaveBeenCalled();
    });
  });

  describe('followOrigin (origin auto-follow)', () => {
    it('branches from origin/<base> when enabled and available', async () => {
      const add = vi.fn(async (slug: string) => ({
        slug,
        branch: `codiva/${slug}`,
        path: `/tmp/wt/${slug}`,
      }));
      const manager = new SessionManager({
        worktrees: fakeWorktrees({ add, syncedStartPoint: async () => 'origin/main' }),
        queryFn: (() => {
          throw new Error('unused');
        }) as never,
        now: () => 1,
        followOrigin: true,
        createSession: ({ input, onChange }) => new FakeSession(input, onChange),
      });
      manager.create('feature');
      await flush();
      expect(add).toHaveBeenCalledWith('feature', 'origin/main');
    });

    it('branches from local HEAD when followOrigin is off', async () => {
      const add = vi.fn(async (slug: string) => ({
        slug,
        branch: `codiva/${slug}`,
        path: `/tmp/wt/${slug}`,
      }));
      const syncedStartPoint = vi.fn(async () => 'origin/main');
      const manager = new SessionManager({
        worktrees: fakeWorktrees({ add, syncedStartPoint }),
        queryFn: (() => {
          throw new Error('unused');
        }) as never,
        now: () => 1,
        followOrigin: false,
        createSession: ({ input, onChange }) => new FakeSession(input, onChange),
      });
      manager.create('feature');
      await flush();
      expect(syncedStartPoint).not.toHaveBeenCalled();
      expect(add).toHaveBeenCalledWith('feature', undefined);
    });
  });

  describe('autoPr (draft PR on completion)', () => {
    function autoPrManager(over: Partial<WorktreeService> = {}) {
      const pushBranch = vi.fn(async () => {});
      const createPr = vi.fn(async () => ({
        number: 8,
        url: 'u',
        mergeStatus: 'unknown' as const,
        isDraft: true,
      }));
      const prAutomation: PrAutomation = {
        createPr,
        markReady: async () => {},
      };
      const created: FakeSession[] = [];
      const manager = new SessionManager({
        worktrees: fakeWorktrees({
          pushBranch,
          diffStat: async () => ({ committed: ' file.ts | 1 +', uncommitted: [] }),
          ...over,
        }),
        queryFn: (() => {
          throw new Error('unused');
        }) as never,
        now: () => 1,
        autoPr: true,
        prAutomation,
        createSession: ({ input, onChange }) => {
          const s = new FakeSession(input, onChange);
          created.push(s);
          return s;
        },
      });
      return { manager, created, pushBranch, createPr };
    }

    it('pushes and opens a draft PR when a session completes with committed work', async () => {
      const { manager, created, pushBranch, createPr } = autoPrManager();
      manager.create('feature');
      await flush();
      created[0]?.drive('completed');
      await flush();
      expect(pushBranch).toHaveBeenCalledTimes(1);
      expect(createPr).toHaveBeenCalledWith('/tmp/wt/feature', 'codiva/feature');
      // The number is shown immediately (and persisted); its status rides along.
      expect(manager.getSnapshot()[0]?.pr).toEqual({ number: 8, url: 'u' });
      expect(manager.getSnapshot()[0]?.prStatus).toEqual({
        mergeStatus: 'unknown',
        isDraft: true,
      });
    });

    it('skips PR creation when there are no committed changes', async () => {
      const { manager, created, pushBranch, createPr } = autoPrManager({
        diffStat: async () => ({ committed: '', uncommitted: ['wip.ts'] }),
      });
      manager.create('feature');
      await flush();
      created[0]?.drive('completed');
      await flush();
      expect(pushBranch).not.toHaveBeenCalled();
      expect(createPr).not.toHaveBeenCalled();
    });

    it('opens a PR at most once across repeated completions', async () => {
      const { manager, created, createPr } = autoPrManager();
      manager.create('feature');
      await flush();
      created[0]?.drive('completed');
      await flush();
      created[0]?.drive('running');
      created[0]?.drive('completed');
      await flush();
      expect(createPr).toHaveBeenCalledTimes(1);
    });

    it('is inert when autoPr is off', async () => {
      const { manager, created, pushBranch } = (() => {
        const pushBranch = vi.fn(async () => {});
        const created: FakeSession[] = [];
        const manager = new SessionManager({
          worktrees: fakeWorktrees({
            pushBranch,
            diffStat: async () => ({ committed: ' f | 1 +', uncommitted: [] }),
          }),
          queryFn: (() => {
            throw new Error('unused');
          }) as never,
          now: () => 1,
          autoPr: false,
          prAutomation: {
            createPr: async () => undefined,
            markReady: async () => {},
          },
          createSession: ({ input, onChange }) => {
            const s = new FakeSession(input, onChange);
            created.push(s);
            return s;
          },
        });
        return { manager, created, pushBranch };
      })();
      manager.create('feature');
      await flush();
      created[0]?.drive('completed');
      await flush();
      expect(pushBranch).not.toHaveBeenCalled();
    });
  });

  describe('recover() (PR stuck on a conflict or red CI)', () => {
    const m = messages.ja;

    function recoverManager(over: Partial<WorktreeService> = {}) {
      const pushBranch = vi.fn(async () => {});
      // `over.syncBase` を素で渡すと返り値の spy と別物になる（呼び出し回数を数えられない）
      // ので、上書きがあってもこの spy でくるんでから WorktreeService に載せる。
      const behavior = over.syncBase;
      const syncBase = vi.fn<WorktreeService['syncBase']>(
        behavior ?? (async () => ({ kind: 'upToDate' })),
      );
      const created: FakeSession[] = [];
      const manager = new SessionManager({
        worktrees: fakeWorktrees({ ...over, pushBranch, syncBase }),
        queryFn: (() => {
          throw new Error('unused');
        }) as never,
        now: () => 1,
        messages: m,
        createSession: ({ input, onChange }) => {
          const s = new FakeSession(input, onChange);
          created.push(s);
          return s;
        },
      });
      return { manager, created, pushBranch, syncBase };
    }

    /** Drive a freshly created session to `completed` with the given PR state. */
    async function stuck(
      created: FakeSession[],
      pr: Parameters<FakeSession['setPr']>[0],
    ): Promise<FakeSession> {
      await flush();
      const session = created[0];
      if (!session) {
        throw new Error('no session');
      }
      session.drive('completed');
      session.setPr(pr);
      return session;
    }

    it('merges the base in and pushes when it applies cleanly — no turn spent', async () => {
      const { manager, created, pushBranch, syncBase } = recoverManager({
        syncBase: async () => ({ kind: 'updated', ref: 'origin/main' }),
      });
      manager.create('feature');
      const session = await stuck(created, { number: 3, url: 'u', mergeStatus: 'conflicting' });

      await expect(manager.recover('1')).resolves.toEqual({ kind: 'synced' });
      expect(syncBase).toHaveBeenCalledTimes(1);
      expect(pushBranch).toHaveBeenCalledTimes(1);
      // The whole point of the cheap path: Claude was never woken up.
      expect(session.calls.filter((c) => c.startsWith('send:'))).toEqual([]);
    });

    it('hands a conflicted merge to the session, with the file list', async () => {
      const { manager, created, pushBranch } = recoverManager({
        syncBase: async () => ({ kind: 'conflict', ref: 'origin/main', files: ['a.ts'] }),
      });
      manager.create('feature');
      const session = await stuck(created, { number: 3, url: 'u', mergeStatus: 'conflicting' });

      await expect(manager.recover('1')).resolves.toEqual({
        kind: 'delegated',
        recovery: 'sync',
      });
      const sent = session.calls.find((c) => c.startsWith('send:'));
      expect(sent).toContain('a.ts');
      // Nothing is pushed: the branch is mid-merge until the session resolves it.
      expect(pushBranch).not.toHaveBeenCalled();
    });

    it('hands an uncommitted worktree to the session instead of merging over it', async () => {
      const { manager, created } = recoverManager({
        syncBase: async () => ({ kind: 'dirty', files: ['wip.ts'] }),
      });
      manager.create('feature');
      const session = await stuck(created, { number: 3, url: 'u', mergeStatus: 'conflicting' });

      await expect(manager.recover('1')).resolves.toEqual({
        kind: 'delegated',
        recovery: 'sync',
      });
      expect(session.calls.find((c) => c.startsWith('send:'))).toContain('wip.ts');
    });

    it('reports up-to-date without pushing', async () => {
      const { manager, created, pushBranch } = recoverManager();
      manager.create('feature');
      const session = await stuck(created, { number: 3, url: 'u', mergeStatus: 'conflicting' });

      await expect(manager.recover('1')).resolves.toEqual({ kind: 'upToDate' });
      expect(pushBranch).not.toHaveBeenCalled();
      expect(session.calls.filter((c) => c.startsWith('send:'))).toEqual([]);
    });

    it('names the failing checks when asking the session to fix CI', async () => {
      const { manager, created, syncBase } = recoverManager();
      manager.create('feature');
      const session = await stuck(created, {
        number: 3,
        url: 'u',
        mergeStatus: 'mergeable',
        checks: 'failing',
        failingChecks: [{ name: 'CI / test', url: 'https://example.test/run/2' }],
      });

      await expect(manager.recover('1')).resolves.toEqual({ kind: 'delegated', recovery: 'ci' });
      const sent = session.calls.find((c) => c.startsWith('send:'));
      expect(sent).toContain('CI / test');
      expect(sent).toContain('https://example.test/run/2');
      // A red build is not a merge problem — git is left alone.
      expect(syncBase).not.toHaveBeenCalled();
    });

    it('surfaces a git failure instead of swallowing it', async () => {
      const { manager, created } = recoverManager({
        syncBase: async () => {
          throw new Error('detached HEAD');
        },
      });
      manager.create('feature');
      await stuck(created, { number: 3, url: 'u', mergeStatus: 'conflicting' });

      await expect(manager.recover('1')).resolves.toEqual({
        kind: 'error',
        error: 'detached HEAD',
      });
    });

    it('skips a session with nothing wrong', async () => {
      const { manager, created, syncBase } = recoverManager();
      manager.create('feature');
      await stuck(created, { number: 3, url: 'u', mergeStatus: 'mergeable', checks: 'passing' });

      await expect(manager.recover('1')).resolves.toEqual({ kind: 'skipped' });
      expect(syncBase).not.toHaveBeenCalled();
    });

    it('refuses to touch a worktree while the session is still working', async () => {
      // `git merge` inside a worktree Claude is actively editing races with its
      // writes, so the guard covers the explicit `/sync` too — not just the poll.
      const { manager, created, syncBase } = recoverManager({
        syncBase: async () => ({ kind: 'updated', ref: 'origin/main' }),
      });
      manager.create('feature');
      await flush();
      created[0]?.drive('running');

      await expect(manager.recover('1', 'sync')).resolves.toEqual({ kind: 'busy' });
      expect(syncBase).not.toHaveBeenCalled();
    });

    it('an explicit kind works before the PR poll has answered (`/sync` on any row)', async () => {
      const { manager, created, syncBase } = recoverManager({
        syncBase: async () => ({ kind: 'updated', ref: 'origin/main' }),
      });
      manager.create('feature');
      await flush();
      created[0]?.drive('completed');

      // No pr/prStatus at all — recoveryKindFor would decline, the explicit kind wins.
      await expect(manager.recover('1', 'sync')).resolves.toEqual({ kind: 'synced' });
      expect(syncBase).toHaveBeenCalledTimes(1);
    });

    it('is inert without a message catalog (it must not invent prompt text)', async () => {
      const syncBase = vi.fn<WorktreeService['syncBase']>(async () => ({ kind: 'upToDate' }));
      const created: FakeSession[] = [];
      const manager = new SessionManager({
        worktrees: fakeWorktrees({ syncBase }),
        queryFn: (() => {
          throw new Error('unused');
        }) as never,
        now: () => 1,
        createSession: ({ input, onChange }) => {
          const s = new FakeSession(input, onChange);
          created.push(s);
          return s;
        },
      });
      manager.create('feature');
      await stuck(created, { number: 3, url: 'u', mergeStatus: 'conflicting' });

      await expect(manager.recover('1', 'sync')).resolves.toEqual({ kind: 'skipped' });
      expect(syncBase).not.toHaveBeenCalled();
    });

    it('recoverable() lists the stuck sessions with what each one needs', async () => {
      const { manager, created } = recoverManager();
      manager.create('a');
      manager.create('b');
      manager.create('c');
      await flush();
      created[0]?.drive('completed');
      created[0]?.setPr({ number: 1, url: 'u', mergeStatus: 'mergeable', checks: 'passing' });
      created[1]?.drive('completed');
      created[1]?.setPr({ number: 2, url: 'u', mergeStatus: 'conflicting' });
      created[2]?.drive('completed');
      created[2]?.setPr({ number: 3, url: 'u', mergeStatus: 'mergeable', checks: 'failing' });

      expect(manager.recoverable().map((r) => [r.state.id, r.kind])).toEqual([
        ['2', 'sync'],
        ['3', 'ci'],
      ]);
    });
  });

  describe('merge conflict detection', () => {
    it('flags the session as conflict (never auto-resolves) on a MergeConflictError', async () => {
      const created: FakeSession[] = [];
      const manager = new SessionManager({
        worktrees: fakeWorktrees({
          merge: async () => {
            throw new MergeConflictError('codiva/feature', 'main', ['README.md']);
          },
        }),
        queryFn: (() => {
          throw new Error('unused');
        }) as never,
        now: () => 1,
        createSession: ({ input, onChange }) => {
          const s = new FakeSession(input, onChange);
          created.push(s);
          return s;
        },
      });
      const id = manager.create('feature');
      await flush();
      const result = await manager.merge(id);
      expect(result.ok).toBe(false);
      expect(created[0]?.calls).toContain('conflict:README.md');
      expect(manager.getSnapshot()[0]?.status).toBe('conflict');
    });
  });

  describe('run mode (shift+tab toggle)', () => {
    it('defaults to auto', () => {
      const { manager } = makeManager();
      expect(manager.getMode()).toBe('auto');
    });

    it('cycleMode toggles auto ⇄ confirm and returns the new mode', () => {
      const { manager } = makeManager();
      expect(manager.cycleMode()).toBe('confirm');
      expect(manager.getMode()).toBe('confirm');
      expect(manager.cycleMode()).toBe('auto');
      expect(manager.getMode()).toBe('auto');
    });

    it('notifies subscribers without rebuilding the session snapshot', () => {
      const { manager } = makeManager();
      const listener = vi.fn();
      manager.subscribe(listener);
      const before = manager.getSnapshot();
      manager.cycleMode();
      expect(listener).toHaveBeenCalledTimes(1);
      // Sessions did not change, so their snapshot array keeps identity.
      expect(manager.getSnapshot()).toBe(before);
    });
  });

  describe('model selection (/model)', () => {
    it('seeds getModel from the injected options and updates on setModel', () => {
      const manager = new SessionManager({
        worktrees: fakeWorktrees(),
        queryFn: (() => {
          throw new Error('unused');
        }) as never,
        now: () => 1,
        options: { model: 'claude-opus-4-8' },
        createSession: ({ input, onChange }) => new FakeSession(input, onChange),
      });
      expect(manager.getModel()).toBe('claude-opus-4-8');
      manager.setModel('claude-haiku-4-5');
      expect(manager.getModel()).toBe('claude-haiku-4-5');
    });

    it('fires onModelChange only when the model actually changes', () => {
      const onModelChange = vi.fn();
      const manager = new SessionManager({
        worktrees: fakeWorktrees(),
        queryFn: (() => {
          throw new Error('unused');
        }) as never,
        now: () => 1,
        options: { model: 'claude-opus-4-8' },
        onModelChange,
        createSession: ({ input, onChange }) => new FakeSession(input, onChange),
      });
      manager.setModel('claude-opus-4-8'); // no-op: same value
      expect(onModelChange).not.toHaveBeenCalled();
      manager.setModel(undefined); // back to CLI default
      expect(onModelChange).toHaveBeenCalledWith(undefined);
    });

    it('applies the selected model to sessions created afterward', async () => {
      const models: (string | undefined)[] = [];
      const manager = new SessionManager({
        worktrees: fakeWorktrees(),
        // Real Session path (no createSession factory) so options reach the query.
        queryFn: ((params: { options: { model?: string } }) => {
          models.push(params.options.model);
          return (async function* () {})();
        }) as never,
        now: () => 1,
        options: { model: 'claude-opus-4-8' },
      });
      manager.create('first');
      await flush();
      manager.setModel('claude-haiku-4-5');
      manager.create('second');
      await flush();
      expect(models).toEqual(['claude-opus-4-8', 'claude-haiku-4-5']);
    });
  });

  describe('repo instructions (/prompt)', () => {
    it('seeds getRepoPrompt from the injected options and updates on setRepoPrompt', () => {
      const manager = new SessionManager({
        worktrees: fakeWorktrees(),
        queryFn: (() => {
          throw new Error('unused');
        }) as never,
        now: () => 1,
        options: { appendSystemPrompt: 'Open a PR when done' },
        createSession: ({ input, onChange }) => new FakeSession(input, onChange),
      });
      expect(manager.getRepoPrompt()).toBe('Open a PR when done');
      manager.setRepoPrompt('Run the tests first');
      expect(manager.getRepoPrompt()).toBe('Run the tests first');
    });

    it('fires onRepoPromptChange only when the prompt actually changes', () => {
      const onRepoPromptChange = vi.fn();
      const manager = new SessionManager({
        worktrees: fakeWorktrees(),
        queryFn: (() => {
          throw new Error('unused');
        }) as never,
        now: () => 1,
        options: { appendSystemPrompt: 'Open a PR when done' },
        onRepoPromptChange,
        createSession: ({ input, onChange }) => new FakeSession(input, onChange),
      });
      manager.setRepoPrompt('Open a PR when done'); // no-op: same value
      expect(onRepoPromptChange).not.toHaveBeenCalled();
      manager.setRepoPrompt(''); // empty clears it
      expect(onRepoPromptChange).toHaveBeenCalledWith(undefined);
      expect(manager.getRepoPrompt()).toBeUndefined();
    });

    it('applies the repo prompt to sessions created afterward', async () => {
      const prompts: (string | undefined)[] = [];
      const manager = new SessionManager({
        worktrees: fakeWorktrees(),
        // Real Session path (no createSession factory) so options reach the query.
        queryFn: ((params: { options: { systemPrompt?: string } }) => {
          prompts.push(params.options.systemPrompt);
          return (async function* () {})();
        }) as never,
        now: () => 1,
      });
      manager.create('first');
      await flush();
      manager.setRepoPrompt('Open a PR when done');
      manager.create('second');
      await flush();
      expect(prompts).toEqual([undefined, 'Open a PR when done']);
    });
  });

  describe('agent registry (/agent)', () => {
    /** 状態だけを動かすフェイク + エージェントの差し替え口（optional な 2 メソッド）。 */
    class AgentFakeSession extends FakeSession {
      current: AgentAdapter = claude;
      getAgent() {
        return this.current;
      }
      setAgent(next: AgentAdapter) {
        this.current = next;
      }
    }

    function fakeAdapter(id: AgentId, displayName: string): AgentAdapter {
      return {
        id,
        displayName,
        loginCommand: id,
        capabilities: NO_CAPABILITIES,
        open: () => ({
          async *[Symbol.asyncIterator]() {
            // 状態遷移のテストなのでイベントは流さない。
          },
        }),
      };
    }

    const claude = fakeAdapter('claude', 'Claude');
    const codex = fakeAdapter('codex', 'Codex');

    function managerWithAgents() {
      return new SessionManager({
        worktrees: fakeWorktrees(),
        agents: { claude, codex },
        agent: claude,
        now: () => 1,
        createSession: ({ input, onChange }) => new AgentFakeSession(input, onChange),
      });
    }

    it('lists the registered adapters as /agent choices', () => {
      expect(managerWithAgents().listAgents()).toEqual([claude, codex]);
    });

    it('falls back to the single default adapter when no registry is wired', () => {
      const manager = new SessionManager({
        worktrees: fakeWorktrees(),
        agent: claude,
        now: () => 1,
        createSession: ({ input, onChange }) => new FakeSession(input, onChange),
      });
      expect(manager.listAgents()).toEqual([claude]);
    });

    it('switches a session to another registered agent', async () => {
      const manager = managerWithAgents();
      const id = manager.create('do the thing');
      await flush();
      expect(manager.getSessionAgent(id)).toBe(claude);
      expect(manager.setSessionAgent(id, 'codex')).toBe(true);
      expect(manager.getSessionAgent(id)).toBe(codex);
    });

    it('is a no-op when the session already runs on that agent', async () => {
      const manager = managerWithAgents();
      const id = manager.create('do the thing');
      await flush();
      expect(manager.setSessionAgent(id, 'claude')).toBe(false);
    });

    it('refuses an agent that has no registered adapter', async () => {
      const manager = managerWithAgents();
      const id = manager.create('do the thing');
      await flush();
      // `grok` は型にはあるがアダプタ未登録 — UI へは出ないし切り替わらない。
      expect(manager.setSessionAgent(id, 'grok')).toBe(false);
      expect(manager.getSessionAgent(id)).toBe(claude);
    });

    it('returns false for an unknown session id', () => {
      expect(managerWithAgents().setSessionAgent('nope', 'codex')).toBe(false);
    });
  });

  describe('default agent (list /agent + auto-pick)', () => {
    function fakeAdapter(
      id: AgentId,
      availability?: AgentAvailability,
    ): AgentAdapter & { checks: number } {
      const adapter = {
        id,
        displayName: id,
        loginCommand: id,
        capabilities: NO_CAPABILITIES,
        checks: 0,
        open: () => ({
          async *[Symbol.asyncIterator]() {
            // フェイクはイベントを流さない（状態遷移の配線だけを見る）。
          },
        }),
        checkAvailability: availability
          ? async () => {
              adapter.checks += 1;
              return availability;
            }
          : undefined,
      };
      return adapter;
    }

    const YES: AgentAvailability = { installed: true, loggedIn: true };
    const MISSING: AgentAvailability = { installed: false, loggedIn: false };

    it('clears a provider-specific model when the default agent changes', () => {
      const onModelChange = vi.fn();
      const manager = new SessionManager({
        worktrees: fakeWorktrees(),
        agents: { claude: fakeAdapter('claude'), codex: fakeAdapter('codex') },
        agent: fakeAdapter('claude'),
        options: { model: 'claude-opus-4-8' },
        onModelChange,
        now: () => 1,
      });

      expect(manager.setDefaultAgent('codex')).toBe(true);
      expect(manager.getModel()).toBeUndefined();
      expect(onModelChange).toHaveBeenCalledWith(undefined);
    });

    function managerWith(
      agents: Partial<Record<AgentId, AgentAdapter>>,
      extra: {
        defaultAgentId?: AgentId;
        onDefaultAgentChange?: (agent: AgentId) => void;
      } = {},
    ) {
      // 新規セッションがどのアダプタで作られたかを記録するフェイク。
      const created: { id: AgentId }[] = [];
      const manager = new SessionManager({
        worktrees: fakeWorktrees(),
        agents,
        agent: agents.claude ?? Object.values(agents)[0],
        now: () => 1,
        createSession: ({ input, onChange, restored }) => {
          const s = new FakeSession(input, onChange, restored);
          // 記録は defaultAgentId 経由の解決結果を反映する（buildSession の分岐）。
          created.push({ id: manager.getDefaultAgentId() ?? 'claude' });
          return s;
        },
        ...extra,
      });
      return { manager, created };
    }

    it('reports the configured default agent id', () => {
      const { manager } = managerWith(
        { claude: fakeAdapter('claude'), codex: fakeAdapter('codex') },
        { defaultAgentId: 'codex' },
      );
      expect(manager.getDefaultAgentId()).toBe('codex');
    });

    it('persists a new default via onDefaultAgentChange and applies it to new sessions', () => {
      const onDefaultAgentChange = vi.fn();
      const { manager } = managerWith(
        { claude: fakeAdapter('claude'), codex: fakeAdapter('codex') },
        { onDefaultAgentChange },
      );
      expect(manager.setDefaultAgent('codex')).toBe(true);
      expect(onDefaultAgentChange).toHaveBeenCalledWith('codex');
      expect(manager.getDefaultAgentId()).toBe('codex');
    });

    it('does not persist an auto-pick (persist: false)', () => {
      const onDefaultAgentChange = vi.fn();
      const { manager } = managerWith(
        { claude: fakeAdapter('claude'), codex: fakeAdapter('codex') },
        { onDefaultAgentChange },
      );
      expect(manager.setDefaultAgent('codex', { persist: false })).toBe(true);
      expect(onDefaultAgentChange).not.toHaveBeenCalled();
      expect(manager.getDefaultAgentId()).toBe('codex');
    });

    it('refuses an unregistered agent and a no-op change', () => {
      const { manager } = managerWith({ claude: fakeAdapter('claude') });
      expect(manager.setDefaultAgent('codex')).toBe(false); // 未登録
      expect(manager.setDefaultAgent('claude')).toBe(false); // 既に既定
    });

    it('detects availability once and caches it (concurrent calls share one probe)', async () => {
      const claude = fakeAdapter('claude', YES);
      const codex = fakeAdapter('codex', MISSING);
      const { manager } = managerWith({ claude, codex });
      const [a, b] = await Promise.all([manager.checkAgents(), manager.checkAgents()]);
      expect(a).toBe(b); // 同じ probe にまとまる
      expect(claude.checks).toBe(1);
      expect(codex.checks).toBe(1);
      expect(manager.getAgentAvailability().get('claude')).toEqual(YES);
      expect(manager.getAgentAvailability().get('codex')).toEqual(MISSING);
    });

    it('treats an adapter without checkAvailability as installed/unknown', async () => {
      const { manager } = managerWith({ claude: fakeAdapter('claude') });
      await manager.checkAgents();
      expect(manager.getAgentAvailability().get('claude')).toEqual({
        installed: true,
        loggedIn: 'unknown',
      });
    });

    it('re-probes on refreshAgents (invalidates the cache)', async () => {
      const claude = fakeAdapter('claude', YES);
      const { manager } = managerWith({ claude });
      await manager.checkAgents();
      await manager.checkAgents(); // cached → no new probe
      expect(claude.checks).toBe(1);
      await manager.refreshAgents(); // force
      expect(claude.checks).toBe(2);
    });

    it('exposes login capability and starts a login process', () => {
      let started = 0;
      const loginProc = {
        async *[Symbol.asyncIterator]() {
          // フェイクは行を流さない（capability と startLogin の配線だけを見る）。
        },
        cancel: () => {},
        result: () => ({ code: 0 }),
      };
      const claude: AgentAdapter = {
        ...fakeAdapter('claude'),
        login: () => {
          started += 1;
          return loginProc;
        },
      };
      const codex = fakeAdapter('codex'); // login 未対応
      const { manager } = managerWith({ claude, codex });

      expect(manager.canLogin('claude')).toBe(true);
      expect(manager.canLogin('codex')).toBe(false);
      expect(manager.canLogin('grok')).toBe(false); // 未登録
      expect(manager.startLogin('claude')).toBe(loginProc);
      expect(started).toBe(1);
      expect(manager.startLogin('codex')).toBeUndefined();
    });
  });
});
