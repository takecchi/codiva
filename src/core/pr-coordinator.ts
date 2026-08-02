import {
  MAX_AUTO_RECOVERY_ATTEMPTS,
  prRecovered,
  type RecoveryKind,
  type RecoveryOutcome,
  recoveryKindFor,
  stuckKinds,
} from './pr-recovery';
import { isPrRefreshDue, PR_BATCH_MIN_SESSIONS } from './pr-refresh';
import type {
  PrAutomation,
  PrBatchLookup,
  PrLookup,
  SessionHandle,
  WorktreeMeta,
  WorktreeService,
} from './session-ports';
import type { PrLookupResult, PrUnavailableReason, SessionState } from './types';

export interface PrCoordinatorDeps {
  worktrees: WorktreeService;
  /** When true (with prAutomation), a completed session is pushed + gets a draft PR. */
  autoPr?: boolean;
  /** PR create/ready seam (via `gh`); required for autoPr. */
  prAutomation?: PrAutomation;
  /** PR lookup (via `gh`); when set, refreshPrs() polls each stale branch. */
  lookupPr?: PrLookup;
  /**
   * Batched lookup (one `gh pr list` for many sessions). Used once
   * `PR_BATCH_MIN_SESSIONS` rows are due in the same cycle, which is what keeps the
   * API cost flat as sessions pile up. Falls back to `lookupPr` when absent.
   */
  lookupPrs?: PrBatchLookup;
  /** Auto-merge the base branch into a PR the poll reports as `conflicting`. */
  autoSync?: boolean;
  /** Auto-ask a session to fix its PR's failing checks. */
  autoFixCi?: boolean;
  /**
   * Run one recovery (injected by SessionManager, which owns the git/send side).
   * Required for autoSync / autoFixCi to do anything.
   */
  recover?: (id: string, kind: RecoveryKind) => Promise<RecoveryOutcome>;
  getMeta: (id: string) => WorktreeMeta | undefined;
  getState: (id: string) => SessionState | undefined;
  getSession: (id: string) => SessionHandle | undefined;
  ids: () => readonly string[];
  /** Injected clock (kept out of wall-clock reads so the backoff is testable). */
  now?: () => number;
}

/**
 * How long to stop polling after a failure that can't succeed on the next tick.
 * `gh pr view --json mergeable` spends GitHub's *GraphQL* quota, which the user's
 * other tooling (including Claude sessions running `gh`) shares — so once it's
 * exhausted, hammering it every 20s only keeps it exhausted.
 */
export const PR_LOOKUP_BACKOFF_MS = 5 * 60_000;

/** Failures worth backing off from; the rest are transient enough to retry at once. */
const BACKOFF_REASONS = new Set<PrUnavailableReason>(['rate_limit', 'cli', 'auth']);

/** A session picked for this refresh cycle, with everything needed to resolve it. */
interface RefreshTarget {
  id: string;
  state: SessionState;
  meta: WorktreeMeta;
  session: SessionHandle;
}

/**
 * Best-effort GitHub PR automation for sessions, kept out of SessionManager.
 * Opens a draft PR when a session first completes with committed work, and polls
 * live branches to surface `#<n>` + its checks (readying a draft once they pass).
 * Every `gh`/network failure is swallowed so it never disrupts a session.
 *
 * Failures are *not* silent in the UI, though: a lookup that couldn't answer marks
 * the session `prLookup: 'error'` and leaves the last known PR in place. Reporting
 * "no PR" for a failed lookup is what used to make `#<n>` blink out of the list on
 * every rate limit / network hiccup.
 */
export class PrCoordinator {
  /** Sessions we've already attempted an auto-PR for (avoids repeat push/create). */
  private readonly attempted = new Set<string>();
  /**
   * Sessions whose lookup has been *answered* at least once (found or absent).
   * Needed because "answered: no PR" and "never asked" look identical in state —
   * both are `pr: undefined, prLookup: undefined` — so without this the poll would
   * re-mark `loading` every 20s and the cell would flicker `⋯` → empty forever for
   * every branch that simply has no PR.
   */
  private readonly answered = new Set<string>();
  /**
   * When each session's PR info was last *answered* — the cache timestamp behind
   * `isPrRefreshDue`. Failures are deliberately not stamped so they retry promptly.
   */
  private readonly lastFetched = new Map<string, number>();
  /**
   * How many times auto-recovery has fired per `<id>:<kind>`. Bounded because the
   * trigger is a *state*, not an event: if we ask a session to fix CI and it
   * finishes without pushing, the checks stay red and the very next poll would ask
   * again — forever, spending a turn each time. Reset when the condition clears, so
   * a session that recovers and later breaks again gets a fresh budget.
   */
  private readonly recoveries = new Map<string, number>();
  /** Guards against overlapping refresh cycles (a slow `gh` outliving the 20s timer). */
  private refreshing = false;
  /** Epoch ms until which polling is suspended after a rate-limit/auth/cli failure. */
  private backoffUntil = 0;
  private readonly now: () => number;

