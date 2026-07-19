import { describe, expect, it, vi } from 'vitest';
import { type ExecLike, lookupPr } from './pr';

describe('lookupPr', () => {
  it('runs `gh pr view <branch> --json number,url` in the worktree and parses it', async () => {
    const exec = vi.fn<ExecLike>(async () => ({
      stdout: JSON.stringify({ number: 7, url: 'https://github.com/o/r/pull/7' }),
    }));
    const pr = await lookupPr('/wt/a', 'codiva/feature', exec);
    expect(pr).toEqual({ number: 7, url: 'https://github.com/o/r/pull/7' });
    expect(exec).toHaveBeenCalledWith(
      'gh',
      ['pr', 'view', 'codiva/feature', '--json', 'number,url'],
      { cwd: '/wt/a' },
    );
  });

  it('resolves undefined when there is no PR (gh exits non-zero → throws)', async () => {
    const exec = vi.fn<ExecLike>(async () => {
      throw new Error('no pull requests found for branch');
    });
    await expect(lookupPr('/wt', 'codiva/x', exec)).resolves.toBeUndefined();
  });

  it('resolves undefined on malformed / partial JSON', async () => {
    const exec = vi.fn<ExecLike>(async () => ({ stdout: '{ not json' }));
    await expect(lookupPr('/wt', 'codiva/x', exec)).resolves.toBeUndefined();
    const partial = vi.fn<ExecLike>(async () => ({ stdout: JSON.stringify({ number: 3 }) }));
    await expect(lookupPr('/wt', 'codiva/x', partial)).resolves.toBeUndefined();
  });
});
