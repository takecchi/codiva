import { describe, expect, it, vi } from 'vitest';
import { PR_LOOKUP_BACKOFF_MS, PrCoordinator, type PrCoordinatorDeps } from './pr-coordinator';
import { MAX_AUTO_RECOVERY_ATTEMPTS, type RecoveryKind } from './pr-recovery';
import { PR_BATCH_MIN_SESSIONS, PR_POLL_SOON_MS, PR_POLL_STABLE_MS } from './pr-refresh';
import type {
  PrAutomation,
  PrLookup,
  PrLookupTarget,
  SessionHandle,
  WorktreeMeta,
  WorktreeService,
} from './session-ports';
import { initialState } from './status-reducer';
import type { PrInfo, PrLookupResult, PrLookupState, PrRef, SessionState } from './types';

const worktrees: WorktreeService = {
  baseBranch: async () => 'main',
  takenSlugs: async () => new Set<string>(),
  add: async (slug) => ({ slug, branch: `codiva/${slug}`, path: `/wt/${slug}` }),
  syncedStartPoint: async () => undefined,
  pushBranch: async () => {},
  diffStat: async () => ({ committed: '', uncommitted: [] }),
  merge: async () => {},
  syncBase: async () => ({ kind: 'upToDate' }),
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
    dropPr(ref: PrRef) {
      calls.push(`dropPr:#${ref.number}`);
      // Mirror the reducer: the ref can live in either half.
      const extraPrs = state.extraPrs?.filter((p) => p.url !== ref.url);
      state = {
        ...state,
        extraPrs: extraPrs && extraPrs.length > 0 ? extraPrs : undefined,
        ...(state.pr?.url === ref.url ? { pr: undefined, prStatus: undefined } : {}),
      };
    },
    setPrLookup(lookup: PrLookupState | undefined) {
      calls.push(`prLookup:${lookup ?? 'none'}`);
      state = { ...state, prLookup: lookup };
    },
    markConflict() {},
  };
  return {
    handle,
    calls,
    current: () => state,
    /** Move the session's lifecycle status (recovery only fires on idle rows). */
    drive(status: SessionState['status']) {
      state = { ...state, status };
    },
  };
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
  /** Move a session's lifecycle status (auto-recovery only fires on idle rows). */
  drive: (status: SessionState['status'], id?: string) => void;
  /** `<id>:<kind>` for every auto-recovery the coordinator triggered, in order. */
  recoveries: string[];
}

/**
 * Build a coordinator over `ids` sessions. Every session gets the same lookup
 * result unless the fake decides per-branch.
 */
