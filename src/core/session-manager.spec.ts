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
  constructor(
    input: CreateSessionInput,
    private readonly onChange: (s: SessionState) => void,
  ) {
    this.state = initialState(input);
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
  archive() {
    this.calls.push('archive');
    this.state = { ...this.state, status: 'archived' };
    this.onChange(this.state);
  }
  drive(status: SessionState['status']) {
    this.state = { ...this.state, status };
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
    createSession: ({ input, onChange }) => {
      const s = new FakeSession(input, onChange);
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

  it('dispose() aborts every session', async () => {
    const { manager, created } = makeManager();
    manager.create('a');
    manager.create('b');
    await flush();
    manager.dispose();
    expect(created.every((s) => s.aborted)).toBe(true);
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
