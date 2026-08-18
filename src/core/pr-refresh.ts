import { isTerminalStatus } from './status-meta';
import type { SessionState } from './types';

/**
 * When a session's PR info is worth re-fetching. Pure so the polling budget is
 * decided by testable rules rather than a single global interval.
 *
 * Why this exists: every lookup spends GitHub API budget (`gh pr view --json
 * mergeable` hits the *GraphQL* quota, 5000/h, shared with the `gh` calls the
 * Claude sessions themselves make). A flat 20s poll for every row meant N
 * sessions × 180 calls/hour — with a handful of sessions that alone can exhaust
 * the quota, which is exactly what made the PR column unreliable. So we keep the
 * last known value and only re-ask when it could plausibly have changed.
 */

/** CI is in flight: the state changes minute-to-minute and auto-ready waits on it. */
export const PR_POLL_FAST_MS = 20_000;
/** Something is expected to appear/settle soon (a finished session, a fresh PR). */
export const PR_POLL_SOON_MS = 60_000;
/** Nothing is expected to change on its own (only the base branch moving). */
export const PR_POLL_STABLE_MS = 180_000;

/**
 * How long this session's PR info stays fresh, or undefined when it never needs
 * re-fetching (archived row, or a merged PR — a terminal state on GitHub's side).
 */
export function prPollIntervalMs(state: SessionState): number | undefined {
  if (state.status === 'archived') {
    return undefined;
  }
  const status = state.prStatus;
  if (status?.mergeStatus === 'merged') {
    // Merged is final: nothing about it can change again.
    return undefined;
  }
  if (state.pr && !status) {
    // We know *which* PR this is (e.g. restored from disk, or just created) but not
    // its state yet — fetch it right away so the glyph appears next to the number.
    return 0;
  }
  if (status) {
    // Closed (unmerged) is as good as final, but not *quite*: a human can reopen the
    // PR, so keep asking at the slow interval instead of dropping it like `merged`.
    // Checked before `checks`, since a closed PR's CI finishing changes nothing here.
    if (status.mergeStatus === 'closed') {
      return PR_POLL_STABLE_MS;
    }
    // Checks running → poll fast (the glyph moves and auto-ready triggers off it).
    // `unknown` mergeability is GitHub still computing it (seconds), so "soon".
    if (status.checks === 'pending') {
      return PR_POLL_FAST_MS;
    }
    return status.mergeStatus === 'unknown' ? PR_POLL_SOON_MS : PR_POLL_STABLE_MS;
  }
  // No PR yet. It typically appears right after the work lands (codiva's own
  // auto-PR on completion, or the agent's `gh pr create` at the end of its task),
  // so watch finished sessions more closely than ones still working.
  return isTerminalStatus(state.status) ? PR_POLL_SOON_MS : PR_POLL_STABLE_MS;
}

/**
 * Whether to look this session's PR up now. `lastFetchedAt` is when a lookup last
 * *answered* (found or absent) — a failed lookup doesn't count, so a transient
 * `gh` error retries on the next tick (bounded separately by the backoff window).
 */
export function isPrRefreshDue(
  state: SessionState,
  lastFetchedAt: number | undefined,
  now: number,
): boolean {
  const interval = prPollIntervalMs(state);
  if (interval === undefined) {
    return false;
  }
  return lastFetchedAt === undefined || now - lastFetchedAt >= interval;
}

/**
 * Sessions per cycle at which one batched `gh pr list` beats a `gh pr view` each.
 * The list query carries every PR's check rollup, so it costs more than a single
 * targeted view — it only pays off once a few rows are due at the same time.
 */
export const PR_BATCH_MIN_SESSIONS = 3;
