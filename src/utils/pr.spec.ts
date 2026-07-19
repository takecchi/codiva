import { describe, expect, it, vi } from 'vitest';
import { createPr, type ExecLike, lookupPr, markPrReady, prChecks } from './pr';

describe('lookupPr', () => {
  it('runs `gh pr view <branch> --json number,url,isDraft` in the worktree and parses it', async () => {
    const exec = vi.fn<ExecLike>(async () => ({
      stdout: JSON.stringify({ number: 7, url: 'https://github.com/o/r/pull/7', isDraft: true }),
    }));
    const pr = await lookupPr('/wt/a', 'codiva/feature', exec);
    expect(pr).toEqual({ number: 7, url: 'https://github.com/o/r/pull/7', isDraft: true });
    expect(exec).toHaveBeenCalledWith(
      'gh',
      ['pr', 'view', 'codiva/feature', '--json', 'number,url,isDraft'],
      { cwd: '/wt/a' },
    );
  });

  it('omits isDraft when the field is absent', async () => {
    const exec = vi.fn<ExecLike>(async () => ({
      stdout: JSON.stringify({ number: 7, url: 'https://github.com/o/r/pull/7' }),
    }));
    await expect(lookupPr('/wt/a', 'codiva/x', exec)).resolves.toEqual({
      number: 7,
      url: 'https://github.com/o/r/pull/7',
    });
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

describe('createPr', () => {
  it('opens a draft PR then returns the looked-up PR', async () => {
    const calls: string[][] = [];
    const exec = vi.fn<ExecLike>(async (_file, args) => {
      calls.push(args);
      if (args[1] === 'create') {
        return { stdout: 'https://github.com/o/r/pull/9\n' };
      }
      return {
        stdout: JSON.stringify({ number: 9, url: 'https://github.com/o/r/pull/9', isDraft: true }),
      };
    });
    const pr = await createPr('/wt/a', 'codiva/feature', exec);
    expect(pr).toEqual({ number: 9, url: 'https://github.com/o/r/pull/9', isDraft: true });
    expect(calls[0]).toEqual(['pr', 'create', '--draft', '--fill', '--head', 'codiva/feature']);
  });

  it('still returns the existing PR when create fails (already exists)', async () => {
    const exec = vi.fn<ExecLike>(async (_file, args) => {
      if (args[1] === 'create') {
        throw new Error('a pull request already exists');
      }
      return { stdout: JSON.stringify({ number: 4, url: 'u', isDraft: false }) };
    });
    await expect(createPr('/wt', 'codiva/x', exec)).resolves.toEqual({
      number: 4,
      url: 'u',
      isDraft: false,
    });
  });
});

describe('prChecks', () => {
  const rollup = (checks: unknown[]) =>
    vi.fn<ExecLike>(async () => ({ stdout: JSON.stringify({ statusCheckRollup: checks }) }));

  it('returns none when there are no checks', async () => {
    await expect(prChecks('/wt', 'b', rollup([]))).resolves.toBe('none');
  });

  it('returns passing when every check-run succeeded', async () => {
    const exec = rollup([{ status: 'COMPLETED', conclusion: 'SUCCESS' }, { state: 'SUCCESS' }]);
    await expect(prChecks('/wt', 'b', exec)).resolves.toBe('passing');
  });

  it('returns pending when a check is still running', async () => {
    const exec = rollup([
      { status: 'COMPLETED', conclusion: 'SUCCESS' },
      { status: 'IN_PROGRESS' },
    ]);
    await expect(prChecks('/wt', 'b', exec)).resolves.toBe('pending');
  });

  it('returns failing when any check failed (even if others pass/pend)', async () => {
    const exec = rollup([
      { status: 'IN_PROGRESS' },
      { status: 'COMPLETED', conclusion: 'FAILURE' },
    ]);
    await expect(prChecks('/wt', 'b', exec)).resolves.toBe('failing');
  });

  it('returns none on error rather than throwing', async () => {
    const exec = vi.fn<ExecLike>(async () => {
      throw new Error('no pr');
    });
    await expect(prChecks('/wt', 'b', exec)).resolves.toBe('none');
  });
});

describe('markPrReady', () => {
  it('runs `gh pr ready <branch>`', async () => {
    const exec = vi.fn<ExecLike>(async () => ({ stdout: '' }));
    await markPrReady('/wt', 'codiva/feature', exec);
    expect(exec).toHaveBeenCalledWith('gh', ['pr', 'ready', 'codiva/feature'], { cwd: '/wt' });
  });
});
