import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  MAX_FAILING_CHECKS,
  type PrCheckRun,
  type PrChecksState,
  type PrInfo,
  type PrLookupOptions,
  type PrLookupResult,
  type PrLookupTarget,
  type PrMergeStatus,
  type PrUnavailableReason,
} from '@/core';
import { childProcessEnv } from './child-env';

/**
 * `gh pr list --json …` は最大 100 件ぶんのチェック rollup を運ぶため、execFile 既定の
 * 1MB を超え得る（超えると ERR_CHILD_PROCESS_STDIO_MAXBUFFER で PR 列が丸ごと出なく
 * なる）。`utils/git.ts` が 32MB を指定しているのと同じ理由。
 */
const MAX_GH_OUTPUT_BYTES = 8 * 1024 * 1024;

const execFileRaw = promisify(execFile);
const execFileAsync = (
  file: string,
  args: string[],
  opts: { cwd: string },
): Promise<{ stdout: string }> =>
  // `env` は `childProcessEnv()`（`gh` は push で git フックを起こす）。
  execFileRaw(file, args, { ...opts, maxBuffer: MAX_GH_OUTPUT_BYTES, env: childProcessEnv() });

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

/**
 * Cap on the named failing checks we carry. A red matrix build can produce dozens
 * of identical-looking entries; the names exist to point Claude at the right job,
 * not to reproduce the checks tab.
 */
const MAX_NAMED_FAILURES = MAX_FAILING_CHECKS;

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
 * wins: a merged PR is `merged` regardless of the (stale) mergeable value, and a
 * closed one is `closed` even though GitHub keeps reporting whether it *could* have
 * merged (`mergeable: 'MERGEABLE'` on a closed PR would otherwise render as a green
 * ✓, i.e. "ready to merge" for a PR that is over).
 */
