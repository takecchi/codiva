import { describe, expect, it, vi } from 'vitest';
import { type SessionHandle, SessionManager, type WorktreeService } from '@/core/session-manager';
import { initialState } from '@/core/status-reducer';
import type { CreateSessionInput, SessionState } from '@/core/types';

function fakeWorktrees(overrides: Partial<WorktreeService> = {}): WorktreeService {
  return {
    baseBranch: async () => 'main',
    takenSlugs: async () => new Set<string>(),
    add: async (slug) => ({ slug, branch: `codiva/${slug}`, path: `/tmp/wt/${slug}` }),
    diffStat: async () => ({ committed: '', uncommitted: [] }),
    merge: async () => {},
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
  ) {
    this.state = restored ?? initialState(input);
  }
  calls: string[] = [];
  getState() {
    return this.state;
  }
  start() {
    this.started = true;
  }
  send(text: string) {
    this.calls.push(`send:${text}`);
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
  abort() {
    this.aborted = true;
  }
  stop() {
    this.stopped = true;
  }
  detach() {
    this.calls.push('detach');
    this.state = { ...this.state, status: 'external' };
    this.onChange(this.state);
  }
  archive() {
    this.calls.push('archive');
    this.state = { ...this.state, status: 'archived' };
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
    createSession: ({ input, onChange, restored }) => {
      const s = new FakeSession(input, onChange, restored);
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
    await manager.interrupt(id);

    expect(created[0]?.calls).toEqual([
      'send:more',
      'answer:{"q":"yes"}',
      'allow',
      'deny:no',
      'interrupt',
    ]);
  });

  it('ignores UI actions for unknown session ids', async () => {
    const { manager } = makeManager();
    expect(() => manager.send('x', 'y')).not.toThrow();
    await expect(manager.interrupt('x')).resolves.toBeUndefined();
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
});
