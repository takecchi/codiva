import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { childProcessEnv } from './child-env';

const execFileAsync = promisify(execFile);

export class GitError extends Error {
  constructor(
    message: string,
    readonly args: string[],
    readonly stderr: string,
  ) {
    super(message);
    this.name = 'GitError';
  }
}

/**
 * Run a git command via execFile (never a shell — arguments are passed as an
 * array so user-derived strings can't be interpreted). Returns trimmed stdout.
 *
 * `env` は `childProcessEnv()`。git はフック（pre-push / post-merge …）を通して
 * ユーザーのビルドやテストを起こすので、codiva が立てた `NODE_ENV` を渡さない。
 */
export async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      maxBuffer: 32 * 1024 * 1024,
      env: childProcessEnv(),
    });
    return stdout.trim();
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    throw new GitError(
      `git ${args.join(' ')} failed: ${e.stderr?.trim() || e.message || 'unknown error'}`,
      args,
      e.stderr ?? '',
    );
  }
}
