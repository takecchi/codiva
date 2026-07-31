import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  PrChecksState,
  PrInfo,
  PrLookupResult,
  PrMergeStatus,
  PrUnavailableReason,
} from '@/core';

const execFileAsync = promisify(execFile);

/** execFile-shaped runner, injectable so PR helpers can be unit-tested without `gh`/`git`. */
export type ExecLike = (
  file: string,
  args: string[],
  opts: { cwd: string },
) => Promise<{ stdout: string }>;

/**
 * The one `gh pr view` field set we ask for. `statusCheckRollup` rides along in the
 * *same* call as the PR metadata on purpose: it used to be a second `gh` invocation
 * for auto-ready, which doubled the API cost of every poll for no extra information.
 */
const PR_VIEW_FIELDS = 'number,url,state,mergeable,isDraft,statusCheckRollup';

/** Shape of the `gh pr view --json …` payload we care about. */
interface PrViewJson {
  number?: unknown;
  url?: unknown;
  /** `OPEN` | `MERGED` | `CLOSED`. */
  state?: unknown;
  /** `MERGEABLE` | `CONFLICTING` | `UNKNOWN`. */
  mergeable?: unknown;
  isDraft?: unknown;
  /** Array of check-runs / status-contexts for the PR's head commit. */
  statusCheckRollup?: unknown;
}

/**
 * Map GitHub's `state` / `mergeable` into our glyph-driving status. `state`
 * wins: a merged PR is `merged` regardless of the (stale) mergeable value.
 */
function toMergeStatus(state: unknown, mergeable: unknown): PrMergeStatus {
  if (state === 'MERGED') {
    return 'merged';
  }
  if (mergeable === 'MERGEABLE') {
    return 'mergeable';
  }
  if (mergeable === 'CONFLICTING') {
    return 'conflicting';
  }
  return 'unknown';
}

/** One entry of `gh`'s statusCheckRollup (check-run or legacy status-context). */
interface RollupCheck {
  /** Check-run lifecycle: QUEUED | IN_PROGRESS | COMPLETED. */
  status?: unknown;
  /** Check-run result once COMPLETED: SUCCESS | FAILURE | ... . */
  conclusion?: unknown;
  /** Legacy commit-status state: SUCCESS | PENDING | FAILURE | ERROR. */
  state?: unknown;
}

const FAILING = new Set([
  'FAILURE',
  'ERROR',
  'CANCELLED',
  'TIMED_OUT',
  'ACTION_REQUIRED',
  'STARTUP_FAILURE',
]);

function isFailing(c: RollupCheck): boolean {
  return FAILING.has(String(c.conclusion ?? '')) || FAILING.has(String(c.state ?? ''));
}

function isPending(c: RollupCheck): boolean {
  // A check-run that hasn't COMPLETED, or a status-context still PENDING/EXPECTED.
  const s = String(c.status ?? '');
  if (s.length > 0 && s !== 'COMPLETED') {
    return true;
  }
  const state = String(c.state ?? '');
  return state === 'PENDING' || state === 'EXPECTED';
}

/** Aggregate a statusCheckRollup array into one CI state (worst-first). */
function toChecksState(rollup: unknown): PrChecksState {
  const checks = Array.isArray(rollup) ? (rollup as RollupCheck[]) : [];
  if (checks.length === 0) {
    return 'none';
  }
  if (checks.some(isFailing)) {
    return 'failing';
  }
  if (checks.some(isPending)) {
    return 'pending';
  }
  return 'passing';
}

function toPrInfo(stdout: string): PrInfo | undefined {
  const json = JSON.parse(stdout) as PrViewJson;
  const number = typeof json.number === 'number' ? json.number : undefined;
  const url = typeof json.url === 'string' ? json.url : undefined;
  if (number === undefined || url === undefined) {
    return undefined;
  }
  const pr: PrInfo = {
    number,
    url,
    mergeStatus: toMergeStatus(json.state, json.mergeable),
    checks: toChecksState(json.statusCheckRollup),
  };
  return typeof json.isDraft === 'boolean' ? { ...pr, isDraft: json.isDraft } : pr;
}

/** Concatenate the strings an execFile rejection carries (code / message / streams). */
function errorText(err: unknown): string {
  if (typeof err !== 'object' || err === null) {
    return String(err).toLowerCase();
  }
  const record = err as Record<string, unknown>;
  return ['code', 'message', 'stderr', 'stdout']
    .map((key) => record[key])
    .filter((v): v is string => typeof v === 'string')
    .join('\n')
    .toLowerCase();
}

/** True when `gh` told us the branch simply has no PR (an answer, not a failure). */
function meansNoPr(text: string): boolean {
  return (
    text.includes('no pull requests found') ||
    text.includes('no pull request found') ||
    text.includes('could not resolve to a pullrequest')
  );
}

/**
 * Classify why `gh` failed, so the caller can keep the last known PR instead of
 * treating "couldn't ask" as "there is none". Ordered most-specific first;
 * anything unrecognized is `unknown` (still non-destructive, just not backed off).
 */
