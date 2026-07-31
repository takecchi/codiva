import { describe, expect, it, vi } from 'vitest';
import { PR_LOOKUP_BACKOFF_MS, PrCoordinator, type PrCoordinatorDeps } from './pr-coordinator';
import { PR_BATCH_MIN_SESSIONS, PR_POLL_SOON_MS, PR_POLL_STABLE_MS } from './pr-refresh';
import type {
  PrAutomation,
  PrLookupTarget,
  SessionHandle,
  WorktreeMeta,
  WorktreeService,
} from './session-ports';
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
      // Split like the real reducer: stable ref vs volatile status.
      state = {
        ...state,
        pr: pr ? { number: pr.number, url: pr.url } : undefined,
        prStatus: pr
          ? { mergeStatus: pr.mergeStatus, isDraft: pr.isDraft, checks: pr.checks }
          : undefined,
        prLookup: undefined,
      };
    },
    setPrLookup(lookup: PrLookupState | undefined) {
      calls.push(`prLookup:${lookup ?? 'none'}`);
      state = { ...state, prLookup: lookup };
    },
    markConflict() {},
  };
  return { handle, calls, current: () => state };
}

function stateFor(id: string, over: Partial<SessionState> = {}): SessionState {
  return {
    ...initialState({
      id,
      title: 't',
      prompt: 'p',
      branch: `codiva/${id}`,
      worktreePath: `/wt/${id}`,
      startedAt: 0,
    }),
    status: 'completed',
    ...over,
  };
}

interface Harness {
  refresh: () => Promise<void>;
  /** Advance the injected clock (staleness + backoff are time-driven). */
  tick: (ms: number) => void;
  calls: (id?: string) => string[];
  state: (id?: string) => SessionState;
}

/**
 * Build a coordinator over `ids` sessions. Every session gets the same lookup
 * result unless the fake decides per-branch.
 */
function harness(
  lookup: (cwd: string, branch: string) => Promise<PrLookupResult>,
  over: {
    ids?: string[];
    state?: Partial<SessionState>;
    autoPr?: boolean;
    prAutomation?: PrAutomation;
    lookupPrs?: PrCoordinatorDeps['lookupPrs'];
  } = {},
): Harness {
  const ids = over.ids ?? ['s1'];
  const sessions = new Map<string, ReturnType<typeof fakeSession>>();
  const metas = new Map<string, WorktreeMeta>();
  for (const id of ids) {
    sessions.set(id, fakeSession(stateFor(id, over.state)));
    metas.set(id, {
      worktree: { slug: id, branch: `codiva/${id}`, path: `/wt/${id}` },
      base: 'main',
    });
  }
  const now = { value: 0 };
  const deps: PrCoordinatorDeps = {
    worktrees,
    lookupPr: lookup,
    lookupPrs: over.lookupPrs,
    autoPr: over.autoPr,
    prAutomation: over.prAutomation,
    getMeta: (id) => metas.get(id),
    getState: (id) => sessions.get(id)?.current(),
    getSession: (id) => sessions.get(id)?.handle,
    ids: () => ids,
    now: () => now.value,
  };
  const coordinator = new PrCoordinator(deps);
  const pick = (id?: string) => {
    const session = sessions.get(id ?? ids[0] ?? '');
    if (!session) {
      throw new Error(`no session ${id}`);
    }
    return session;
  };
  return {
    refresh: () => coordinator.refreshPrs(),
    tick: (ms) => {
      now.value += ms;
    },
    calls: (id) => pick(id).calls,
    state: (id) => pick(id).current(),
  };
}

const found = (pr: PrInfo): PrLookupResult => ({ kind: 'found', pr });
const PR: PrInfo = { number: 42, url: 'u', mergeStatus: 'mergeable', checks: 'passing' };
/** Long enough for any freshness window to expire. */
const STALE = PR_POLL_STABLE_MS;

