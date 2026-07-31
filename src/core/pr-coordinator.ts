import type {
  PrAutomation,
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
  /** PR lookup (via `gh`); when set, refreshPrs() polls each live branch. */
  lookupPr?: PrLookup;
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
   * Poll every live session's branch for its PR and feed the result back in via
   * session.setPr (the reducer no-ops when unchanged). Best-effort per session; one
   * lookup failure never rejects nor affects the others. No-op with no lookupPr,
   * while a previous cycle is still running, or during a backoff window.
   */
  async refreshPrs(): Promise<void> {
    const lookup = this.deps.lookupPr;
    if (!lookup || this.refreshing || this.now() < this.backoffUntil) {
      return;
    }
    this.refreshing = true;
    try {
      const reasons = await Promise.all(this.deps.ids().map((id) => this.refreshOne(id, lookup)));
      if (reasons.some((reason) => reason !== undefined && BACKOFF_REASONS.has(reason))) {
        this.backoffUntil = this.now() + PR_LOOKUP_BACKOFF_MS;
      }
    } finally {
      this.refreshing = false;
    }
  }

  /**
   * One session's lookup. Returns the failure reason (if any) so the caller can
   * decide whether to back the whole poll off.
   */
  private async refreshOne(id: string, lookup: PrLookup): Promise<PrUnavailableReason | undefined> {
    const state = this.deps.getState(id);
    const meta = this.deps.getMeta(id);
    const session = this.deps.getSession(id);
    // Skip rows with no worktree yet (creating) or already archived — nothing to
    // look up, and no branch that could have a PR. A merged PR is final, so stop
    // spending API budget on it.
    if (!state || !meta || !session || state.status === 'archived') {
      return undefined;
    }
    if (state.pr?.mergeStatus === 'merged') {
      return undefined;
    }
    // Show "looking…" only while there's nothing else to show, and only until the
    // first answered lookup: re-marking it on later ticks would flicker the cell
    // (⋯ → empty for a branch with no PR, ⋯ → ? after a failure).
    if (!state.pr && state.prLookup === undefined && !this.answered.has(id)) {
      session.setPrLookup('loading');
    }
    let result: PrLookupResult;
    try {
      result = await lookup(meta.worktree.path, state.branch);
    } catch {
      // A lookup port that rejects rather than classifying: same handling as
      // `unavailable` — keep whatever we knew and flag the cell.
      result = { kind: 'unavailable', reason: 'unknown' };
    }
    if (result.kind === 'unavailable') {
      // `gh` missing entirely means the feature just isn't available here — marking
      // every row "couldn't check" forever would be pure noise. Everything else is a
      // real "can't check right now" the user can act on (login / quota / network).
      session.setPrLookup(result.reason === 'cli' ? undefined : 'error');
      return result.reason;
    }
    const pr = result.kind === 'found' ? result.pr : undefined;
    this.answered.add(id);
    session.setPr(pr);
    try {
      // Auto-ready: once a draft PR's checks pass, flip it to ready-for-review.
      // `checks` came along with the PR view, so this costs no extra API call.
      if (this.deps.autoPr && this.deps.prAutomation && pr?.isDraft && pr.checks === 'passing') {
        await this.deps.prAutomation.markReady(meta.worktree.path, state.branch);
        session.setPr({ ...pr, isDraft: false });
      }
    } catch {
      // best-effort — readying is a convenience; the PR stays a draft otherwise
    }
    return undefined;
  }
}
