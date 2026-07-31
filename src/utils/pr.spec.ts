import { describe, expect, it, vi } from 'vitest';
import type { PrUnavailableReason } from '@/core';
import { createPr, type ExecLike, lookupPr, markPrReady } from './pr';

const FIELDS = 'number,url,state,mergeable,isDraft,statusCheckRollup';

/** stdout for a minimal `gh pr view` payload (number,url only → mergeStatus 'unknown'). */
const ghPr = (number: number) =>
  JSON.stringify({ number, url: `https://github.com/o/r/pull/${number}` });

/** An execFile-style rejection: `gh` exits non-zero and writes to stderr. */
function ghError(stderr: string): Error & { stderr: string; code?: string | number } {
  return Object.assign(new Error(`Command failed: gh\n${stderr}`), { stderr, code: 1 });
}

const NO_PR = 'no pull requests found for branch "codiva/x"';

describe('lookupPr', () => {
  it('runs one `gh pr view` with every field and parses it', async () => {
    const exec = vi.fn<ExecLike>(async (file) =>
      file === 'git'
        ? { stdout: 'codiva/feature\n' }
        : {
            stdout: JSON.stringify({
              number: 7,
              url: 'https://github.com/o/r/pull/7',
              state: 'OPEN',
              mergeable: 'MERGEABLE',
              statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }],
            }),
          },
    );
    await expect(lookupPr('/wt/a', 'codiva/feature', exec)).resolves.toEqual({
      kind: 'found',
      pr: {
        number: 7,
        url: 'https://github.com/o/r/pull/7',
        mergeStatus: 'mergeable',
        checks: 'passing',
      },
    });
    expect(exec).toHaveBeenCalledWith('gh', ['pr', 'view', 'codiva/feature', '--json', FIELDS], {
      cwd: '/wt/a',
    });
    // Checks ride along in the PR view — never a second `gh` round-trip.
    expect(exec.mock.calls.filter(([file]) => file === 'gh')).toHaveLength(1);
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
    await expect(lookupPr('/wt/a', 'codiva/feature', exec)).resolves.toEqual({
      kind: 'found',
      pr: {
        number: 7,
        url: 'https://github.com/o/r/pull/7',
        mergeStatus: 'unknown',
        checks: 'none',
        isDraft: true,
      },
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
    const result = await lookupPr('/wt', 'codiva/x', exec);
    expect(result.kind === 'found' && result.pr.mergeStatus).toBe(c.expected);
  });

  it.each([
    { rollup: [], expected: 'none', label: 'no checks configured' },
    {
      rollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }, { state: 'SUCCESS' }],
      expected: 'passing',
      label: 'every check succeeded',
    },
    {
      rollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }, { status: 'IN_PROGRESS' }],
      expected: 'pending',
      label: 'a check is still running',
    },
    {
      rollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }, { state: 'PENDING' }],
      expected: 'pending',
      label: 'a legacy status is pending',
    },
    {
      rollup: [{ status: 'IN_PROGRESS' }, { status: 'COMPLETED', conclusion: 'FAILURE' }],
      expected: 'failing',
      label: 'any check failed (even if others pend)',
    },
    {
      rollup: 'not-an-array',
      expected: 'none',
      label: 'the rollup is not an array',
    },
  ] as const)('aggregates checks → $expected when $label', async (c) => {
    const exec = vi.fn<ExecLike>(async (file) =>
      file === 'git'
        ? { stdout: 'codiva/x\n' }
        : { stdout: JSON.stringify({ number: 1, url: 'u', statusCheckRollup: c.rollup }) },
    );
    const result = await lookupPr('/wt', 'codiva/x', exec);
    expect(result.kind === 'found' && result.pr.checks).toBe(c.expected);
  });

  it('looks the PR up by the worktree HEAD branch, not the recorded branch', async () => {
    // HEAD has moved to a fresh feat/ branch (git rules cut one before the PR),
    // so the PR lives there — not on the original codiva/<slug> worktree branch.
    const exec = vi.fn<ExecLike>(async (file) =>
      file === 'git' ? { stdout: 'feat/new-thing\n' } : { stdout: ghPr(7) },
    );
    const result = await lookupPr('/wt/a', 'codiva/feature', exec);
    expect(result.kind === 'found' && result.pr.number).toBe(7);
    expect(exec).toHaveBeenCalledWith('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: '/wt/a',
    });
    expect(exec).toHaveBeenCalledWith('gh', ['pr', 'view', 'feat/new-thing', '--json', FIELDS], {
      cwd: '/wt/a',
    });
  });

  it('falls back to the recorded branch when HEAD has no PR', async () => {
    const exec = vi.fn<ExecLike>(async (file, args) => {
      if (file === 'git') return { stdout: 'feat/new-thing\n' };
      if (args[2] === 'feat/new-thing') throw ghError(NO_PR);
      return { stdout: ghPr(5) };
    });
    const result = await lookupPr('/wt', 'codiva/feature', exec);
    expect(result.kind === 'found' && result.pr.number).toBe(5);
    expect(exec).toHaveBeenCalledWith('gh', ['pr', 'view', 'codiva/feature', '--json', FIELDS], {
      cwd: '/wt',
    });
  });

  it('queries only once when HEAD equals the recorded branch', async () => {
    const exec = vi.fn<ExecLike>(async (file) =>
      file === 'git' ? { stdout: 'codiva/feature\n' } : { stdout: ghPr(3) },
    );
    const result = await lookupPr('/wt', 'codiva/feature', exec);
    expect(result.kind === 'found' && result.pr.number).toBe(3);
    expect(exec.mock.calls.filter(([file]) => file === 'gh')).toHaveLength(1);
  });

  it('uses the recorded branch when HEAD cannot be resolved (git fails)', async () => {
    const exec = vi.fn<ExecLike>(async (file) => {
      if (file === 'git') throw new Error('fatal: not a git repository');
      return { stdout: ghPr(7) };
    });
    const result = await lookupPr('/wt/a', 'codiva/feature', exec);
    expect(result.kind === 'found' && result.pr.number).toBe(7);
    expect(exec).toHaveBeenCalledWith('gh', ['pr', 'view', 'codiva/feature', '--json', FIELDS], {
      cwd: '/wt/a',
    });
  });

  it('treats a detached HEAD as unresolvable and uses the recorded branch', async () => {
    const exec = vi.fn<ExecLike>(async (file) =>
      file === 'git' ? { stdout: 'HEAD\n' } : { stdout: ghPr(9) },
    );
    const result = await lookupPr('/wt', 'codiva/x', exec);
    expect(result.kind === 'found' && result.pr.number).toBe(9);
    expect(exec).toHaveBeenCalledWith('gh', ['pr', 'view', 'codiva/x', '--json', FIELDS], {
      cwd: '/wt',
    });
  });

  it('reports `absent` when `gh` says no candidate branch has a PR', async () => {
    const exec = vi.fn<ExecLike>(async (file) => {
      if (file === 'git') return { stdout: 'feat/x\n' };
      throw ghError(NO_PR);
    });
    await expect(lookupPr('/wt', 'codiva/x', exec)).resolves.toEqual({ kind: 'absent' });
  });

  // The whole point of the three-way result: a failure must never masquerade as
  // "this branch has no PR", or the caller clears a badge that is still valid.
  it.each([
    {
      label: 'GraphQL rate limit',
      stderr: 'GraphQL: API rate limit already exceeded for user ID 123.',
      reason: 'rate_limit',
    },
    {
      label: 'secondary rate limit',
      stderr: 'You have exceeded a secondary rate limit',
      reason: 'rate_limit',
    },
    {
      label: 'not authenticated',
      stderr: 'To get started with GitHub CLI, please run: gh auth login',
      reason: 'auth',
    },
    { label: 'token rejected', stderr: 'HTTP 401: Bad credentials', reason: 'auth' },
    {
      label: 'offline',
      stderr: 'error connecting to api.github.com: could not resolve host',
      reason: 'network',
    },
    { label: 'timeout', stderr: 'request timeout', reason: 'network' },
    { label: 'anything else', stderr: 'unexpected end of JSON input', reason: 'unknown' },
  ] as const)('reports unavailable/$reason on $label', async (c) => {
    const exec = vi.fn<ExecLike>(async (file) => {
      if (file === 'git') return { stdout: 'codiva/x\n' };
      throw ghError(c.stderr);
    });
    await expect(lookupPr('/wt', 'codiva/x', exec)).resolves.toEqual({
      kind: 'unavailable',
      reason: c.reason satisfies PrUnavailableReason,
    });
  });

  it('reports unavailable/cli when `gh` is not installed', async () => {
    const exec = vi.fn<ExecLike>(async (file) => {
      if (file === 'git') return { stdout: 'codiva/x\n' };
      throw Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' });
    });
    await expect(lookupPr('/wt', 'codiva/x', exec)).resolves.toEqual({
      kind: 'unavailable',
      reason: 'cli',
    });
  });

  it('prefers a failure over `absent` when only one candidate could be answered', async () => {
    // HEAD's lookup blew up, the recorded branch genuinely has none: we can't rule
    // out a PR on HEAD, so this is "unknown", not "no PR".
    const exec = vi.fn<ExecLike>(async (file, args) => {
      if (file === 'git') return { stdout: 'feat/x\n' };
      if (args[2] === 'feat/x') throw ghError('API rate limit exceeded');
      throw ghError(NO_PR);
    });
    await expect(lookupPr('/wt', 'codiva/x', exec)).resolves.toEqual({
      kind: 'unavailable',
      reason: 'rate_limit',
    });
  });

  it('reports unavailable (not absent) on malformed / partial JSON', async () => {
    const bad = vi.fn<ExecLike>(async (file) =>
      file === 'git' ? { stdout: 'codiva/x\n' } : { stdout: '{ not json' },
    );
    await expect(lookupPr('/wt', 'codiva/x', bad)).resolves.toEqual({
      kind: 'unavailable',
      reason: 'unknown',
    });

    const partial = vi.fn<ExecLike>(async (file) =>
      file === 'git' ? { stdout: 'codiva/x\n' } : { stdout: JSON.stringify({ number: 3 }) },
    );
    await expect(lookupPr('/wt', 'codiva/x', partial)).resolves.toEqual({
      kind: 'unavailable',
      reason: 'unknown',
    });
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
    await expect(createPr('/wt/a', 'codiva/feature', exec)).resolves.toEqual({
      number: 9,
      url: 'https://github.com/o/r/pull/9',
      mergeStatus: 'unknown',
      checks: 'none',
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
      checks: 'none',
      isDraft: false,
    });
  });

  it('resolves undefined when the PR cannot be looked up afterwards', async () => {
    const exec = vi.fn<ExecLike>(async () => {
      throw ghError('API rate limit exceeded');
    });
    await expect(createPr('/wt', 'codiva/x', exec)).resolves.toBeUndefined();
  });
});

describe('markPrReady', () => {
  it('runs `gh pr ready <branch>`', async () => {
    const exec = vi.fn<ExecLike>(async () => ({ stdout: '' }));
    await markPrReady('/wt', 'codiva/feature', exec);
    expect(exec).toHaveBeenCalledWith('gh', ['pr', 'ready', 'codiva/feature'], { cwd: '/wt' });
  });
});