  constructor(private readonly deps: PrCoordinatorDeps) {
    this.now = deps.now ?? Date.now;
  }

  /**
   * Push the branch and open a draft PR for a just-completed session (once each).
   * No-op unless autoPr + prAutomation are wired, the session already has a PR, or
   * the branch has nothing committed ahead of base. refreshPrs() later readies it.
   */
  async maybeAutoPr(id: string): Promise<void> {
    if (!this.deps.autoPr || !this.deps.prAutomation || this.attempted.has(id)) {
      return;
    }
    const meta = this.deps.getMeta(id);
    const state = this.deps.getState(id);
    const session = this.deps.getSession(id);
    if (!meta || !state || !session || state.pr) {
      return;
    }
    this.attempted.add(id);
    try {
      const stat = await this.deps.worktrees.diffStat(meta.worktree, meta.base);
      if (stat.committed.trim().length === 0) {
        // Nothing committed ahead of base — there's nothing to open a PR for.
        return;
      }
      await this.deps.worktrees.pushBranch(meta.worktree);
      const pr = await this.deps.prAutomation.createPr(meta.worktree.path, state.branch);
      if (pr) {
        session.setPr(pr);
      }
    } catch {
      // best-effort — a missing remote / `gh` / network issue must not disrupt the session
    }
  }

  /**
   * Poll the sessions whose PR info has gone stale and feed the results back in via
   * session.setPr (the reducer no-ops when unchanged). Best-effort per session; one
   * lookup failure never rejects nor affects the others. No-op with no lookupPr,
   * while a previous cycle is still running, during a backoff window, or when every
   * row's cached value is still fresh (see core/pr-refresh.ts).
   *
   * Called on a fixed short tick, but the tick only *schedules*: per-session
   * staleness decides what actually costs an API call, and 3+ due rows collapse into
   * a single `gh pr list` so the cost stops scaling with the session count.
   */
  async refreshPrs(): Promise<void> {
    const lookup = this.deps.lookupPr;
    if (!lookup || this.refreshing || this.now() < this.backoffUntil) {
      return;
    }
    const due = this.dueTargets();
    if (due.length === 0) {
      return;
    }
    this.refreshing = true;
    try {
      for (const target of due) {
        this.markLooking(target);
      }
      const reasons =
        this.deps.lookupPrs && due.length >= PR_BATCH_MIN_SESSIONS
          ? await this.refreshBatched(due, this.deps.lookupPrs)
          : await Promise.all(due.map((target) => this.refreshOne(target, lookup)));
      if (reasons.some((reason) => reason !== undefined && BACKOFF_REASONS.has(reason))) {
        this.backoffUntil = this.now() + PR_LOOKUP_BACKOFF_MS;
      }
    } finally {
      this.refreshing = false;
    }
  }

  /**
   * The sessions worth asking about this cycle: live, provisioned, and stale per
   * `isPrRefreshDue`. Rows with no worktree yet (`creating`), archived rows and
   * merged PRs never qualify — there's nothing that could change.
   */
  private dueTargets(): RefreshTarget[] {
    const now = this.now();
    const targets: RefreshTarget[] = [];
    for (const id of this.deps.ids()) {
      const state = this.deps.getState(id);
      const meta = this.deps.getMeta(id);
      const session = this.deps.getSession(id);
      if (!state || !meta || !session) {
        continue;
      }
      if (isPrRefreshDue(state, this.lastFetched.get(id), now)) {
        targets.push({ id, state, meta, session });
      }
    }
    return targets;
  }

  /**
   * Show "looking…" only while there's nothing else to show, and only until the
   * first answered lookup: re-marking it on later ticks would flicker the cell
   * (⋯ → empty for a branch with no PR, ⋯ → ? after a failure).
   */
  private markLooking({ id, state, session }: RefreshTarget): void {
    if (!state.pr && state.prLookup === undefined && !this.answered.has(id)) {
      session.setPrLookup('loading');
    }
  }

  /** One `gh pr list` for every due session, then the same per-session handling. */
  private async refreshBatched(
    due: readonly RefreshTarget[],
    lookupPrs: PrBatchLookup,
  ): Promise<(PrUnavailableReason | undefined)[]> {
    let results: ReadonlyMap<string, PrLookupResult>;
    try {
      results = await lookupPrs(
        due.map(({ id, state, meta }) => ({
          id,
          cwd: meta.worktree.path,
          branch: state.branch,
          ...(state.pr ? { knownPr: state.pr.number } : {}),
        })),
      );
    } catch {
      results = new Map();
    }
    return Promise.all(
      due.map((target) =>
        // A target the batch didn't answer is "couldn't tell", never "no PR".
        this.applyResult(
          target,
          results.get(target.id) ?? { kind: 'unavailable', reason: 'unknown' },
        ),
      ),
    );
  }

