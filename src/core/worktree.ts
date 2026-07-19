import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { GitError, git } from '@/utils';

const CODIVA_DIR = '.codiva';
const WORKTREES_SUBDIR = join(CODIVA_DIR, 'worktrees');
const EXCLUDE_MARKER = '# codiva';

export interface Worktree {
  slug: string;
  branch: string;
  path: string;
}

/**
 * Thrown by `merge()` when the merge into base hit conflicts. The merge is
 * aborted before this throws (base tree is left clean), and `files` lists the
 * paths that conflicted so the UI can surface them (`status: 'conflict'`).
 */
export class MergeConflictError extends Error {
  constructor(
    readonly branch: string,
    readonly base: string,
    readonly files: string[],
  ) {
    super(`merge of ${branch} into ${base} hit conflicts; resolve manually in the worktree`);
    this.name = 'MergeConflictError';
  }
}

export interface DiffStat {
  /** `git diff --stat` summary against the base branch (committed changes). */
  committed: string;
  /** Paths with uncommitted changes in the worktree (porcelain). */
  uncommitted: string[];
}

/**
 * Creates and tears down git worktrees for sessions. Every worktree lives under
 * `.codiva/worktrees/<slug>` on branch `codiva/<slug>`, branched from the repo's
 * current HEAD. The repo's own files are never modified except a one-time
 * `.git/info/exclude` entry for `.codiva/`.
 */
export class WorktreeManager {
  constructor(private readonly repoRoot: string) {}

  /** The base branch worktrees are cut from and merged back into. */
  async baseBranch(): Promise<string> {
    return git(this.repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD']);
  }

  /**
   * Verify the repo can host worktrees: it must be a git repo with at least one
   * commit (you cannot branch from an empty HEAD).
   */
  async preflight(): Promise<void> {
    try {
      await git(this.repoRoot, ['rev-parse', '--is-inside-work-tree']);
    } catch {
      throw new Error(`${this.repoRoot} is not a git repository`);
    }
    try {
      await git(this.repoRoot, ['rev-parse', 'HEAD']);
    } catch {
      throw new Error(
        'the repository has no commits yet — make an initial commit before starting codiva',
      );
    }
  }

  /** Slugs already used by existing worktrees/branches, for collision avoidance. */
  async takenSlugs(): Promise<Set<string>> {
    const taken = new Set<string>();
    const list = await git(this.repoRoot, ['worktree', 'list', '--porcelain']).catch(() => '');
    for (const line of list.split('\n')) {
      if (line.startsWith('branch ') && line.includes('refs/heads/codiva/')) {
        taken.add(line.slice(line.lastIndexOf('/') + 1));
      }
    }
    const branches = await git(this.repoRoot, [
      'for-each-ref',
      '--format=%(refname:short)',
      'refs/heads/codiva',
    ]).catch(() => '');
    for (const b of branches.split('\n').filter(Boolean)) {
      taken.add(b.replace(/^codiva\//, ''));
    }
    return taken;
  }

  private async ensureExcluded(): Promise<void> {
    const excludePath = join(this.repoRoot, '.git', 'info', 'exclude');
    const current = await readFile(excludePath, 'utf8').catch(() => '');
    if (current.includes(EXCLUDE_MARKER)) {
      return;
    }
    const prefix = current.length > 0 && !current.endsWith('\n') ? '\n' : '';
    await appendFile(excludePath, `${prefix}${EXCLUDE_MARKER}\n${CODIVA_DIR}/\n`);
  }

  /**
   * Create a worktree for `slug` (assumed already unique) on a fresh branch.
   * When `startPoint` is given (e.g. `origin/main` from `syncedStartPoint`), the
   * branch is cut from there instead of the current HEAD — this is how
   * origin-follow starts work from the latest upstream commit.
   */
  async add(slug: string, startPoint?: string): Promise<Worktree> {
    await this.ensureExcluded();
    await mkdir(join(this.repoRoot, WORKTREES_SUBDIR), { recursive: true });
    const relPath = join(WORKTREES_SUBDIR, slug);
    const branch = `codiva/${slug}`;
    const args = ['worktree', 'add', relPath, '-b', branch];
    if (startPoint) {
      args.push(startPoint);
    }
    await git(this.repoRoot, args);
    return { slug, branch, path: join(this.repoRoot, relPath) };
  }

  /**
   * Fetch `origin/<base>` and return it as a branch start point, or undefined
   * when there is no usable upstream (no `origin` remote, offline, or the branch
   * doesn't exist there). Best-effort: callers fall back to the local HEAD.
   */
  async syncedStartPoint(base: string): Promise<string | undefined> {
    try {
      await git(this.repoRoot, ['fetch', 'origin', base]);
    } catch {
      return undefined; // no origin remote / offline / branch missing upstream
    }
    const ref = `origin/${base}`;
    try {
      await git(this.repoRoot, ['rev-parse', '--verify', '--quiet', ref]);
      return ref;
    } catch {
      return undefined;
    }
  }

  /** Push the session branch to origin (sets upstream). Throws on failure. */
  async pushBranch(wt: Worktree): Promise<void> {
    await git(wt.path, ['push', '-u', 'origin', wt.branch]);
  }

  /** Committed diff stat vs. the base branch plus any uncommitted paths. */
  async diffStat(wt: Worktree, base: string): Promise<DiffStat> {
    const committed = await git(wt.path, ['diff', '--stat', `${base}...HEAD`]).catch(() => '');
    const status = await git(wt.path, ['status', '--porcelain']).catch(() => '');
    const uncommitted = status
      .split('\n')
      .filter(Boolean)
      .map((l) => l.slice(3));
    return { committed, uncommitted };
  }

  /**
   * Merge the session branch into `base` (run from the main repo). On conflict
   * the merge is aborted (base tree stays clean) and a `MergeConflictError`
   * carrying the conflicted file paths is thrown; we never auto-resolve.
   */
  async merge(wt: Worktree, base: string): Promise<void> {
    await git(this.repoRoot, ['checkout', base]);
    try {
      await git(this.repoRoot, ['merge', '--no-ff', wt.branch]);
    } catch (err) {
      if (err instanceof GitError) {
        // Capture conflicted paths before aborting resets the index.
        const raw = await git(this.repoRoot, ['diff', '--name-only', '--diff-filter=U']).catch(
          () => '',
        );
        const files = raw.split('\n').filter(Boolean);
        await git(this.repoRoot, ['merge', '--abort']).catch(() => undefined);
        throw new MergeConflictError(wt.branch, base, files);
      }
      throw err;
    }
  }

  /** Remove the worktree and delete its branch. */
  async remove(wt: Worktree, opts: { force?: boolean } = {}): Promise<void> {
    const args = ['worktree', 'remove', wt.path];
    if (opts.force) {
      args.push('--force');
    }
    await git(this.repoRoot, args);
    await git(this.repoRoot, ['branch', '-D', wt.branch]).catch(() => undefined);
  }
}