function toMergeStatus(state: unknown, mergeable: unknown): PrMergeStatus {
  if (state === 'MERGED') {
    return 'merged';
  }
  if (state === 'CLOSED') {
    return 'closed';
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
  /** Check-run job name (`build (20.x)`). */
  name?: unknown;
  /** Legacy status-context id (`ci/circleci`, `codecov/patch`) — its name field. */
  context?: unknown;
  /** Workflow the check-run belongs to (`CI`); absent on status contexts. */
  workflowName?: unknown;
  /** Link to the run/context page — where `gh run view` would send you. */
  detailsUrl?: unknown;
  /** Legacy status-context link (same role as `detailsUrl`). */
  targetUrl?: unknown;
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * Name the red checks so a fix instruction can point at them. Free of charge: the
 * rollup is already in the PR payload we fetch for the glyph — we simply stopped
 * throwing the per-check fields away. `<workflow> / <job>` matches how GitHub
 * labels them in the checks tab, which is also how `gh run` refers to them.
 */
function toFailingChecks(rollup: unknown): PrCheckRun[] {
  const checks = Array.isArray(rollup) ? (rollup as RollupCheck[]) : [];
  const out: PrCheckRun[] = [];
  for (const check of checks) {
    if (!isFailing(check) || out.length >= MAX_NAMED_FAILURES) {
      continue;
    }
    // Check-runs carry `name`; legacy status contexts (CircleCI, Codecov, Jenkins…)
    // carry `context` instead, and `isFailing` accepts both — so read both here too,
    // or every external CI failure lands in the prompt as an unhelpful "check".
    const job = stringOr(check.name, '') || stringOr(check.context, 'check');
    const workflow = optionalString(check.workflowName);
    const url = optionalString(check.detailsUrl) ?? optionalString(check.targetUrl);
    out.push({
      name: workflow ? `${workflow} / ${job}` : job,
      ...(url ? { url } : {}),
    });
  }
  return out;
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

/** Shared by the single (`pr view`) and batched (`pr list`) payload shapes. */
function toPrJson(json: PrViewJson): PrInfo | undefined {
  const number = typeof json.number === 'number' ? json.number : undefined;
  const url = typeof json.url === 'string' ? json.url : undefined;
  if (number === undefined || url === undefined) {
    return undefined;
  }
  const checks = toChecksState(json.statusCheckRollup);
  const pr: PrInfo = {
    number,
    url,
    mergeStatus: toMergeStatus(json.state, json.mergeable),
    checks,
    // Only carried while the aggregate is red — otherwise the field would churn the
    // reducer's status comparison for no display or recovery benefit.
    ...(checks === 'failing' ? { failingChecks: toFailingChecks(json.statusCheckRollup) } : {}),
  };
  return typeof json.isDraft === 'boolean' ? { ...pr, isDraft: json.isDraft } : pr;
}

function toPrInfo(stdout: string): PrInfo | undefined {
  return toPrJson(JSON.parse(stdout) as PrViewJson);
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

/**
 * One `gh pr view` for a single ref, classified into a lookup result. `ref` is a
 * branch name or a PR **URL** — `gh pr view` accepts both, which is what lets us ask
 * about a PR whose head branch this worktree doesn't have checked out (and, with a
 * URL, one that isn't even in this repository).
 */
async function viewPr(cwd: string, ref: string, exec: ExecLike): Promise<PrLookupResult> {
  let stdout: string;
  try {
    ({ stdout } = await exec('gh', ['pr', 'view', ref, '--json', PR_VIEW_FIELDS], { cwd }));
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
 * Resolve the PR to track for a session's worktree via the GitHub CLI. Tries the
 * worktree's *current* HEAD branch first (where the work and its PR actually live),
 * then the recorded `branch`, then `opts.knownPr` — a PR we already associate with
 * this session, asked for **by URL**.
 *
 * That last candidate is the only way to reach a PR the session opened *itself* on a
 * branch that isn't checked out here (`gh pr create` on a throwaway `feat/…` branch,
 * then back to the session branch): no branch name resolves it, so its state stayed
 * unknown forever and the list showed a bare `#<n>` with no glyph. It is tried *last*
 * so a newer PR on the session's own branch still wins.
 *
 * By URL and not by number, because a session can open a PR in **another repository**
 * (`gh pr create -R owner/other`) and PR numbers are per-repo: `gh pr view 42` run in
 * the worktree would answer with the *current* repo's #42 — a completely unrelated PR
 * to adopt, show a glyph for, and (if draft + green) flip to ready.
 *
 * Never throws. Distinguishes "no PR for this session" (`absent`) from "`gh`
 * couldn't tell us" (`unavailable`) — callers must keep the previously known PR in
 * the latter case, otherwise a rate limit or a dropped connection silently erases
 * the badge until the next successful poll.
 */
export async function lookupPr(
  cwd: string,
  branch: string,
  opts: PrLookupOptions = {},
  exec: ExecLike = execFileAsync,
): Promise<PrLookupResult> {
  const head = await currentBranch(cwd, exec);
  // De-dup: only fall through to the recorded branch when HEAD differs from it.
  const candidates = head && head !== branch ? [head, branch] : [branch];
  if (opts.knownPr) {
    candidates.push(opts.knownPr.url);
  }
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

/** Fields for the batched list — the PR view set plus the branch to match on. */
const PR_LIST_FIELDS = `headRefName,${PR_VIEW_FIELDS}`;

/** Bounds for `gh pr list --limit`: enough headroom to cover every session's PR. */
const PR_LIST_MIN_LIMIT = 30;
const PR_LIST_MAX_LIMIT = 100;

/** One `gh pr list` entry: a PR plus the branch it comes from. */
interface PrListEntry {
  branch: string;
  pr: PrInfo;
  /** Open PRs win over closed/merged ones for the same branch (as `gh pr view` does). */
  open: boolean;
}

function toListEntry(value: unknown): PrListEntry | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const json = value as PrViewJson & { headRefName?: unknown };
  const branch = typeof json.headRefName === 'string' ? json.headRefName : undefined;
  const pr = toPrJson(json);
  return branch && pr ? { branch, pr, open: json.state === 'OPEN' } : undefined;
}

/**
 * Index list entries by head branch. `gh pr list` is newest-first, so the first
 * entry for a branch wins — except that an open PR always beats a closed/merged one
 * (a branch reused after a closed PR must show the live one).
 */
function indexByBranch(entries: readonly PrListEntry[]): Map<string, PrListEntry> {
  const byBranch = new Map<string, PrListEntry>();
  for (const entry of entries) {
    const existing = byBranch.get(entry.branch);
    if (!existing || (entry.open && !existing.open)) {
      byBranch.set(entry.branch, entry);
    }
  }
  return byBranch;
}

/**
 * Look up many sessions' PRs with a **single** `gh pr list` instead of one
 * `gh pr view` per session, then match each session locally by its HEAD branch (or
 * its recorded `codiva/<slug>` branch).
 *
 * This is the fix for "N sessions × every 20s" API pressure: the cost stops scaling
 * with the number of open sessions. Every worktree of the repo resolves to the same
 * GitHub repo, so any session's worktree can host the one list call.
 *
 * Failure handling matches {@link lookupPr}: a failed list marks *every* target
 * `unavailable` (never `absent`), so no badge is cleared by a rate limit. A target
 * whose PR we already knew but that no branch in the page matches is verified with a
 * targeted view rather than declared gone — the page may have been truncated before
 * reaching it, or its head branch may be one this worktree doesn't have (a PR the
 * session opened itself), and neither means the PR disappeared.
 */
export async function lookupPrs(
  targets: readonly PrLookupTarget[],
  exec: ExecLike = execFileAsync,
): Promise<Map<string, PrLookupResult>> {
  const results = new Map<string, PrLookupResult>();
  const first = targets[0];
  if (!first) {
    return results;
  }
  const limit = Math.min(PR_LIST_MAX_LIMIT, Math.max(PR_LIST_MIN_LIMIT, targets.length * 3));
  let stdout: string;
  try {
    ({ stdout } = await exec(
      'gh',
      ['pr', 'list', '--state', 'all', '--limit', String(limit), '--json', PR_LIST_FIELDS],
      { cwd: first.cwd },
    ));
  } catch (err) {
    const reason = toUnavailableReason(errorText(err));
    for (const target of targets) {
      results.set(target.id, { kind: 'unavailable', reason });
    }
    return results;
  }
  let entries: PrListEntry[];
  try {
    const json: unknown = JSON.parse(stdout);
    const rows = Array.isArray(json) ? json : [];
    entries = rows.map(toListEntry).filter((e): e is PrListEntry => e !== undefined);
  } catch {
    for (const target of targets) {
      results.set(target.id, { kind: 'unavailable', reason: 'unknown' });
    }
    return results;
  }
  const byBranch = indexByBranch(entries);
  for (const target of targets) {
    // HEAD is where the work (and its PR) actually lives; the recorded branch is the
    // fallback. Both are local git reads — no API budget.
    const head = await currentBranch(target.cwd, exec);
    const match = (head ? byBranch.get(head) : undefined) ?? byBranch.get(target.branch);
    if (match) {
      results.set(target.id, { kind: 'found', pr: match.pr });
    } else if (target.knownPr) {
      // We know this session has a PR, and no branch in the page matched it: the page
      // may have been cut short, the PR's head branch may not be one we can see from
      // here (the session opened it on a branch it no longer has checked out), or the
      // PR may not even be in this repo. Ask about that PR itself (by URL, so a
      // same-numbered PR here can't stand in for it) instead of reporting it gone.
      results.set(
        target.id,
        await lookupPr(target.cwd, target.branch, { knownPr: target.knownPr }, exec),
      );
    } else {
      results.set(target.id, { kind: 'absent' });
    }
  }
  return results;
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
  const result = await lookupPr(cwd, branch, {}, exec);
  return result.kind === 'found' ? result.pr : undefined;
}

/**
 * Mark a draft PR ready for review (`gh pr ready`). Throws on failure.
 * `ref` is a branch name or a PR URL — the caller passes the **URL** of the PR it
 * actually looked up, which may live on a branch this worktree doesn't have (or in
 * another repo entirely, where a bare number would resolve to the wrong PR).
 */
export async function markPrReady(
  cwd: string,
  ref: string,
  exec: ExecLike = execFileAsync,
): Promise<void> {
  await exec('gh', ['pr', 'ready', ref], { cwd });
}
