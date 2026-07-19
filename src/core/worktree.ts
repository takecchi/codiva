import { appendFile, cp, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { GitError, git } from '@/utils';

const CODIVA_DIR = '.codiva';
const WORKTREES_SUBDIR = join(CODIVA_DIR, 'worktrees');
const EXCLUDE_MARKER = '# codiva';

/**
 * `git worktree add` が引き継ぐのは追跡対象ファイルだけなので、`.gitignore` された
 * `node_modules/` や `.env` などは新しい worktree に現れない。これらをリポジトリ
 * ルートから複製すると、セッションが即座にビルド/実行できる（依存や環境変数を
 * 手で用意し直さなくてよい）。既定で有効。
 */
export interface WorktreeOptions {
  /** `.gitignore` された未追跡ファイルを新しい worktree へコピーするか。未設定は true。 */
  copyIgnored?: boolean;
}

export interface Worktree {
  slug: string;
  branch: string;
  path: string;
}

export interface DiffStat {
  /** `git diff --stat` summary against the base branch (committed changes). */
  committed: string;
  /** Paths with uncommitted changes in the worktree (porcelain). */
  uncommitted: string[];
}

/**
 * `git ls-files --others --ignored --exclude-standard --directory` の生出力から、
 * 新しい worktree へコピーすべき ignore 済みエントリだけを取り出す純関数。
 *
 * `--directory` によりディレクトリ全体が ignore されている場合は末尾 `/` 付きの
 * 1エントリに畳まれる（`node_modules/` を数万ファイル列挙せずに済む）。codiva 自身の
 * 作業ディレクトリ（`.codiva/`）と `.git` は、worktree 群を再帰コピーしたり内部状態を
 * 壊したりするため必ず除外する。
 */
export function ignoredCopyEntries(raw: string): string[] {
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((entry) => {
      const normalized = entry.replace(/\/$/, '');
      return normalized !== CODIVA_DIR && normalized !== '.git';
    });
}

/**
 * Creates and tears down git worktrees for sessions. Every worktree lives under
 * `.codiva/worktrees/<slug>` on branch `codiva/<slug>`, branched from the repo's
 * current HEAD. The repo's own files are never modified except a one-time
 * `.git/info/exclude` entry for `.codiva/`.
 */
export class WorktreeManager {
  private readonly copyIgnored: boolean;

  constructor(
    private readonly repoRoot: string,
    options: WorktreeOptions = {},
  ) {
    this.copyIgnored = options.copyIgnored !== false;
  }

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

  /** Create a worktree for `slug` (assumed already unique) on a fresh branch. */
  async add(slug: string): Promise<Worktree> {
    await this.ensureExcluded();
    await mkdir(join(this.repoRoot, WORKTREES_SUBDIR), { recursive: true });
    const relPath = join(WORKTREES_SUBDIR, slug);
    const branch = `codiva/${slug}`;
    await git(this.repoRoot, ['worktree', 'add', relPath, '-b', branch]);
    const worktreePath = join(this.repoRoot, relPath);
    if (this.copyIgnored) {
      await this.copyIgnoredFiles(worktreePath);
    }
    return { slug, branch, path: worktreePath };
  }

  /**
   * `.gitignore` された未追跡ファイル（`node_modules/`・`.env` など）をリポジトリ
   * ルートから新しい worktree へ複製する。git worktree は追跡対象しか引き継がないため、
   * これがないとセッション側で依存の再インストールや環境変数の再設定が必要になる。
   *
   * ベストエフォート: 個々のコピー失敗（競合・権限等）は worktree 作成を巻き込まず
   * スキップする（環境ファイルが1つ欠けても致命ではない）。
   */
  private async copyIgnoredFiles(worktreePath: string): Promise<void> {
    const raw = await git(this.repoRoot, [
      'ls-files',
      '--others',
      '--ignored',
      '--exclude-standard',
      '--directory',
    ]).catch(() => '');
    for (const entry of ignoredCopyEntries(raw)) {
      const from = join(this.repoRoot, entry);
      const to = join(worktreePath, entry);
      try {
        await mkdir(dirname(to), { recursive: true });
        await cp(from, to, { recursive: true, force: true, errorOnExist: false });
      } catch {
        // best-effort: 1エントリの失敗で worktree 作成全体を止めない
      }
    }
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

  /** Merge the session branch into `base` (run from the main repo). Throws on conflict. */
  async merge(wt: Worktree, base: string): Promise<void> {
    await git(this.repoRoot, ['checkout', base]);
    try {
      await git(this.repoRoot, ['merge', '--no-ff', wt.branch]);
    } catch (err) {
      if (err instanceof GitError) {
        await git(this.repoRoot, ['merge', '--abort']).catch(() => undefined);
        throw new Error(
          `merge of ${wt.branch} into ${base} hit conflicts; resolve manually in the worktree`,
        );
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
