import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { PrChecksState, PrInfo } from '@/core';

const execFileAsync = promisify(execFile);

/** execFile-shaped runner, injectable so PR helpers can be unit-tested without `gh`/`git`. */
export type ExecLike = (
  file: string,
  args: string[],
  opts: { cwd: string },
) => Promise<{ stdout: string }>;

/** Shape of the `gh pr view --json number,url,isDraft` payload we care about. */
interface PrViewJson {
  number?: unknown;
  url?: unknown;
  isDraft?: unknown;
}

function toPrInfo(stdout: string): PrInfo | undefined {
  const json = JSON.parse(stdout) as PrViewJson;
  const number = typeof json.number === 'number' ? json.number : undefined;
  const url = typeof json.url === 'string' ? json.url : undefined;
  if (number === undefined || url === undefined) {
    return undefined;
  }
  return typeof json.isDraft === 'boolean'
    ? { number, url, isDraft: json.isDraft }
    : { number, url };
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

async function viewPr(cwd: string, branch: string, exec: ExecLike): Promise<PrInfo | undefined> {
  try {
    const { stdout } = await exec('gh', ['pr', 'view', branch, '--json', 'number,url,isDraft'], {
      cwd,
    });
    return toPrInfo(stdout);
  } catch {
    return undefined;
  }
}

/**
 * Resolve the open PR for a session's worktree via the GitHub CLI, or undefined
 * when there is none. Tries the worktree's *current* HEAD branch first (where the
 * work and its PR actually live) and falls back to the recorded `branch`, so the
 * `#<n>` badge still shows when the session opened its PR from a branch other than
 * the original `codiva/<slug>` worktree branch.
 *
 * Best-effort: any failure (no PR, `gh`/`git` missing, not authenticated, offline,
 * malformed JSON) resolves to undefined rather than throwing, so PR detection never
 * disrupts a session. Args are passed as argv (never a shell string) so the branch
 * name can't be interpreted.
 */
export async function lookupPr(
  cwd: string,
  branch: string,
  exec: ExecLike = execFileAsync,
): Promise<PrInfo | undefined> {
  const head = await currentBranch(cwd, exec);
  // De-dup: only fall through to the recorded branch when HEAD differs from it.
  const candidates = head && head !== branch ? [head, branch] : [branch];
  for (const candidate of candidates) {
    const pr = await viewPr(cwd, candidate, exec);
    if (pr) {
      return pr;
    }
  }
  return undefined;
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
  return lookupPr(cwd, branch, exec);
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

function toChecksState(stdout: string): PrChecksState {
  const json = JSON.parse(stdout) as { statusCheckRollup?: unknown };
  const rollup = Array.isArray(json.statusCheckRollup)
    ? (json.statusCheckRollup as RollupCheck[])
    : [];
  if (rollup.length === 0) {
    return 'none';
  }
  if (rollup.some(isFailing)) {
    return 'failing';
  }
  if (rollup.some(isPending)) {
    return 'pending';
  }
  return 'passing';
}

/**
 * Aggregate CI state of `branch`'s PR from `gh pr view --json statusCheckRollup`.
 * Best-effort: any failure resolves to `none` (treated as "nothing to ready on").
 */
export async function prChecks(
  cwd: string,
  branch: string,
  exec: ExecLike = execFileAsync,
): Promise<PrChecksState> {
  try {
    const { stdout } = await exec('gh', ['pr', 'view', branch, '--json', 'statusCheckRollup'], {
      cwd,
    });
    return toChecksState(stdout);
  } catch {
    return 'none';
  }
}

/** Mark a draft PR ready for review (`gh pr ready`). Throws on failure. */
export async function markPrReady(
  cwd: string,
  branch: string,
  exec: ExecLike = execFileAsync,
): Promise<void> {
  await exec('gh', ['pr', 'ready', branch], { cwd });
}
