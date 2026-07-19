import { describe, expect, it, vi } from 'vitest';
import { type ExecLike, lookupPr } from './pr';

/** stdout for the `gh pr view --json number,url` call. */
const ghPr = (number: number) =>
  JSON.stringify({ number, url: `https://github.com/o/r/pull/${number}` });

describe('lookupPr', () => {
  it('looks the PR up by the worktree HEAD branch, not the recorded branch', async () => {
    // HEAD has moved to a fresh feat/ branch (git rules cut one before the PR),
    // so the PR lives there — not on the original codiva/<slug> worktree branch.
    const exec = vi.fn<ExecLike>(async (file) =>
      file === 'git' ? { stdout: 'feat/new-thing\n' } : { stdout: ghPr(7) },
    );
    const pr = await lookupPr('/wt/a', 'codiva/feature', exec);
    expect(pr).toEqual({ number: 7, url: 'https://github.com/o/r/pull/7' });
    expect(exec).toHaveBeenCalledWith('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: '/wt/a',
    });
    expect(exec).toHaveBeenCalledWith(
      'gh',
      ['pr', 'view', 'feat/new-thing', '--json', 'number,url'],
      { cwd: '/wt/a' },
    );
  });

  it('falls back to the recorded branch when HEAD has no PR', async () => {
    const exec = vi.fn<ExecLike>(async (file, args) => {
      if (file === 'git') return { stdout: 'feat/new-thing\n' };
      if (args[2] === 'feat/new-thing') throw new Error('no pull requests found for branch');
      return { stdout: ghPr(5) };
    });
    const pr = await lookupPr('/wt', 'codiva/feature', exec);
    expect(pr).toEqual({ number: 5, url: 'https://github.com/o/r/pull/5' });
    expect(exec).toHaveBeenCalledWith(
      'gh',
      ['pr', 'view', 'codiva/feature', '--json', 'number,url'],
      { cwd: '/wt' },
    );
  });

  it('queries only once when HEAD equals the recorded branch', async () => {
    const exec = vi.fn<ExecLike>(async (file) =>
      file === 'git' ? { stdout: 'codiva/feature\n' } : { stdout: ghPr(3) },
    );
    const pr = await lookupPr('/wt', 'codiva/feature', exec);
    expect(pr).toEqual({ number: 3, url: 'https://github.com/o/r/pull/3' });
    const ghCalls = exec.mock.calls.filter(([file]) => file === 'gh');
    expect(ghCalls).toHaveLength(1);
  });

  it('uses the recorded branch when HEAD cannot be resolved (git fails)', async () => {
    const exec = vi.fn<ExecLike>(async (file) => {
      if (file === 'git') throw new Error('fatal: not a git repository');
      return { stdout: ghPr(7) };
    });
    const pr = await lookupPr('/wt/a', 'codiva/feature', exec);
    expect(pr).toEqual({ number: 7, url: 'https://github.com/o/r/pull/7' });
    expect(exec).toHaveBeenCalledWith(
      'gh',
      ['pr', 'view', 'codiva/feature', '--json', 'number,url'],
      { cwd: '/wt/a' },
    );
  });

  it('treats a detached HEAD as unresolvable and uses the recorded branch', async () => {
    const exec = vi.fn<ExecLike>(async (file) =>
      file === 'git' ? { stdout: 'HEAD\n' } : { stdout: ghPr(9) },
    );
    const pr = await lookupPr('/wt', 'codiva/x', exec);
    expect(pr).toEqual({ number: 9, url: 'https://github.com/o/r/pull/9' });
    expect(exec).toHaveBeenCalledWith('gh', ['pr', 'view', 'codiva/x', '--json', 'number,url'], {
      cwd: '/wt',
    });
  });

  it('resolves undefined when no candidate branch has a PR', async () => {
    const exec = vi.fn<ExecLike>(async (file) => {
      if (file === 'git') return { stdout: 'feat/x\n' };
      throw new Error('no pull requests found for branch');
    });
    await expect(lookupPr('/wt', 'codiva/x', exec)).resolves.toBeUndefined();
  });

  it('resolves undefined on malformed / partial JSON', async () => {
    const bad = vi.fn<ExecLike>(async (file) =>
      file === 'git' ? { stdout: 'codiva/x\n' } : { stdout: '{ not json' },
    );
    await expect(lookupPr('/wt', 'codiva/x', bad)).resolves.toBeUndefined();

    const partial = vi.fn<ExecLike>(async (file) =>
      file === 'git' ? { stdout: 'codiva/x\n' } : { stdout: JSON.stringify({ number: 3 }) },
    );
    await expect(lookupPr('/wt', 'codiva/x', partial)).resolves.toBeUndefined();
  });
});
