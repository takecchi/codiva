import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { PrInfo } from '@/core';

const execFileAsync = promisify(execFile);

/** execFile-shaped runner, injectable so lookupPr can be unit-tested without `gh`. */
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
 * Resolve the open PR for `branch` via the GitHub CLI, or undefined when there
 * is none. Best-effort: any failure (no PR, `gh` missing, not authenticated,
 * offline, malformed JSON) resolves to undefined rather than throwing, so PR
 * detection never disrupts a session. Args are passed as argv (never a shell
 * string) so the branch name can't be interpreted.
 */
export async function lookupPr(
  cwd: string,
  branch: string,
  exec: ExecLike = execFileAsync,
): Promise<PrInfo | undefined> {
  try {
    const { stdout } = await exec('gh', ['pr', 'view', branch, '--json', 'number,url'], { cwd });
    return toPrInfo(stdout);
  } catch {
    return undefined;
  }
}
