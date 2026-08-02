import { execFile } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MergeConflictError } from '@/core';
import { uniqueSlug } from '@/core/slug';
import { WorktreeManager } from './worktree-manager';

const execFileAsync = promisify(execFile);
const g = (cwd: string, ...args: string[]) => execFileAsync('git', args, { cwd });

async function makeRepo(withCommit: boolean): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'codiva-wt-'));
  await g(dir, 'init', '-b', 'main');
  await g(dir, 'config', 'user.email', 'test@codiva.test');
  await g(dir, 'config', 'user.name', 'codiva test');
  if (withCommit) {
    await writeFile(join(dir, 'README.md'), '# test\n');
    await g(dir, 'add', '-A');
    await g(dir, 'commit', '-m', 'initial');
  }
  return dir;
}

describe('WorktreeManager', () => {
  let repo: string;

  afterEach(async () => {
    if (repo) {
      await rm(repo, { recursive: true, force: true });
    }
  });

  describe('preflight', () => {
    it('passes on a repo with a commit', async () => {
      repo = await makeRepo(true);
      await expect(new WorktreeManager(repo).preflight()).resolves.toBeUndefined();
    });

    it('fails on a repo with no commits', async () => {
      repo = await makeRepo(false);
      await expect(new WorktreeManager(repo).preflight()).rejects.toThrow(/no commits/);
    });

    it('fails outside a git repo', async () => {
      repo = await mkdtemp(join(tmpdir(), 'codiva-nogit-'));
      await expect(new WorktreeManager(repo).preflight()).rejects.toThrow(/not a git repository/);
    });
  });

  describe('lifecycle: add → diff → merge → remove', () => {
    beforeEach(async () => {
      repo = await makeRepo(true);
    });

    it('creates a worktree on a codiva/ branch and excludes .codiva', async () => {
      const wm = new WorktreeManager(repo);
      const wt = await wm.add('feature');
      expect(wt.branch).toBe('codiva/feature');
      expect(wt.path).toContain(join('.codiva', 'worktrees', 'feature'));
      const exclude = await readFile(join(repo, '.git', 'info', 'exclude'), 'utf8');
      expect(exclude).toContain('.codiva/');
    });

    it('reports committed and uncommitted changes via diffStat', async () => {
      const wm = new WorktreeManager(repo);
      const base = await wm.baseBranch();
      const wt = await wm.add('work');
      // committed change on the branch
      await writeFile(join(wt.path, 'a.txt'), 'hello\n');
      await g(wt.path, 'add', '-A');
      await g(wt.path, 'commit', '-m', 'add a');
      // uncommitted change
      await writeFile(join(wt.path, 'b.txt'), 'wip\n');

      const stat = await wm.diffStat(wt, base);
      expect(stat.committed).toContain('a.txt');
      expect(stat.uncommitted).toContain('b.txt');
    });

    it('merges the branch back into base', async () => {
      const wm = new WorktreeManager(repo);
      const base = await wm.baseBranch();
      const wt = await wm.add('mergeme');
      await writeFile(join(wt.path, 'feature.txt'), 'done\n');
      await g(wt.path, 'add', '-A');
      await g(wt.path, 'commit', '-m', 'feature');

      await wm.merge(wt, base);
      const merged = await readFile(join(repo, 'feature.txt'), 'utf8');
      expect(merged).toBe('done\n');
    });

    it('removes the worktree and deletes the branch', async () => {
      const wm = new WorktreeManager(repo);
      const wt = await wm.add('temp');
      await wm.remove(wt);
      const branches = await g(repo, 'branch', '--list', 'codiva/temp');
      expect(branches.stdout.trim()).toBe('');
    });

    it('force-removes a worktree with uncommitted changes', async () => {
      const wm = new WorktreeManager(repo);
      const wt = await wm.add('dirty');
      await writeFile(join(wt.path, 'scratch.txt'), 'uncommitted\n');
      await expect(wm.remove(wt)).rejects.toBeTruthy(); // plain remove refuses
      await expect(wm.remove(wt, { force: true })).resolves.toBeUndefined();
    });

    it('throws a clear error and aborts on merge conflict', async () => {
      const wm = new WorktreeManager(repo);
      const base = await wm.baseBranch();
      const wt = await wm.add('conflict');
      // diverge the same file on both branches
      await writeFile(join(wt.path, 'README.md'), '# branch change\n');
      await g(wt.path, 'add', '-A');
      await g(wt.path, 'commit', '-m', 'branch edit');
      await writeFile(join(repo, 'README.md'), '# base change\n');
      await g(repo, 'add', '-A');
      await g(repo, 'commit', '-m', 'base edit');

      await expect(wm.merge(wt, base)).rejects.toThrow(/conflict/i);
      // merge was aborted, so the base tree is clean again
      const status = await g(repo, 'status', '--porcelain');
      expect(status.stdout.trim()).toBe('');
    });

    it('throws a MergeConflictError carrying the conflicted files', async () => {
      const wm = new WorktreeManager(repo);
      const base = await wm.baseBranch();
      const wt = await wm.add('conflict-files');
      await writeFile(join(wt.path, 'README.md'), '# branch change\n');
      await g(wt.path, 'add', '-A');
      await g(wt.path, 'commit', '-m', 'branch edit');
      await writeFile(join(repo, 'README.md'), '# base change\n');
      await g(repo, 'add', '-A');
      await g(repo, 'commit', '-m', 'base edit');

      const err = await wm.merge(wt, base).catch((e) => e);
      expect(err).toBeInstanceOf(MergeConflictError);
      expect((err as MergeConflictError).files).toEqual(['README.md']);
    });
  });

  describe('origin follow + push', () => {
    let origin: string;

    afterEach(async () => {
      if (origin) {
        await rm(origin, { recursive: true, force: true });
      }
    });

    async function repoWithOrigin(): Promise<string> {
      const local = await makeRepo(true);
      origin = await mkdtemp(join(tmpdir(), 'codiva-origin-'));
      await g(origin, 'init', '--bare', '-b', 'main');
      await g(local, 'remote', 'add', 'origin', origin);
      await g(local, 'push', '-u', 'origin', 'main');
      return local;
    }

    it('returns origin/<base> after fetching when an upstream exists', async () => {
      repo = await repoWithOrigin();
      const wm = new WorktreeManager(repo);
      await expect(wm.syncedStartPoint('main')).resolves.toBe('origin/main');
    });

    it('returns undefined when there is no origin remote', async () => {
      repo = await makeRepo(true);
      const wm = new WorktreeManager(repo);
      await expect(wm.syncedStartPoint('main')).resolves.toBeUndefined();
    });

    it('branches a worktree from the given start point', async () => {
      repo = await repoWithOrigin();
      const wm = new WorktreeManager(repo);
      // advance origin/main beyond local main
      const clone = await mkdtemp(join(tmpdir(), 'codiva-clone-'));
      await g(clone, 'clone', origin, '.');
      await g(clone, 'config', 'user.email', 'test@codiva.test');
      await g(clone, 'config', 'user.name', 'codiva test');
      await writeFile(join(clone, 'upstream.txt'), 'ahead\n');
      await g(clone, 'add', '-A');
      await g(clone, 'commit', '-m', 'upstream commit');
      await g(clone, 'push', 'origin', 'main');
      await rm(clone, { recursive: true, force: true });

      const start = await wm.syncedStartPoint('main');
      const wt = await wm.add('follows', start);
      // the worktree includes the upstream-only file
      const contents = await readFile(join(wt.path, 'upstream.txt'), 'utf8');
      expect(contents).toBe('ahead\n');
    });

    it('pushes the session branch to origin', async () => {
      repo = await repoWithOrigin();
      const wm = new WorktreeManager(repo);
      const wt = await wm.add('pushme');
      await writeFile(join(wt.path, 'f.txt'), 'x\n');
      await g(wt.path, 'add', '-A');
      await g(wt.path, 'commit', '-m', 'work');
      await wm.pushBranch(wt);
      const remote = await g(repo, 'ls-remote', 'origin', 'codiva/pushme');
      expect(remote.stdout).toContain('codiva/pushme');
    });
  });

  describe('syncBase (take the base branch into the session branch)', () => {
    beforeEach(async () => {
      repo = await makeRepo(true);
    });

    /** Move the repo's `main` forward by one commit touching `file`. */
    async function advanceBase(file: string, body: string): Promise<void> {
      await writeFile(join(repo, file), body);
      await g(repo, 'add', '-A');
      await g(repo, 'commit', '-m', `base: ${file}`);
    }

    it('reports up-to-date when the branch already contains base', async () => {
      const wm = new WorktreeManager(repo);
      const wt = await wm.add('fresh');
      await expect(wm.syncBase(wt, 'main')).resolves.toEqual({ kind: 'upToDate' });
    });

    it('merges a moved-on base into the session branch', async () => {
      const wm = new WorktreeManager(repo);
      const wt = await wm.add('behind');
      await writeFile(join(wt.path, 'mine.txt'), 'mine\n');
      await g(wt.path, 'add', '-A');
      await g(wt.path, 'commit', '-m', 'session work');
      await advanceBase('theirs.txt', 'theirs\n');

      const result = await wm.syncBase(wt, 'main');
      expect(result).toEqual({ kind: 'updated', ref: 'main' });
      // Both sides are present afterwards: base was taken in, our work survived.
      await expect(readFile(join(wt.path, 'theirs.txt'), 'utf8')).resolves.toBe('theirs\n');
      await expect(readFile(join(wt.path, 'mine.txt'), 'utf8')).resolves.toBe('mine\n');
    });

    it('leaves the conflict in the worktree instead of aborting', async () => {
      const wm = new WorktreeManager(repo);
      const wt = await wm.add('clash');
      await writeFile(join(wt.path, 'shared.txt'), 'session side\n');
      await g(wt.path, 'add', '-A');
      await g(wt.path, 'commit', '-m', 'session edit');
      await advanceBase('shared.txt', 'base side\n');

      const result = await wm.syncBase(wt, 'main');
      expect(result).toEqual({ kind: 'conflict', ref: 'main', files: ['shared.txt'] });
      // The whole point: markers stay so the session can resolve them. `merge()`
      // aborts because it dirties the shared base tree; this one must not.
      const conflicted = await readFile(join(wt.path, 'shared.txt'), 'utf8');
      expect(conflicted).toContain('<<<<<<<');
      const unmerged = await g(wt.path, 'diff', '--name-only', '--diff-filter=U');
      expect(unmerged.stdout.trim()).toBe('shared.txt');
    });

    it('refuses to merge over uncommitted work and names it', async () => {
      const wm = new WorktreeManager(repo);
      const wt = await wm.add('busy');
      await advanceBase('theirs.txt', 'theirs\n');
      // A *tracked* file edited in place — this is what genuinely tangles with a merge.
      await writeFile(join(wt.path, 'README.md'), '# edited in the session\n');

      const result = await wm.syncBase(wt, 'main');
      expect(result).toEqual({ kind: 'dirty', files: ['README.md'] });
      // Nothing was merged — the base-only file is still absent.
      await expect(readFile(join(wt.path, 'theirs.txt'), 'utf8')).rejects.toThrow();
    });

    it('ignores untracked files: they never block a merge, so they must not cost a turn', async () => {
      const wm = new WorktreeManager(repo);
      const wt = await wm.add('scratch');
      await advanceBase('theirs.txt', 'theirs\n');
      // Agent scratch notes / an un-ignored build artifact / a leftover *.orig.
      await writeFile(join(wt.path, 'notes.txt'), 'scratch\n');

      const result = await wm.syncBase(wt, 'main');
      expect(result).toEqual({ kind: 'updated', ref: 'main' });
      await expect(readFile(join(wt.path, 'theirs.txt'), 'utf8')).resolves.toBe('theirs\n');
      // The untracked file survives the merge untouched.
      await expect(readFile(join(wt.path, 'notes.txt'), 'utf8')).resolves.toBe('scratch\n');
    });

    it('reports a worktree already left mid-merge as conflicted, not dirty', async () => {
      // Second `/sync` on a branch whose previous sync conflicted. The dirty gate
      // would otherwise fire (unmerged paths show in --porcelain) and the session
      // would be told to "commit or stash", which is impossible with MERGE_HEAD set.
      const wm = new WorktreeManager(repo);
      const wt = await wm.add('again');
      await writeFile(join(wt.path, 'shared.txt'), 'session side\n');
      await g(wt.path, 'add', '-A');
      await g(wt.path, 'commit', '-m', 'session edit');
      await advanceBase('shared.txt', 'base side\n');
      expect(await wm.syncBase(wt, 'main')).toMatchObject({ kind: 'conflict' });

      const again = await wm.syncBase(wt, 'main');
      expect(again).toEqual({ kind: 'conflict', ref: 'main', files: ['shared.txt'] });
    });

    it('refuses a detached HEAD instead of reporting a push that changes nothing', async () => {
      // The merge commit would land on HEAD, the branch ref would not move, the push
      // would be a no-op — and we would have claimed success while the PR stayed stuck.
      const wm = new WorktreeManager(repo);
      const wt = await wm.add('floating');
      await g(wt.path, 'checkout', '--detach');
      await advanceBase('theirs.txt', 'theirs\n');

      await expect(wm.syncBase(wt, 'main')).rejects.toThrow(/detached HEAD/);
    });
  });

  describe('linking/copying .gitignore-d files into a new worktree', () => {
    beforeEach(async () => {
      repo = await makeRepo(true);
      // ignore node_modules/ and .env, then leave them untracked on disk
      await writeFile(join(repo, '.gitignore'), 'node_modules/\n.env\n.codiva/\n.next/\ndist/\n');
      await g(repo, 'add', '.gitignore');
      await g(repo, 'commit', '-m', 'add gitignore');
      await mkdir(join(repo, 'node_modules', 'dep'), { recursive: true });
      await writeFile(join(repo, 'node_modules', 'dep', 'index.js'), 'module.exports = 1\n');
      await writeFile(join(repo, '.env'), 'SECRET=1\n');
      // ビルド生成物（開発サーバが書き込み続ける実体）も untracked で置いておく
      await mkdir(join(repo, '.next', 'cache'), { recursive: true });
      await writeFile(join(repo, '.next', 'cache', 'chunk.js'), '// built\n');
      await mkdir(join(repo, 'dist'), { recursive: true });
      await writeFile(join(repo, 'dist', 'index.js'), '// bundled\n');
    });

    it('symlinks ignored files/dirs to the repo root by default', async () => {
      const wm = new WorktreeManager(repo);
      const wt = await wm.add('with-ignored');
      // symlink なので実体はリポジトリルート側と共有される（読むと元の内容が見える）
      expect(await readFile(join(wt.path, '.env'), 'utf8')).toBe('SECRET=1\n');
      expect(await readFile(join(wt.path, 'node_modules', 'dep', 'index.js'), 'utf8')).toBe(
        'module.exports = 1\n',
      );
      expect((await lstat(join(wt.path, '.env'))).isSymbolicLink()).toBe(true);
      expect((await lstat(join(wt.path, 'node_modules'))).isSymbolicLink()).toBe(true);
    });

    it('copies real files (not symlinks) when ignoredFiles is "copy"', async () => {
      const wm = new WorktreeManager(repo, { ignoredFiles: 'copy' });
      const wt = await wm.add('copied');
      expect(await readFile(join(wt.path, '.env'), 'utf8')).toBe('SECRET=1\n');
      expect(await readFile(join(wt.path, 'node_modules', 'dep', 'index.js'), 'utf8')).toBe(
        'module.exports = 1\n',
      );
      expect((await lstat(join(wt.path, '.env'))).isSymbolicLink()).toBe(false);
      expect((await lstat(join(wt.path, 'node_modules'))).isSymbolicLink()).toBe(false);
    });

    it('copy mode keeps the worktree fully independent from the repo root', async () => {
      const wm = new WorktreeManager(repo, { ignoredFiles: 'copy' });
      const wt = await wm.add('independent');
      // worktree 側を書き換えても元へ波及しない（symlink との差）
      await writeFile(join(wt.path, '.env'), 'SECRET=changed\n');
      expect(await readFile(join(repo, '.env'), 'utf8')).toBe('SECRET=1\n');
    });

    it('does not link .codiva (would recurse into worktrees)', async () => {
      const wm = new WorktreeManager(repo);
      const wt = await wm.add('no-codiva');
      await expect(readFile(join(wt.path, '.codiva', 'state.json'), 'utf8')).rejects.toBeTruthy();
    });

    it('skips linking when ignoredFiles is "none"', async () => {
      const wm = new WorktreeManager(repo, { ignoredFiles: 'none' });
      const wt = await wm.add('bare');
      await expect(readFile(join(wt.path, '.env'), 'utf8')).rejects.toBeTruthy();
    });

    // issue #81: 生成物を共有すると、ルートで再帰監視している開発サーバから
    // 同じディレクトリが worktree の数だけ見えて変更通知が多重に跳ね返る。
    it.each([['symlink'], ['copy']] as const)(
      'never inherits build output/caches (%s mode)',
      async (mode) => {
        const wm = new WorktreeManager(repo, { ignoredFiles: mode });
        const wt = await wm.add(`no-artifacts-${mode}`);
        await expect(lstat(join(wt.path, '.next'))).rejects.toBeTruthy();
        await expect(lstat(join(wt.path, 'dist'))).rejects.toBeTruthy();
        // 依存・環境ファイルは従来どおり引き継ぐ
        expect(await readFile(join(wt.path, '.env'), 'utf8')).toBe('SECRET=1\n');
      },
    );

    it('lets ignoredFilesExclude negate a default exclude', async () => {
      const wm = new WorktreeManager(repo, { ignoredFilesExclude: ['!dist'] });
      const wt = await wm.add('keeps-dist');
      expect((await lstat(join(wt.path, 'dist'))).isSymbolicLink()).toBe(true);
      // 打ち消していない生成物は引き続き除外される
      await expect(lstat(join(wt.path, '.next'))).rejects.toBeTruthy();
    });

    // 以前のバージョンが張ったリンクは設定を変えても残るので、起動時に外す。
    it('prunes leftover links to now-excluded paths, keeping real dirs and wanted links', async () => {
      const wm = new WorktreeManager(repo);
      // 旧挙動を再現: 生成物へのリンクを手で張る
      const wt = await wm.add('legacy');
      await symlink(join(repo, '.next'), join(wt.path, '.next'), 'dir');
      // セッション自身が作った実体のビルド出力（消してはいけない）
      await mkdir(join(wt.path, 'dist'), { recursive: true });
      await writeFile(join(wt.path, 'dist', 'own.js'), '// mine\n');

      const removed = await wm.pruneExcludedLinks();

      expect(removed).toEqual([join(wt.path, '.next')]);
      await expect(lstat(join(wt.path, '.next'))).rejects.toBeTruthy();
      // リンク先（元リポジトリ）は無傷
      expect(await readFile(join(repo, '.next', 'cache', 'chunk.js'), 'utf8')).toBe('// built\n');
      // 実体のディレクトリと引き継ぎ対象のリンクは残す
      expect(await readFile(join(wt.path, 'dist', 'own.js'), 'utf8')).toBe('// mine\n');
      expect((await lstat(join(wt.path, 'node_modules'))).isSymbolicLink()).toBe(true);
    });

    it('prunes nothing when every ignored path is inherited', async () => {
      const wm = new WorktreeManager(repo, {
        ignoredFilesExclude: ['!.next', '!dist', '!coverage', '!target'],
      });
      await wm.add('keeps-all');
      await expect(wm.pruneExcludedLinks()).resolves.toEqual([]);
    });

    it('lets ignoredFilesExclude add a project-specific path', async () => {
      const wm = new WorktreeManager(repo, { ignoredFilesExclude: ['.env'] });
      const wt = await wm.add('no-env');
      await expect(lstat(join(wt.path, '.env'))).rejects.toBeTruthy();
      expect((await lstat(join(wt.path, 'node_modules'))).isSymbolicLink()).toBe(true);
    });
  });

  describe('slug collision handling', () => {
    it('avoids reusing an existing codiva branch slug', async () => {
      repo = await makeRepo(true);
      const wm = new WorktreeManager(repo);
      await wm.add('dup');
      const taken = await wm.takenSlugs();
      expect(taken.has('dup')).toBe(true);
      const next = uniqueSlug('dup', taken);
      expect(next).toBe('dup-2');
      const wt2 = await wm.add(next);
      expect(wt2.branch).toBe('codiva/dup-2');
    });
  });
});