function harness(
  lookup: PrLookup,
  over: {
    ids?: string[];
    state?: Partial<SessionState>;
    autoPr?: boolean;
    prAutomation?: PrAutomation;
    lookupPrs?: PrCoordinatorDeps['lookupPrs'];
    autoSync?: boolean;
    autoFixCi?: boolean;
    /** Extra behaviour to run when a recovery fires (e.g. flip the row to running). */
    onRecover?: (id: string, kind: RecoveryKind) => void;
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
  const recoveries: string[] = [];
  const deps: PrCoordinatorDeps = {
    worktrees,
    lookupPr: lookup,
    lookupPrs: over.lookupPrs,
    autoPr: over.autoPr,
    prAutomation: over.prAutomation,
    autoSync: over.autoSync,
    autoFixCi: over.autoFixCi,
    recover: async (id, kind) => {
      recoveries.push(`${id}:${kind}`);
      over.onRecover?.(id, kind);
      return { kind: 'delegated', recovery: kind };
    },
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
    drive: (status, id) => pick(id).drive(status),
    recoveries,
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

  // A PR the session opened itself (`gh pr create` on its own branch) is only reachable
  // through its own ref: nothing in the worktree points at its head branch. Without it
  // the lookup answered `absent` forever, so the row showed a bare `#<n>` with no state
  // — and, having been "answered", not even a loading mark.
  it('asks about a PR the session opened itself, and adopts it as the tracked PR', async () => {
    const own = { number: 109, url: 'https://github.com/o/r/pull/109' };
    const lookup = vi.fn<PrLookup>(async (_cwd, _branch, opts) =>
      opts?.knownPr?.url === own.url
        ? found({ ...own, mergeStatus: 'merged', checks: 'none' })
        : { kind: 'absent' },
    );
    const h = harness(lookup, { state: { extraPrs: [own] } });
    await h.refresh();
    // The whole ref, URL included — the PR may not even be in this repository.
    expect(lookup).toHaveBeenCalledWith('/wt/s1', 'codiva/s1', { knownPr: own });
    expect(h.state().pr).toEqual(own);
    expect(h.state().prStatus?.mergeStatus).toBe('merged');
  });

  it('keeps passing the ref once that PR is the tracked one', async () => {
    const own = { number: 109, url: 'https://github.com/o/r/pull/109' };
    const lookup = vi.fn<PrLookup>(async () => found({ ...own, mergeStatus: 'mergeable' }));
    const h = harness(lookup, { state: { pr: own } });
    await h.refresh();
    expect(lookup).toHaveBeenCalledWith('/wt/s1', 'codiva/s1', { knownPr: own });
  });

  // `absent` means every candidate answered, the known URL among them — so that PR
  // really doesn't exist (a misread `gh pr create` URL, a repo that went away). Keeping
  // the reference would strand the row on a bare `#<n>` that no poll can ever fill in:
  // `setPr(undefined)` clears `pr`, but nothing else prunes `extraPrs`.
  it('forgets a self-opened PR once its own URL comes back absent', async () => {
    const gone = { number: 109, url: 'https://github.com/o/r/pull/109' };
    const h = harness(async () => ({ kind: 'absent' }), { state: { extraPrs: [gone] } });
    await h.refresh();
    expect(h.calls()).toEqual(['prLookup:loading', 'dropPr:#109', 'setPr:none']);
    expect(h.state().extraPrs).toBeUndefined();
    expect(h.state().pr).toBeUndefined();
  });

  it('keeps a self-opened PR when the lookup only failed', async () => {
    const gone = { number: 109, url: 'https://github.com/o/r/pull/109' };
    const h = harness(async () => ({ kind: 'unavailable', reason: 'rate_limit' }), {
      state: { extraPrs: [gone] },
    });
    await h.refresh();
    expect(h.calls()).not.toContain('dropPr:#109');
    expect(h.state().extraPrs).toEqual([gone]);
  });

  it('never drops anything when there was no known PR to confirm', async () => {
    const h = harness(async () => ({ kind: 'absent' }));
    await h.refresh();
    expect(h.calls()).toEqual(['prLookup:loading', 'setPr:none']);
  });

  // Numbers are per-repo, so readying by number could flip an unrelated PR that happens
  // to share it in the session's own repo.
  it('readies the PR it resolved by URL, even in another repository', async () => {
    const cross = { number: 42, url: 'https://github.com/acme/other/pull/42' };
    const markReady = vi.fn(async () => {});
    const h = harness(
      async () => found({ ...cross, mergeStatus: 'mergeable', checks: 'passing', isDraft: true }),
      {
        autoPr: true,
        prAutomation: { createPr: async () => undefined, markReady },
        state: { extraPrs: [cross] },
      },
    );
    await h.refresh();
    expect(markReady).toHaveBeenCalledWith('/wt/s1', cross.url);
  });

  // The number alone says nothing about mergeability or CI, so the row is still
  // waiting on an answer — restored sessions start exactly here.
  it('marks the cell loading when the number is known but its status is not', async () => {
    const h = harness(async () => found(PR), { state: { pr: { number: 42, url: 'u' } } });
    await h.refresh();
    expect(h.calls()).toEqual(['prLookup:loading', 'setPr:#42']);
  });

  it('records `absent` as "no PR" (clearing a stale badge)', async () => {
    const h = harness(async () => ({ kind: 'absent' }), {
      state: {
        pr: { number: 42, url: 'u' },
        prStatus: { mergeStatus: 'mergeable', checks: 'passing' },
      },
    });
    await h.refresh();
    // A PR was already known, so no loading mark — and `absent` is authoritative: the
    // known PR was one of the answered candidates, so the reference goes too.
    expect(h.calls()).toEqual(['dropPr:#42', 'setPr:none']);
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
    // Addressed by URL: the PR need not live on the session's branch (or in its repo).
    expect(markReady).toHaveBeenCalledWith('/wt/s1', 'u');
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
      ids.map((id) => ({
        id,
        cwd: `/wt/${id}`,
        branch: `codiva/${id}`,
        knownPr: { number: 42, url: 'u' },
      })),
    );
  });

  it('passes the ref of a PR the session opened itself', async () => {
    const b = batchHarness((targets) => new Map(targets.map((t) => [t.id, { kind: 'absent' }])), {
      state: {
        extraPrs: [
          { number: 7, url: 'u7' },
          { number: 9, url: 'u9' },
        ],
      },
    });
    await b.refresh();
    // The one the list shows as primary (the newest) is the one worth resolving.
    expect(b.seen[0]?.[0]?.knownPr).toEqual({ number: 9, url: 'u9' });
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

describe('PrCoordinator auto-recovery (autoSync / autoFixCi)', () => {
  const CONFLICTING: PrInfo = { number: 42, url: 'u', mergeStatus: 'conflicting' };
  const RED: PrInfo = { number: 42, url: 'u', mergeStatus: 'mergeable', checks: 'failing' };

  it('merges the base in when the poll reports a conflicting PR', async () => {
    const h = harness(async () => found(CONFLICTING), { autoSync: true });
    await h.refresh();
    expect(h.recoveries).toEqual(['s1:sync']);
  });

  it('asks the session to fix CI when the checks go red', async () => {
    const h = harness(async () => found(RED), { autoFixCi: true });
    await h.refresh();
    expect(h.recoveries).toEqual(['s1:ci']);
  });

  it.each([
    { label: 'conflicting with autoSync off', pr: CONFLICTING, flags: { autoFixCi: true } },
    { label: 'red CI with autoFixCi off', pr: RED, flags: { autoSync: true } },
    { label: 'both flags off', pr: CONFLICTING, flags: {} },
  ])('stays inert: $label', async ({ pr, flags }) => {
    const h = harness(async () => found(pr), flags);
    await h.refresh();
    expect(h.recoveries).toEqual([]);
  });

  it('leaves a healthy PR alone', async () => {
    const h = harness(async () => found(PR), { autoSync: true, autoFixCi: true });
    await h.refresh();
    expect(h.recoveries).toEqual([]);
  });

  it('never interrupts a session that is mid-turn', async () => {
    const h = harness(async () => found(RED), { autoFixCi: true });
    h.drive('running');
    await h.refresh();
    expect(h.recoveries).toEqual([]);
  });

  it('gives up after MAX_AUTO_RECOVERY_ATTEMPTS on a session that stays red', async () => {
    // The realistic failure mode: we ask, the session works and finishes without
    // pushing, so the checks are still red on the next poll. Without a cap this
    // spends a turn every 20s forever.
    const h = harness(async () => found(RED), {
      autoFixCi: true,
      onRecover: (_id, _kind) => h.drive('running'),
    });
    for (let i = 0; i < MAX_AUTO_RECOVERY_ATTEMPTS + 3; i += 1) {
      h.drive('completed');
      h.tick(STALE);
      await h.refresh();
    }
    expect(h.recoveries).toHaveLength(MAX_AUTO_RECOVERY_ATTEMPTS);
  });

  it('the cap survives the busy window right after an instruction is sent', async () => {
    // While the session runs, `recoveryKindFor` is undefined — but the PR is still
    // stuck, so the budget must NOT be handed back (that would make the cap moot).
    const h = harness(async () => found(RED), { autoFixCi: true });
    h.tick(STALE);
    await h.refresh();
    expect(h.recoveries).toEqual(['s1:ci']);
    h.drive('running');
    h.tick(STALE);
    await h.refresh();
    h.drive('completed');
    h.tick(STALE);
    await h.refresh();
    expect(h.recoveries).toEqual(['s1:ci', 's1:ci']);
    h.tick(STALE);
    await h.refresh();
    expect(h.recoveries).toHaveLength(MAX_AUTO_RECOVERY_ATTEMPTS);
  });

  it('refunds the budget once the PR actually goes green', async () => {
    let pr = RED;
    const h = harness(async () => found(pr), { autoFixCi: true });
    for (let i = 0; i < MAX_AUTO_RECOVERY_ATTEMPTS; i += 1) {
      h.tick(STALE);
      await h.refresh();
    }
    expect(h.recoveries).toHaveLength(MAX_AUTO_RECOVERY_ATTEMPTS);
    // CI goes green: the counter resets, so a later regression is acted on again.
    pr = PR;
    h.tick(STALE);
    await h.refresh();
    pr = RED;
    h.tick(STALE);
    await h.refresh();
    expect(h.recoveries).toHaveLength(MAX_AUTO_RECOVERY_ATTEMPTS + 1);
  });

  it('does NOT refund on the transient states every push produces', async () => {
    // The cap's real target: the agent pushes a fix that doesn't work. Every push
    // moves the PR through `checks: 'pending'` (and `mergeStatus: 'unknown'`), which
    // is "not stuck" — refunding there would let red → ask → pending → red bill a
    // turn forever, and `MAX_AUTO_RECOVERY_ATTEMPTS` would mean nothing.
    let pr = RED;
    const h = harness(async () => found(pr), { autoFixCi: true });
    for (let cycle = 0; cycle < 5; cycle += 1) {
      pr = RED;
      h.tick(STALE);
      await h.refresh();
      pr = { ...PR, checks: 'pending' }; // the agent pushed something
      h.tick(STALE);
      await h.refresh();
    }
    expect(h.recoveries).toHaveLength(MAX_AUTO_RECOVERY_ATTEMPTS);
  });

  it('falls through to the enabled kind when the higher-priority one is off', async () => {
    // Conflicting *and* red, but only autoFixCi is on. Picking the top-priority kind
    // (`sync`) and stopping would leave the user's enabled automation doing nothing.
    const both: PrInfo = { ...PR, mergeStatus: 'conflicting', checks: 'failing' };
    const h = harness(async () => found(both), { autoFixCi: true });
    await h.refresh();
    expect(h.recoveries).toEqual(['s1:ci']);
  });

  it('prefers sync over ci when both are enabled (base first, checks re-run anyway)', async () => {
    const both: PrInfo = { ...PR, mergeStatus: 'conflicting', checks: 'failing' };
    const h = harness(async () => found(both), { autoSync: true, autoFixCi: true });
    await h.refresh();
    expect(h.recoveries).toEqual(['s1:sync']);
  });

  it("forget(id) releases a discarded session's records", async () => {
    const session = fakeSession(stateFor('s1', { status: 'completed' }));
    const recoveries: string[] = [];
    let clock = 0;
    const coordinator = new PrCoordinator({
      worktrees,
      lookupPr: async () => found(RED),
      autoFixCi: true,
      recover: async (id, kind) => {
        recoveries.push(`${id}:${kind}`);
        return { kind: 'delegated', recovery: kind };
      },
      getMeta: () => ({
        worktree: { slug: 's1', branch: 'codiva/s1', path: '/wt/s1' },
        base: 'main',
      }),
      getState: () => session.current(),
      getSession: () => session.handle,
      ids: () => ['s1'],
      now: () => clock,
    });
    for (let i = 0; i < MAX_AUTO_RECOVERY_ATTEMPTS + 1; i += 1) {
      clock += STALE;
      await coordinator.refreshPrs();
    }
    expect(recoveries).toHaveLength(MAX_AUTO_RECOVERY_ATTEMPTS);
    coordinator.forget('s1');
    clock += STALE;
    await coordinator.refreshPrs();
    expect(recoveries).toHaveLength(MAX_AUTO_RECOVERY_ATTEMPTS + 1);
  });

  it('does nothing without a recover port wired', async () => {
    const session = fakeSession(stateFor('s1', { status: 'completed' }));
    const coordinator = new PrCoordinator({
      worktrees,
      lookupPr: async () => found(RED),
      autoFixCi: true,
      getMeta: () => ({
        worktree: { slug: 's1', branch: 'codiva/s1', path: '/wt/s1' },
        base: 'main',
      }),
      getState: () => session.current(),
      getSession: () => session.handle,
      ids: () => ['s1'],
      now: () => 0,
    });
    await expect(coordinator.refreshPrs()).resolves.toBeUndefined();
  });
});
