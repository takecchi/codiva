import { describe, expect, it, vi } from 'vitest';
import { type ExecLike, lookupPr } from './pr';

describe('lookupPr', () => {
  it('runs `gh pr view <branch> --json number,url,state,mergeable` and parses it', async () => {
    const exec = vi.fn<ExecLike>(async () => ({
      stdout: JSON.stringify({
        number: 7,
        url: 'https://github.com/o/r/pull/7',
        state: 'OPEN',
        mergeable: 'MERGEABLE',
      }),
    }));
    const pr = await lookupPr('/wt/a', 'codiva/feature', exec);
    expect(pr).toEqual({
      number: 7,
      url: 'https://github.com/o/r/pull/7',
      mergeStatus: 'mergeable',
    });
    expect(exec).toHaveBeenCalledWith(
      'gh',
      ['pr', 'view', 'codiva/feature', '--json', 'number,url,state,mergeable'],
      { cwd: '/wt/a' },
    );
  });

  it.each([
    { state: 'MERGED', mergeable: 'UNKNOWN', expected: 'merged' },
    { state: 'MERGED', mergeable: 'CONFLICTING', expected: 'merged' }, // state wins over stale mergeable
    { state: 'OPEN', mergeable: 'MERGEABLE', expected: 'mergeable' },
    { state: 'OPEN', mergeable: 'CONFLICTING', expected: 'conflicting' },
    { state: 'OPEN', mergeable: 'UNKNOWN', expected: 'unknown' },
    { state: 'CLOSED', mergeable: 'UNKNOWN', expected: 'unknown' },
  ] as const)('maps state=$state mergeable=$mergeable → $expected', async (c) => {
    const exec = vi.fn<ExecLike>(async () => ({
      stdout: JSON.stringify({
        number: 1,
        url: 'https://x/1',
        state: c.state,
        mergeable: c.mergeable,
      }),
    }));
    const pr = await lookupPr('/wt', 'codiva/x', exec);
    expect(pr?.mergeStatus).toBe(c.expected);
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
