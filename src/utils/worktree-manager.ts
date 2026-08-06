import { cp, lstat, mkdir, readdir, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  CODIVA_DIR,
  type DiffStat,
  excludedIgnoredEntries,
  type IgnoredFilesMode,
  ignoredCopyEntries,
  ignoredExcludePatterns,
  MergeConflictError,
  type SyncBaseResult,
  type Worktree,
  type WorktreeOptions,
} from '@/core';
import { GitError, git } from './git';

const WORKTREES_SUBDIR = join(CODIVA_DIR, 'worktrees');
/**
 * `.codiva/.gitignore` の中身。`*` は同じディレクトリにある `.gitignore` 自身にも
 * 一致するので、この 1 行だけで `.codiva/` が丸ごと（この除外ファイルごと）git から
 * 見えなくなる（cargo が `target/.gitignore` でやっているのと同じ手）。
 */
const SELF_IGNORE = '*\n';

/**
 * Paths out of `git status --porcelain` output.
 *
 * Not a fixed `slice(3)`: `git()` trims the whole stdout, so the *first* line loses
 * its leading space whenever the index half of the two-letter XY code is blank
 * (` M file` arrives as `M file`) and a fixed slice eats the first character of the
 * filename. Strip the code and its separator instead.
 */
function porcelainPaths(raw: string): string[] {
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^\S{1,2}\s+/, ''));
}

