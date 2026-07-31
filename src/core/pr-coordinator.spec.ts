import { describe, expect, it, vi } from 'vitest';
import { PR_LOOKUP_BACKOFF_MS, PrCoordinator, type PrCoordinatorDeps } from './pr-coordinator';
import type { PrAutomation, SessionHandle, WorktreeMeta, WorktreeService } from './session-ports';
import { initialState } from './status-reducer';
import type { PrInfo, PrLookupResult, PrLookupState, SessionState } from './types';

const worktrees: WorktreeService = {
  baseBranch: async () => 'main',
  takenSlugs: async () => new Set<string>(),
  add: async (slug) => ({ slug, branch: `codiva/${slug}`, path: `/wt/${slug}` }),
  syncedStartPoint: async () => undefined,
  pushBranch: async () => {},
  diffStat: async () => ({ committed: '', uncommitted: [] }),
  merge: async () => {},
  remove: async () => {},
};

/** Minimal SessionHandle recording only what the coordinator drives. */
function fakeSession(state: SessionState) {
  const calls: string[] = [];
  const handle: SessionHandle = {
    getState: () => state,
    start() {},
    send() {},
    answerPending() {},
    allowPending() {},
    denyPending() {},
    async interrupt() {},
    setModel() {},
    abort() {},
    stop() {},
    archive() {},
    setPr(pr: PrInfo | undefined) {
      calls.push(`setPr:${pr ? `#${pr.number}${pr.isDraft ? ':draft' : ''}` : 'none'}`);
      state = { ...state, pr, prLookup: undefined };
    },
    setPrLookup(lookup: PrLookupState | undefined) {
      calls.push(`prLookup:${lookup ?? 'none'}`);
      state = { ...state, prLookup: lookup };
    },
    markConflict() {},
  };
  return { handle, calls, current: () => state };
}

interface Harness {
  refresh: () => Promise<void>;
  calls: string[];
  state: () => SessionState;
  now: { value: number };
}

function harness(
  lookup: (cwd: string, branch: string) => Promise<PrLookupResult>,
  over: {
    state?: Partial<SessionState>;
    autoPr?: boolean;
    prAutomation?: PrAutomation;
  } = {},
): Harness {
  const base: SessionState = {
    ...initialState({
      id: 's1',
      title: 't',
      prompt: 'p',
      branch: 'codiva/feature',
      worktreePath: '/wt/feature',
      startedAt: 0,
    }),
    status: 'completed',
    ...over.state,
  };
  const session = fakeSession(base);
  const meta: WorktreeMeta = {
    worktree: { slug: 'feature', branch: 'codiva/feature', path: '/wt/feature' },
    base: 'main',
  };
  const now = { value: 0 };
  const deps: PrCoordinatorDeps = {
    worktrees,
    lookupPr: lookup,
    autoPr: over.autoPr,
    prAutomation: over.prAutomation,
    getMeta: () => meta,
    getState: () => session.current(),
    getSession: () => session.handle,
    ids: () => ['s1'],
    now: () => now.value,
  };
  const coordinator = new PrCoordinator(deps);
  return {
    refresh: () => coordinator.refreshPrs(),
    calls: session.calls,
    state: session.current,
    now,
  };
}

const found = (pr: PrInfo): PrLookupResult => ({ kind: 'found', pr });
const PR: PrInfo = { number: 42, url: 'u', mergeStatus: 'mergeable', checks: 'passing' };

describe('PrCoordinator.refreshPrs', () => {
  it('marks the cell loading before the first lookup, then stores the PR', async () => {
    const h = harness(async () => found(PR));
    await h.refresh();
    expect(h.calls).toEqual(['prLookup:loading', 'setPr:#42']);
    expect(h.state().pr).toEqual(PR);
    expect(h.state().prLookup).toBeUndefined();
  });

  it('records `absent` as "no PR" (clearing a stale badge)', async () => {
    const h = harness(async () => ({ kind: 'absent' }), { state: { pr: PR } });
    await h.refresh();
    // A PR was already known, so no loading mark — and `absent` is authoritative.
    expect(h.calls).toEqual(['setPr:none']);
    expect(h.state().pr).toBeUndefined();
  });

  // The regression this class exists to prevent: a rate-limited / offline `gh` must
  // not read as "this branch has no PR", or the #<n> badge blinks out of the list.
  it('keeps the last known PR when the lookup is unavailable, and flags the cell', async () => {
    const h = harness(async () => ({ kind: 'unavailable', reason: 'rate_limit' }), {
      state: { pr: PR },
    });
    await h.refresh();
    expect(h.calls).toEqual(['prLookup:error']);
    expect(h.state().pr).toEqual(PR);
    expect(h.state().prLookup).toBe('error');
  });

  it('flags the cell when the lookup port rejects instead of classifying', async () => {
    const h = harness(async () => {
      throw new Error('boom');
    });
    await h.refresh();
    expect(h.calls).toEqual(['prLookup:loading', 'prLookup:error']);
    expect(h.state().prLookup).toBe('error');
  });

  it('stays quiet when `gh` is not installed (the feature is simply unavailable)', async () => {
    const h = harness(async () => ({ kind: 'unavailable', reason: 'cli' }));
    await h.refresh();
    expect(h.calls).toEqual(['prLookup:loading', 'prLookup:none']);
    expect(h.state().prLookup).toBeUndefined();
  });

  // "answered: no PR" and "never asked" are both `pr: undefined, prLookup: undefined`,
  // so a naive check re-marks loading every tick and the cell blinks ⋯ → empty.
  it('marks loading only once for a branch that has no PR (no 20s flicker)', async () => {
    const h = harness(async () => ({ kind: 'absent' }));
    await h.refresh();
    await h.refresh();
    await h.refresh();
    expect(h.calls.filter((c) => c === 'prLookup:loading')).toHaveLength(1);
    expect(h.state().prLookup).toBeUndefined();
  });

  it('does not re-mark loading after an error (no flicker between the two marks)', async () => {
    let result: PrLookupResult = { kind: 'unavailable', reason: 'network' };
    const h = harness(async () => result);
    await h.refresh();
    await h.refresh();
    expect(h.calls).toEqual(['prLookup:loading', 'prLookup:error', 'prLookup:error']);
    // A later success clears the error mark via setPr.
    result = found(PR);
    await h.refresh();
    expect(h.state().prLookup).toBeUndefined();
    expect(h.state().pr).toEqual(PR);
  });

  it('backs off polling after a rate-limit failure, then resumes', async () => {
    const lookup = vi.fn(
      async (): Promise<PrLookupResult> => ({ kind: 'unavailable', reason: 'rate_limit' }),
    );
    const h = harness(lookup);
    await h.refresh();
    expect(lookup).toHaveBeenCalledTimes(1);

    // Inside the backoff window the poll is skipped entirely (no API spend).
    h.now.value = PR_LOOKUP_BACKOFF_MS - 1;
    await h.refresh();
    expect(lookup).toHaveBeenCalledTimes(1);

    h.now.value = PR_LOOKUP_BACKOFF_MS;
    await h.refresh();
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it('does not back off for transient failures', async () => {
    const lookup = vi.fn(
      async (): Promise<PrLookupResult> => ({ kind: 'unavailable', reason: 'network' }),
    );
    const h = harness(lookup);
    await h.refresh();
    await h.refresh();
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it('never runs two cycles at once (a slow `gh` outliving the 20s timer)', async () => {
    let release = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const lookup = vi.fn(async (): Promise<PrLookupResult> => {
      await gate;
      return found(PR);
    });
    const h = harness(lookup);
    const first = h.refresh();
    await h.refresh(); // fires while the first is still in flight → skipped
    expect(lookup).toHaveBeenCalledTimes(1);
    release();
    await first;
    await h.refresh();
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it('stops polling a merged PR (its state is final)', async () => {
    const lookup = vi.fn(async () => found({ ...PR, mergeStatus: 'merged' as const }));
    const h = harness(lookup);
    await h.refresh();
    await h.refresh();
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it('skips archived sessions entirely', async () => {
    const lookup = vi.fn(async () => found(PR));
    const h = harness(lookup, { state: { status: 'archived' } });
    await h.refresh();
    expect(lookup).not.toHaveBeenCalled();
  });

  it('readies a draft PR from the checks that came with the lookup (no extra call)', async () => {
    const markReady = vi.fn(async () => {});
    const h = harness(async () => found({ ...PR, isDraft: true, checks: 'passing' }), {
      autoPr: true,
      prAutomation: { createPr: async () => undefined, markReady },
    });
    await h.refresh();
    expect(markReady).toHaveBeenCalledWith('/wt/feature', 'codiva/feature');
    expect(h.state().pr?.isDraft).toBe(false);
  });

  it.each(['pending', 'failing', 'none'] as const)(
    'leaves a draft PR alone while checks are %s',
    async (checks) => {
      const markReady = vi.fn(async () => {});
      const h = harness(async () => found({ ...PR, isDraft: true, checks }), {
        autoPr: true,
        prAutomation: { createPr: async () => undefined, markReady },
      });
      await h.refresh();
      expect(markReady).not.toHaveBeenCalled();
      expect(h.state().pr?.isDraft).toBe(true);
    },
  );

  it('keeps the PR when readying fails', async () => {
    const h = harness(async () => found({ ...PR, isDraft: true, checks: 'passing' }), {
      autoPr: true,
      prAutomation: {
        createPr: async () => undefined,
        markReady: async () => {
          throw new Error('gh pr ready failed');
        },
      },
    });
    await expect(h.refresh()).resolves.toBeUndefined();
    expect(h.state().pr?.isDraft).toBe(true);
  });

  it('is a no-op without a lookup port', async () => {
    const session = fakeSession(
      initialState({
        id: 's1',
        title: 't',
        prompt: 'p',
        branch: 'codiva/feature',
        worktreePath: '/wt/feature',
        startedAt: 0,
      }),
    );
    const coordinator = new PrCoordinator({
      worktrees,
      getMeta: () => ({
        worktree: { slug: 'feature', branch: 'codiva/feature', path: '/wt/feature' },
        base: 'main',
      }),
      getState: () => session.current(),
      getSession: () => session.handle,
      ids: () => ['s1'],
    });
    await expect(coordinator.refreshPrs()).resolves.toBeUndefined();
    expect(session.calls).toEqual([]);
  });
});
