import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { uniqueSlug } from '@/core/slug';
import { WorktreeManager } from '@/core/worktree';

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
