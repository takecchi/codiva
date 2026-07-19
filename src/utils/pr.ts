import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { PrInfo } from '@/core';

const execFileAsync = promisify(execFile);

/** execFile-shaped runner, injectable so lookupPr can be unit-tested without `gh`/`git`. */
export type ExecLike = (
  file: string,
  args: string[],
  opts: { cwd: string },
) => Promise<{ stdout: string }>;

/** Shape of the `gh pr view --json number,url` payload we care about. */
interface PrViewJson {
  number?: unknown;
  url?: unknown;
}

function toPrInfo(stdout: string): PrInfo | undefined {
  const json = JSON.parse(stdout) as PrViewJson;
  const number = typeof json.number === 'number' ? json.number : undefined;
  const url = typeof json.url === 'string' ? json.url : undefined;
  return number === undefined || url === undefined ? undefined : { number, url };
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
    const { stdout } = await exec('gh', ['pr', 'view', branch, '--json', 'number,url'], { cwd });
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