describe('PrCoordinator.refreshPrs', () => {
  it('marks the cell loading before the first lookup, then stores the PR', async () => {
    const h = harness(async () => found(PR));
    await h.refresh();
    expect(h.calls()).toEqual(['prLookup:loading', 'setPr:#42']);
    expect(h.state().pr).toEqual({ number: 42, url: 'u' });
    expect(h.state().prLookup).toBeUndefined();
  });

  it('records `absent` as "no PR" (clearing a stale badge)', async () => {
    const h = harness(async () => ({ kind: 'absent' }), {
      state: {
        pr: { number: 42, url: 'u' },
        prStatus: { mergeStatus: 'mergeable', checks: 'passing' },
      },
    });
    await h.refresh();
    // A PR was already known, so no loading mark — and `absent` is authoritative.
    expect(h.calls()).toEqual(['setPr:none']);
    expect(h.state().pr).toBeUndefined();
  });

  // The regression this class exists to prevent: a rate-limited / offline `gh` must
  // not read as "this branch has no PR", or the #<n> badge blinks out of the list.
  it('keeps the last known PR when the lookup is unavailable, and flags the cell', async () => {
    const h = harness(async () => ({ kind: 'unavailable', reason: 'rate_limit' }), {
      state: {
        pr: { number: 42, url: 'u' },
        prStatus: { mergeStatus: 'mergeable', checks: 'passing' },
      },
    });
    await h.refresh();
    expect(h.calls()).toEqual(['prLookup:error']);
    expect(h.state().pr).toEqual({ number: 42, url: 'u' });
    expect(h.state().prLookup).toBe('error');
  });

  it('flags the cell when the lookup port rejects instead of classifying', async () => {
    const h = harness(async () => {
      throw new Error('boom');
    });
    await h.refresh();
    expect(h.calls()).toEqual(['prLookup:loading', 'prLookup:error']);
    expect(h.state().prLookup).toBe('error');
  });

  it('stays quiet when `gh` is not installed (the feature is simply unavailable)', async () => {
    const h = harness(async () => ({ kind: 'unavailable', reason: 'cli' }));
    await h.refresh();
    expect(h.calls()).toEqual(['prLookup:loading', 'prLookup:none']);
    expect(h.state().prLookup).toBeUndefined();
  });

  it('does not re-mark loading after an error (no flicker between the two marks)', async () => {
    let result: PrLookupResult = { kind: 'unavailable', reason: 'network' };
    const h = harness(async () => result);
    await h.refresh();
    await h.refresh(); // a failure isn't cached, so this really retries
    expect(h.calls()).toEqual(['prLookup:loading', 'prLookup:error', 'prLookup:error']);
    // A later success clears the error mark via setPr.
    result = found(PR);
    await h.refresh();
    expect(h.state().prLookup).toBeUndefined();
    expect(h.state().pr).toEqual({ number: 42, url: 'u' });
  });

  // "answered: no PR" and "never asked" are both `pr: undefined, prLookup: undefined`,
  // so a naive check re-marks loading every tick and the cell blinks ⋯ → empty.
  it('marks loading only once for a branch that has no PR (no flicker)', async () => {
    const h = harness(async () => ({ kind: 'absent' }));
    await h.refresh();
    h.tick(STALE);
    await h.refresh();
    h.tick(STALE);
    await h.refresh();
    expect(h.calls().filter((c) => c === 'prLookup:loading')).toHaveLength(1);
    expect(h.state().prLookup).toBeUndefined();
  });

  it('backs off polling after a rate-limit failure, then resumes', async () => {
    const lookup = vi.fn(
      async (): Promise<PrLookupResult> => ({ kind: 'unavailable', reason: 'rate_limit' }),
    );
    const h = harness(lookup);
    await h.refresh();
    expect(lookup).toHaveBeenCalledTimes(1);

    // Inside the backoff window the poll is skipped entirely (no API spend).
    h.tick(PR_LOOKUP_BACKOFF_MS - 1);
    await h.refresh();
    expect(lookup).toHaveBeenCalledTimes(1);

    h.tick(1);
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

  it('never runs two cycles at once (a slow `gh` outliving the poll tick)', async () => {
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
    h.tick(STALE);
    await h.refresh();
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it('stops polling a merged PR (its state is final)', async () => {
    const lookup = vi.fn(async () => found({ ...PR, mergeStatus: 'merged' as const }));
    const h = harness(lookup);
    await h.refresh();
    h.tick(STALE * 10);
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
    expect(markReady).toHaveBeenCalledWith('/wt/s1', 'codiva/s1');
    expect(h.state().prStatus?.isDraft).toBe(false);
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
      expect(h.state().prStatus?.isDraft).toBe(true);
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
    expect(h.state().prStatus?.isDraft).toBe(true);
  });

  it('is a no-op without a lookup port', async () => {
    const session = fakeSession(stateFor('s1'));
    const coordinator = new PrCoordinator({
      worktrees,
      getMeta: () => ({
        worktree: { slug: 's1', branch: 'codiva/s1', path: '/wt/s1' },
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

// The polling tick is just a scheduler: what it actually costs per cycle is decided
// by per-session staleness, so a screen full of settled PRs is nearly free.
describe('PrCoordinator caching (staleness-driven polling)', () => {
  it('reuses the cached PR until its freshness window expires', async () => {
    const lookup = vi.fn(async () => found(PR)); // mergeable + passing → stable
    const h = harness(lookup);
    await h.refresh();
    expect(lookup).toHaveBeenCalledTimes(1);

    // Several ticks later it's still fresh: no `gh`, no state churn.
    h.tick(PR_POLL_STABLE_MS - 1);
    await h.refresh();
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(h.calls()).toEqual(['prLookup:loading', 'setPr:#42']);

    h.tick(1);
    await h.refresh();
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it('re-polls a PR with running checks much sooner than a settled one', async () => {
    const lookup = vi.fn(async () => found({ ...PR, checks: 'pending' as const }));
    const h = harness(lookup);
    await h.refresh();
    h.tick(PR_POLL_SOON_MS); // < stable window, > fast window
    await h.refresh();
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it('a failed lookup is not cached (retries on the next tick)', async () => {
    const lookup = vi.fn(
      async (): Promise<PrLookupResult> => ({ kind: 'unavailable', reason: 'unknown' }),
    );
    const h = harness(lookup);
    await h.refresh();
    await h.refresh();
    expect(lookup).toHaveBeenCalledTimes(2);
  });
});

describe('PrCoordinator batching (one `gh pr list` for many sessions)', () => {
  const ids = Array.from({ length: PR_BATCH_MIN_SESSIONS }, (_, i) => `s${i + 1}`);

  function batchHarness(
    results: (targets: readonly PrLookupTarget[]) => Map<string, PrLookupResult>,
    over: { ids?: string[]; state?: Partial<SessionState> } = {},
  ) {
    const seen: PrLookupTarget[][] = [];
    const lookupPrs = vi.fn(async (targets: readonly PrLookupTarget[]) => {
      seen.push([...targets]);
      return results(targets);
    });
    const lookupPr = vi.fn(async () => found(PR));
    const h = harness(lookupPr, { ids: over.ids ?? ids, state: over.state, lookupPrs });
    return { ...h, lookupPr, lookupPrs, seen };
  }

  it('resolves every due session with one batched call instead of N', async () => {
    const b = batchHarness(
      (targets) => new Map(targets.map((t, i) => [t.id, found({ ...PR, number: 10 + i })])),
    );
    await b.refresh();
    expect(b.lookupPrs).toHaveBeenCalledTimes(1);
    expect(b.lookupPr).not.toHaveBeenCalled();
    expect(b.state('s1').pr?.number).toBe(10);
    expect(b.state(ids[ids.length - 1]).pr?.number).toBe(10 + ids.length - 1);
  });

  it('passes each session its worktree, branch and already-known PR number', async () => {
    const b = batchHarness((targets) => new Map(targets.map((t) => [t.id, { kind: 'absent' }])), {
      state: {
        pr: { number: 42, url: 'u' },
        prStatus: { mergeStatus: 'mergeable', checks: 'passing' },
      },
    });
    await b.refresh();
    expect(b.seen[0]).toEqual(
      ids.map((id) => ({ id, cwd: `/wt/${id}`, branch: `codiva/${id}`, knownPr: 42 })),
    );
  });

  it('omits knownPr for sessions with no PR yet', async () => {
    const b = batchHarness((targets) => new Map(targets.map((t) => [t.id, { kind: 'absent' }])));
    await b.refresh();
    expect(b.seen[0]?.[0]).toEqual({ id: 's1', cwd: '/wt/s1', branch: 'codiva/s1' });
  });

  it('falls back to per-session lookups below the threshold', async () => {
    const b = batchHarness(() => new Map(), { ids: ['only'] });
    await b.refresh();
    expect(b.lookupPrs).not.toHaveBeenCalled();
    expect(b.lookupPr).toHaveBeenCalledTimes(1);
    expect(b.state('only').pr).toEqual({ number: 42, url: 'u' });
  });

  it('treats a session the batch did not answer as unknown, not as "no PR"', async () => {
    const b = batchHarness(
      (targets) => {
        const map = new Map<string, PrLookupResult>();
        for (const t of targets.slice(1)) {
          map.set(t.id, { kind: 'absent' });
        }
        return map; // s1 missing from the response
      },
      {
        state: {
          pr: { number: 42, url: 'u' },
          prStatus: { mergeStatus: 'mergeable', checks: 'passing' },
        },
      },
    );
    await b.refresh();
    expect(b.state('s1').pr).toEqual({ number: 42, url: 'u' }); // kept
    expect(b.state('s1').prLookup).toBe('error');
    expect(b.state('s2').pr).toBeUndefined();
  });

  it('keeps every PR and flags the rows when the batch rejects', async () => {
    const lookupPrs = vi.fn(async () => {
      throw new Error('gh exploded');
    });
    const h = harness(async () => found(PR), {
      ids,
      state: {
        pr: { number: 42, url: 'u' },
        prStatus: { mergeStatus: 'mergeable', checks: 'passing' },
      },
      lookupPrs,
    });
    await h.refresh();
    for (const id of ids) {
      expect(h.state(id).pr).toEqual({ number: 42, url: 'u' });
      expect(h.state(id).prLookup).toBe('error');
    }
  });

  it('backs off when the batch reports a rate limit', async () => {
    const b = batchHarness(
      (targets) =>
        new Map(targets.map((t) => [t.id, { kind: 'unavailable', reason: 'rate_limit' }])),
    );
    await b.refresh();
    expect(b.lookupPrs).toHaveBeenCalledTimes(1);
    b.tick(PR_LOOKUP_BACKOFF_MS - 1);
    await b.refresh();
    expect(b.lookupPrs).toHaveBeenCalledTimes(1);
  });

  it('only sends the stale sessions to the batch', async () => {
    const b = batchHarness(
      (targets) => new Map(targets.map((t) => [t.id, found({ ...PR, checks: 'passing' })])),
    );
    await b.refresh();
    // Everything is fresh now → the next tick has nothing to ask about at all.
    b.tick(1000);
    await b.refresh();
    expect(b.lookupPrs).toHaveBeenCalledTimes(1);
  });
});
