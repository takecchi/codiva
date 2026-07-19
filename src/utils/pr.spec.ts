import { describe, expect, it, vi } from 'vitest';
import { createPr, type ExecLike, lookupPr, markPrReady, prChecks } from './pr';

/** stdout for a minimal `gh pr view` payload (number,url only → mergeStatus 'unknown'). */
const ghPr = (number: number) =>
  JSON.stringify({ number, url: `https://github.com/o/r/pull/${number}` });

describe('lookupPr', () => {
  it('runs `gh pr view <branch> --json number,url,state,mergeable,isDraft` and parses it', async () => {
    const exec = vi.fn<ExecLike>(async (file) =>
      file === 'git'
        ? { stdout: 'codiva/feature\n' }
        : {
            stdout: JSON.stringify({
              number: 7,
              url: 'https://github.com/o/r/pull/7',
              state: 'OPEN',
              mergeable: 'MERGEABLE',
            }),
          },
    );
    const pr = await lookupPr('/wt/a', 'codiva/feature', exec);
    expect(pr).toEqual({
      number: 7,
      url: 'https://github.com/o/r/pull/7',
      mergeStatus: 'mergeable',
    });
    expect(exec).toHaveBeenCalledWith(
      'gh',
      ['pr', 'view', 'codiva/feature', '--json', 'number,url,state,mergeable,isDraft'],
      { cwd: '/wt/a' },
    );
  });

  it('parses isDraft from the pr view payload', async () => {
    const exec = vi.fn<ExecLike>(async (file) =>
      file === 'git'
        ? { stdout: 'codiva/feature\n' }
        : {
            stdout: JSON.stringify({
              number: 7,
              url: 'https://github.com/o/r/pull/7',
              isDraft: true,
            }),
          },
    );
    const pr = await lookupPr('/wt/a', 'codiva/feature', exec);
    expect(pr).toEqual({
      number: 7,
      url: 'https://github.com/o/r/pull/7',
      mergeStatus: 'unknown',
      isDraft: true,
    });
  });

  it.each([
    { state: 'MERGED', mergeable: 'UNKNOWN', expected: 'merged' },
    { state: 'MERGED', mergeable: 'CONFLICTING', expected: 'merged' }, // state wins over stale mergeable
    { state: 'OPEN', mergeable: 'MERGEABLE', expected: 'mergeable' },
    { state: 'OPEN', mergeable: 'CONFLICTING', expected: 'conflicting' },
    { state: 'OPEN', mergeable: 'UNKNOWN', expected: 'unknown' },
    { state: 'CLOSED', mergeable: 'UNKNOWN', expected: 'unknown' },
  ] as const)('maps state=$state mergeable=$mergeable → $expected', async (c) => {
    const exec = vi.fn<ExecLike>(async (file) =>
      file === 'git'
        ? { stdout: 'codiva/x\n' }
        : {
            stdout: JSON.stringify({
              number: 1,
              url: 'https://x/1',
              state: c.state,
              mergeable: c.mergeable,
            }),
          },
    );
    const pr = await lookupPr('/wt', 'codiva/x', exec);
    expect(pr?.mergeStatus).toBe(c.expected);
  });

  it('omits isDraft when the field is absent', async () => {
    const exec = vi.fn<ExecLike>(async (file) =>
      file === 'git'
        ? { stdout: 'codiva/x\n' }
        : { stdout: JSON.stringify({ number: 7, url: 'https://github.com/o/r/pull/7' }) },
    );
    await expect(lookupPr('/wt/a', 'codiva/x', exec)).resolves.toEqual({
      number: 7,
      url: 'https://github.com/o/r/pull/7',
      mergeStatus: 'unknown',
    });
  });

  it('looks the PR up by the worktree HEAD branch, not the recorded branch', async () => {
    // HEAD has moved to a fresh feat/ branch (git rules cut one before the PR),
    // so the PR lives there — not on the original codiva/<slug> worktree branch.
    const exec = vi.fn<ExecLike>(async (file) =>
      file === 'git' ? { stdout: 'feat/new-thing\n' } : { stdout: ghPr(7) },
    );
    const pr = await lookupPr('/wt/a', 'codiva/feature', exec);
    expect(pr).toEqual({
      number: 7,
      url: 'https://github.com/o/r/pull/7',
      mergeStatus: 'unknown',
    });
    expect(exec).toHaveBeenCalledWith('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: '/wt/a',
    });
    expect(exec).toHaveBeenCalledWith(
      'gh',
      ['pr', 'view', 'feat/new-thing', '--json', 'number,url,state,mergeable,isDraft'],
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
    expect(pr).toEqual({
      number: 5,
      url: 'https://github.com/o/r/pull/5',
      mergeStatus: 'unknown',
    });
    expect(exec).toHaveBeenCalledWith(
      'gh',
      ['pr', 'view', 'codiva/feature', '--json', 'number,url,state,mergeable,isDraft'],
      { cwd: '/wt' },
    );
  });

  it('queries only once when HEAD equals the recorded branch', async () => {
    const exec = vi.fn<ExecLike>(async (file) =>
      file === 'git' ? { stdout: 'codiva/feature\n' } : { stdout: ghPr(3) },
    );
    const pr = await lookupPr('/wt', 'codiva/feature', exec);
    expect(pr).toEqual({
      number: 3,
      url: 'https://github.com/o/r/pull/3',
      mergeStatus: 'unknown',
    });
    const ghCalls = exec.mock.calls.filter(([file]) => file === 'gh');
    expect(ghCalls).toHaveLength(1);
  });

  it('uses the recorded branch when HEAD cannot be resolved (git fails)', async () => {
    const exec = vi.fn<ExecLike>(async (file) => {
      if (file === 'git') throw new Error('fatal: not a git repository');
      return { stdout: ghPr(7) };
    });
    const pr = await lookupPr('/wt/a', 'codiva/feature', exec);
    expect(pr).toEqual({
      number: 7,
      url: 'https://github.com/o/r/pull/7',
      mergeStatus: 'unknown',
    });
    expect(exec).toHaveBeenCalledWith(
      'gh',
      ['pr', 'view', 'codiva/feature', '--json', 'number,url,state,mergeable,isDraft'],
      { cwd: '/wt/a' },
    );
  });

  it('treats a detached HEAD as unresolvable and uses the recorded branch', async () => {
    const exec = vi.fn<ExecLike>(async (file) =>
      file === 'git' ? { stdout: 'HEAD\n' } : { stdout: ghPr(9) },
    );
    const pr = await lookupPr('/wt', 'codiva/x', exec);
    expect(pr).toEqual({
      number: 9,
      url: 'https://github.com/o/r/pull/9',
      mergeStatus: 'unknown',
    });
    expect(exec).toHaveBeenCalledWith(
      'gh',
      ['pr', 'view', 'codiva/x', '--json', 'number,url,state,mergeable,isDraft'],
      { cwd: '/wt' },
    );
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
    expect(pr).toEqual({
      number: 9,
      url: 'https://github.com/o/r/pull/9',
      mergeStatus: 'unknown',
      isDraft: true,
    });
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
      mergeStatus: 'unknown',
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