/**
 * Creates and tears down git worktrees for sessions. Every worktree lives under
 * `.codiva/worktrees/<slug>` on branch `codiva/<slug>`, branched from the repo's
 * current HEAD. The repo's own files are never modified — the only thing codiva
 * writes outside its worktrees is `.codiva/.gitignore` (a single `*`), which hides
 * `.codiva/` from git without touching the repo's `.gitignore` or git internals.
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
   * 表示用の現在ブランチ（ヘッダに出す）。**`baseBranch()` とは返り値の契約が違う**:
   * detached HEAD では `symbolic-ref` が失敗するので undefined を返す（`rev-parse
   * --abbrev-ref` の `'HEAD'` という文字列をそのままヘッダに出すと「HEAD という
   * ブランチ」に見える）。git の呼び出し自体が失敗したときも undefined —
   * 表示のためだけの問い合わせなので、失敗して表示が消えるだけに留める。
   */
  async currentBranch(): Promise<string | undefined> {
    return git(this.repoRoot, ['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(
      () => undefined,
    );
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

  /**
   * `.codiva/` を git から隠す。作業ツリー側に `.codiva/.gitignore`（中身は `*`）を置くだけで、
   * 除外ファイル自身を含むディレクトリ全体が ignore される（`SELF_IGNORE` 参照）。
   *
   * かつては `.git/info/exclude` へ `.codiva/` を追記していたが、**`.git` はディレクトリとは
   * 限らない**（linked worktree や submodule では `gitdir:` を書いたただのファイル）。そこで
   * codiva を起動すると追記が ENOTDIR で失敗し、握り潰していなかったため worktree 作成ごと
   * 失敗していた。作業ツリー側のファイルなら git の内部配置に依存せず、対象リポジトリの
   * `.gitignore` も汚さない（`.codiva/` の中は codiva の持ち物）。
   *
   * 既にファイルがあれば触らない（利用者が例外パターンを足しているかもしれない）。
   * 呼び出し側は失敗を握り潰す — 除外はあくまで気遣いで、セッションの動作には要らない。
   */
  async ensureIgnored(): Promise<void> {
    const path = join(this.repoRoot, CODIVA_DIR, '.gitignore');
    const exists = await stat(path).then(
      () => true,
      () => false,
    );
    if (exists) {
      return;
    }
    await mkdir(join(this.repoRoot, CODIVA_DIR), { recursive: true });
    await writeFile(path, SELF_IGNORE);
  }

  /**
   * Create a worktree for `slug` (assumed already unique) on a fresh branch.
   * When `startPoint` is given (e.g. `origin/main` from `syncedStartPoint`), the
   * branch is cut from there instead of the current HEAD — this is how
   * origin-follow starts work from the latest upstream commit.
   */
  async add(slug: string, startPoint?: string): Promise<Worktree> {
    await this.ensureIgnored().catch(() => undefined);
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

  /**
   * Take the base branch *into* the session's branch — the opposite direction from
   * {@link merge}, and run inside the worktree rather than the repo root. This is
   * what un-sticks a PR that GitHub reports as `CONFLICTING` because base moved on.
   *
   * Prefers the freshly fetched `origin/<base>` and falls back to the local base
   * ref when there is no usable upstream (no remote / offline), so it still works
   * on a repo that was never pushed.
   *
   * Two deliberate departures from {@link merge}:
   *  - A worktree with uncommitted changes is left completely alone (`dirty`).
   *    Merging over an agent's work in progress tangles the two beyond repair.
   *  - A conflict is **not** aborted. The worktree belongs to exactly one session,
   *    so leaving the markers in place is what lets that session resolve them; the
   *    "never auto-resolve" rule is about `-X ours`-style silent resolution, which
   *    this still doesn't do.
   */
  async syncBase(wt: Worktree, base: string): Promise<SyncBaseResult> {
    // A detached HEAD would take the merge commit and leave the *branch* ref where
    // it was, so the push would be a no-op and the PR would never change — while we
    // happily reported success. Refuse instead of lying.
    await git(wt.path, ['symbolic-ref', '--quiet', 'HEAD']).catch(() => {
      throw new Error(`${wt.path} has a detached HEAD; check out ${wt.branch} first`);
    });
    // Already mid-merge (a previous syncBase conflicted and we left the markers in
    // place). Report that rather than falling through to the dirty branch below: git
    // would refuse the merge anyway, and "commit or stash your work" is impossible
    // advice with unmerged paths in the index.
    const merging = await git(wt.path, ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'])
      .then(() => true)
      .catch(() => false);
    if (merging) {
      return { kind: 'conflict', ref: base, files: await this.unmergedFiles(wt) };
    }
    // `--untracked-files=no`: a stray untracked file (agent scratch notes, an
    // un-ignored build artifact, a leftover *.orig) does not block `git merge`, so
    // treating it as "dirty" would give up the free deterministic path and spend a
    // turn asking the session to tidy up a file it may not even own.
    const status = await git(wt.path, ['status', '--porcelain', '--untracked-files=no']).catch(
      () => '',
    );
    const dirty = porcelainPaths(status);
    if (dirty.length > 0) {
      return { kind: 'dirty', files: dirty };
    }
    // Fetch is best-effort: an offline run should still be able to merge whatever
    // the local base ref already points at.
    const ref = (await this.syncedStartPoint(base).catch(() => undefined)) ?? base;
    // Already contains the base tip → nothing to do (and no empty merge commit).
    const contained = await git(wt.path, ['merge-base', '--is-ancestor', ref, 'HEAD'])
      .then(() => true)
      .catch(() => false);
    if (contained) {
      return { kind: 'upToDate' };
    }
    try {
      await git(wt.path, ['merge', '--no-edit', ref]);
      return { kind: 'updated', ref };
    } catch (err) {
      if (err instanceof GitError) {
        const files = await this.unmergedFiles(wt);
        if (files.length > 0) {
          return { kind: 'conflict', ref, files };
        }
      }
      // A merge that failed without conflicted paths isn't something the session can
      // resolve (bad ref, hook rejection, …) — surface it instead of pretending.
      throw err;
    }
  }

  /** Paths git currently reports as unmerged in `wt` (empty when not conflicted). */
  private async unmergedFiles(wt: Worktree): Promise<string[]> {
    const raw = await git(wt.path, ['diff', '--name-only', '--diff-filter=U']).catch(() => '');
    return raw.split('\n').filter(Boolean);
  }

  /** Committed diff stat vs. the base branch plus any uncommitted paths. */
  async diffStat(wt: Worktree, base: string): Promise<DiffStat> {
    const committed = await git(wt.path, ['diff', '--stat', `${base}...HEAD`]).catch(() => '');
    const status = await git(wt.path, ['status', '--porcelain']).catch(() => '');
    return { committed, uncommitted: porcelainPaths(status) };
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
