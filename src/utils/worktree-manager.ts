import {
  appendFile,
  cp,
  lstat,
  mkdir,
  readdir,
  readFile,
  rm,
  symlink,
  unlink,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  CODIVA_DIR,
  type DiffStat,
  excludedIgnoredEntries,
  type IgnoredFilesMode,
  ignoredCopyEntries,
  ignoredExcludePatterns,
  MergeConflictError,
  type Worktree,
  type WorktreeOptions,
} from '@/core';
import { GitError, git } from './git';

const WORKTREES_SUBDIR = join(CODIVA_DIR, 'worktrees');
const EXCLUDE_MARKER = '# codiva';

/**
 * Creates and tears down git worktrees for sessions. Every worktree lives under
 * `.codiva/worktrees/<slug>` on branch `codiva/<slug>`, branched from the repo's
 * current HEAD. The repo's own files are never modified except a one-time
 * `.git/info/exclude` entry for `.codiva/`.
 *
 * I/O ラッパ（fs + git 実行の具象）なので utils レイヤに置く。純粋な型・判定
 * （Worktree / DiffStat / MergeConflictError / ignoredCopyEntries）は core/worktree.ts。
 */
export class WorktreeManager {
  private readonly ignoredFiles: IgnoredFilesMode;
  /** 引き継ぎから除外するパターン（既定のビルド生成物 + 設定の追加分）。 */
  private readonly ignoredExcludes: readonly string[];

  constructor(
    private readonly repoRoot: string,
    options: WorktreeOptions = {},
  ) {
    this.ignoredFiles = options.ignoredFiles ?? 'symlink';
    this.ignoredExcludes = ignoredExcludePatterns(options.ignoredFilesExclude);
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
    const worktreePath = join(this.repoRoot, relPath);
    if (this.ignoredFiles !== 'none') {
      await this.linkIgnoredFiles(worktreePath);
    }
    return { slug, branch, path: worktreePath };
  }

  /**
   * `.gitignore` された未追跡ファイル（`node_modules/`・`.env` など）をリポジトリ
   * ルートから新しい worktree へ引き継ぐ。git worktree は追跡対象しか引き継がないため、
   * これがないとセッション側で依存の再インストールや環境変数の再設定が必要になる。
   *
   * モードで実体化方法を切り替える:
   * - `'symlink'`（既定）: 元へのシンボリックリンクを張るだけ（複製コストゼロ）。実体は
   *   共有されるため worktree 間で完全独立にはならない。
   * - `'copy'`: 実体を複製する。worktree 完全独立で作業が絶対に重複しない代わりに、
   *   `node_modules/` が巨大だとコピーが重い。
   *
   * どちらのモードでも、ビルド生成物・キャッシュ（`.next/` / `dist/` / `target/` など）は
   * 引き継がない（`DEFAULT_IGNORED_EXCLUDES`）。共有すると開発サーバ同士が同じ実体へ書き込み、
   * ルートで再帰監視している開発サーバからは同じディレクトリが worktree の数だけ見えて
   * フリーズし得るため（issue #81）。設定 `ignoredFilesExclude` で足す／打ち消せる。
   *
   * ベストエフォート: 個々の失敗（競合・権限等）は worktree 作成を巻き込まずスキップする
   * （環境ファイルが1つ欠けても致命ではない）。
   */
  private async linkIgnoredFiles(worktreePath: string): Promise<void> {
    const raw = await git(this.repoRoot, [
      'ls-files',
      '--others',
      '--ignored',
      '--exclude-standard',
      '--directory',
    ]).catch(() => '');
    for (const entry of ignoredCopyEntries(raw, this.ignoredExcludes)) {
      // `--directory` はディレクトリを末尾 `/` 付き（例 `node_modules/`）で返す。
      // path.join は末尾スラッシュを保持し、symlink はスラッシュ終端パスに ENOENT を返すため剥がす。
      const isDir = entry.endsWith('/');
      const rel = isDir ? entry.slice(0, -1) : entry;
      const from = join(this.repoRoot, rel);
      const to = join(worktreePath, rel);
      try {
        await mkdir(dirname(to), { recursive: true });
        if (this.ignoredFiles === 'symlink') {
          // 既存があると symlink は EEXIST になるので、cp の force 相当に合わせて消してから張る。
          // 型ヒント（Windows 用。POSIX では無視される）はエントリ末尾 `/` でディレクトリ判定。
          await rm(to, { recursive: true, force: true });
          await symlink(from, to, isDir ? 'dir' : 'file');
        } else {
          await cp(from, to, { recursive: true, force: true, errorOnExist: false });
        }
      } catch {
        // best-effort: 1エントリの失敗で worktree 作成全体を止めない
      }
    }
  }

  /**
   * 既存 worktree に残っている「もう引き継がないパス」へのリンクを外す（起動時に1回）。
   *
   * 除外リストを増やしても、以前のバージョンが張ったリンクは残り続ける。`.next` のような
   * 生成物のリンクが残っているとフリーズの原因もそのまま残るので（issue #81）、リンクだけを
   * 外して worktree 側を独立させる。安全のための制約:
   *
   * - **シンボリックリンクしか消さない**。実体のディレクトリはセッション自身のビルド結果で
   *   ありえるので絶対に触らない（リンクを消しても指し先＝元リポジトリの中身は無傷）。
   * - 対象は「いまの設定なら引き継がないエントリ」だけ（`excludedIgnoredEntries`）。worktree の
   *   中を走査しないので、数万ファイルのツリーでもコスト一定。
   * - ベストエフォート（失敗は黙って無視。起動を止めない）。
   */
  async pruneExcludedLinks(): Promise<string[]> {
    const raw = await git(this.repoRoot, [
      'ls-files',
      '--others',
      '--ignored',
      '--exclude-standard',
      '--directory',
    ]).catch(() => '');
    const excluded = excludedIgnoredEntries(raw, this.ignoredExcludes);
    if (excluded.length === 0) {
      return [];
    }
    const root = join(this.repoRoot, WORKTREES_SUBDIR);
    const dirs = await readdir(root, { withFileTypes: true }).catch(() => []);
    const removed: string[] = [];
    for (const dir of dirs) {
      if (!dir.isDirectory()) {
        continue;
      }
      for (const entry of excluded) {
        const path = join(root, dir.name, entry.replace(/\/$/, ''));
        const stat = await lstat(path).catch(() => undefined);
        if (!stat?.isSymbolicLink()) {
          continue;
        }
        try {
          await unlink(path);
          removed.push(path);
        } catch {
          // best-effort: 消せなくても起動は続ける
        }
      }
    }
    return removed;
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