  /** One session's own lookup (used below the batching threshold). */
  private async refreshOne(
    target: RefreshTarget,
    lookup: PrLookup,
  ): Promise<PrUnavailableReason | undefined> {
    let result: PrLookupResult;
    try {
      result = await lookup(target.meta.worktree.path, target.state.branch);
    } catch {
      // A lookup port that rejects rather than classifying: same handling as
      // `unavailable` — keep whatever we knew and flag the cell.
      result = { kind: 'unavailable', reason: 'unknown' };
    }
    return this.applyResult(target, result);
  }

  /**
   * Fold one lookup result into the session and return the failure reason (if any)
   * so the caller can decide whether to back the whole poll off.
   */
  private async applyResult(
    { id, state, meta, session }: RefreshTarget,
    result: PrLookupResult,
  ): Promise<PrUnavailableReason | undefined> {
    if (result.kind === 'unavailable') {
      // `gh` missing entirely means the feature just isn't available here — marking
      // every row "couldn't check" forever would be pure noise. Everything else is a
      // real "can't check right now" the user can act on (login / quota / network).
      session.setPrLookup(result.reason === 'cli' ? undefined : 'error');
      // No lastFetched stamp: a failure isn't a cached answer, so the next tick retries.
      return result.reason;
    }
    const pr = result.kind === 'found' ? result.pr : undefined;
    this.answered.add(id);
    this.lastFetched.set(id, this.now());
    session.setPr(pr);
    try {
      // Auto-ready: once a draft PR's checks pass, flip it to ready-for-review.
      // `checks` came along with the PR payload, so this costs no extra lookup.
      if (this.deps.autoPr && this.deps.prAutomation && pr?.isDraft && pr.checks === 'passing') {
        await this.deps.prAutomation.markReady(meta.worktree.path, state.branch);
        session.setPr({ ...pr, isDraft: false });
      }
    } catch {
      // best-effort — readying is a convenience; the PR stays a draft otherwise
    }
    // Read the state back rather than reusing `state`: the target was snapshotted
    // before this lookup, so its pr/prStatus are exactly the values we just replaced.
    await this.maybeAutoRecover(id, session);
    return undefined;
  }

  /**
   * Act on a PR that came back stuck — merge the base branch in when it conflicts,
   * or hand the red build to the session. Opt-in per kind (`autoSync` /
   * `autoFixCi`), capped per session, and swallowed on failure like everything else
   * here. No-op while a session is working: `recoveryKindFor` only fires on idle
   * rows, so a recovery already in flight can't be re-triggered by the next tick.
   */
  private async maybeAutoRecover(id: string, session: SessionHandle): Promise<void> {
    const run = this.deps.recover;
    if (!run) {
      return;
    }
    const state = session.getState();
    if (prRecovered(state)) {
      // Give the budget back so a *future* breakage is acted on instead of being
      // locked out by an old attempt. The condition is deliberately "green", not
      // merely "not stuck": every push moves the PR through `checks: 'pending'` /
      // `mergeStatus: 'unknown'`, which are not stuck either. Refunding there would
      // make the cap unenforceable in the case it exists for — the agent pushes a
      // fix that doesn't work, so the cycle red → ask → pending → red repeats
      // forever, one billed turn each time.
      this.recoveries.delete(`${id}:sync`);
      this.recoveries.delete(`${id}:ci`);
      return;
    }
    if (!recoveryKindFor(state)) {
      return; // mid-turn, or nothing actionable right now — leave the counters be
    }
    // Walk every applicable kind rather than only the highest-priority one: a PR
    // that both conflicts and is red would otherwise do nothing at all for a user
    // who enabled `autoFixCi` but not `autoSync`.
    for (const kind of stuckKinds(state)) {
      const enabled = kind === 'sync' ? this.deps.autoSync : this.deps.autoFixCi;
      const key = `${id}:${kind}`;
      const attempts = this.recoveries.get(key) ?? 0;
      if (!enabled || attempts >= MAX_AUTO_RECOVERY_ATTEMPTS) {
        continue;
      }
      this.recoveries.set(key, attempts + 1);
      try {
        await run(id, kind);
      } catch {
        // best-effort — a failed git/gh step must not disrupt the poll or the session
      }
      // One recovery per cycle: it just changed the session/PR, so any second kind
      // must be re-judged against fresh state on the next poll.
      return;
    }
  }

  /**
   * Drop every per-session record (called when a session leaves the store via
   * `/clear` or discard). Ids are never reused, so this is hygiene rather than
   * correctness — but without it these maps grow for the life of the process.
   */
  forget(id: string): void {
    this.attempted.delete(id);
    this.answered.delete(id);
    this.lastFetched.delete(id);
    this.recoveries.delete(`${id}:sync`);
    this.recoveries.delete(`${id}:ci`);
  }
}