function toUnavailableReason(text: string): PrUnavailableReason {
  if (text.includes('enoent') || text.includes('command not found')) {
    return 'cli';
  }
  if (
    text.includes('rate limit') ||
    text.includes('secondary rate') ||
    text.includes('api rate limit')
  ) {
    return 'rate_limit';
  }
  if (
    text.includes('gh auth login') ||
    text.includes('authentication') ||
    text.includes('not logged in') ||
    text.includes('bad credentials') ||
    text.includes('http 401')
  ) {
    return 'auth';
  }
  if (
    text.includes('could not resolve host') ||
    text.includes('network is unreachable') ||
    text.includes('connection refused') ||
    text.includes('etimedout') ||
    text.includes('econnreset') ||
    text.includes('eai_again') ||
    text.includes('timeout') ||
    text.includes('dial tcp')
  ) {
    return 'network';
  }
  return 'unknown';
}

/**
 * The worktree's current HEAD branch, or undefined when detached / unresolvable.
 *
 * A session is created on a `codiva/<slug>` worktree branch, but the work that
 * ends up as a PR usually lives on a *different* branch: our git rules cut a
 * fresh `feat/…` / `fix/…` branch before opening the PR, which moves the
 * worktree's HEAD off `codiva/<slug>`. Looking the PR up by the recorded
 * `codiva/<slug>` name then finds nothing and the `#<n>` badge never appears.
 * So we resolve where HEAD actually points and prefer that.
 */
async function currentBranch(cwd: string, exec: ExecLike): Promise<string | undefined> {
  try {
    const { stdout } = await exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd });
    const branch = stdout.trim();
    // Empty or the literal "HEAD" means detached — no branch name to query by.
    return branch.length === 0 || branch === 'HEAD' ? undefined : branch;
  } catch {
    return undefined;
  }
}

/** One `gh pr view` for a single branch, classified into a lookup result. */
async function viewPr(cwd: string, branch: string, exec: ExecLike): Promise<PrLookupResult> {
  let stdout: string;
  try {
    ({ stdout } = await exec('gh', ['pr', 'view', branch, '--json', PR_VIEW_FIELDS], { cwd }));
  } catch (err) {
    const text = errorText(err);
    return meansNoPr(text)
      ? { kind: 'absent' }
      : { kind: 'unavailable', reason: toUnavailableReason(text) };
  }
  try {
    const pr = toPrInfo(stdout);
    // Well-formed JSON without number/url shouldn't happen; treat it as "couldn't
    // tell" rather than "no PR" so a parse surprise never wipes a known badge.
    return pr ? { kind: 'found', pr } : { kind: 'unavailable', reason: 'unknown' };
  } catch {
    return { kind: 'unavailable', reason: 'unknown' };
  }
}

/**
 * Resolve the open PR for a session's worktree via the GitHub CLI. Tries the
 * worktree's *current* HEAD branch first (where the work and its PR actually live)
 * and falls back to the recorded `branch`, so the `#<n>` badge still shows when the
 * session opened its PR from a branch other than the original `codiva/<slug>` one.
 *
 * Never throws. Distinguishes "this branch has no PR" (`absent`) from "`gh`
 * couldn't tell us" (`unavailable`) — callers must keep the previously known PR in
 * the latter case, otherwise a rate limit or a dropped connection silently erases
 * the badge until the next successful poll.
 */
export async function lookupPr(
  cwd: string,
  branch: string,
  exec: ExecLike = execFileAsync,
): Promise<PrLookupResult> {
  const head = await currentBranch(cwd, exec);
  // De-dup: only fall through to the recorded branch when HEAD differs from it.
  const candidates = head && head !== branch ? [head, branch] : [branch];
  let lastFailure: PrLookupResult | undefined;
  for (const candidate of candidates) {
    const result = await viewPr(cwd, candidate, exec);
    if (result.kind === 'found') {
      return result;
    }
    if (result.kind === 'unavailable') {
      lastFailure = result;
    }
  }
  // Only report `absent` when every candidate was actually answered; a failure on
  // any candidate means we can't rule out a PR on it.
  return lastFailure ?? { kind: 'absent' };
}

/**
 * Open a draft PR for `branch` (title/body auto-filled from commits) and return
 * it. The branch must already be pushed to origin. If a PR already exists the
 * create step fails harmlessly and we still return the existing PR via lookup.
 * Best-effort: resolves undefined when no PR can be found/created.
 */
export async function createPr(
  cwd: string,
  branch: string,
  exec: ExecLike = execFileAsync,
): Promise<PrInfo | undefined> {
  try {
    await exec('gh', ['pr', 'create', '--draft', '--fill', '--head', branch], { cwd });
  } catch {
    // PR may already exist, or `gh` is unavailable — fall through to lookup.
  }
  const result = await lookupPr(cwd, branch, exec);
  return result.kind === 'found' ? result.pr : undefined;
}

/** Mark a draft PR ready for review (`gh pr ready`). Throws on failure. */
export async function markPrReady(
  cwd: string,
  branch: string,
  exec: ExecLike = execFileAsync,
): Promise<void> {
  await exec('gh', ['pr', 'ready', branch], { cwd });
}
