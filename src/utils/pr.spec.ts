import { describe, expect, it, vi } from 'vitest';
import { MAX_FAILING_CHECKS, type PrUnavailableReason } from '@/core';
import { createPr, type ExecLike, lookupPr, lookupPrs, markPrReady } from './pr';

const FIELDS = 'number,url,state,mergeable,isDraft,statusCheckRollup';

/** stdout for a minimal `gh pr view` payload (number,url only → mergeStatus 'unknown'). */
const ghPr = (number: number) =>
  JSON.stringify({ number, url: `https://github.com/o/r/pull/${number}` });

/** An execFile-style rejection: `gh` exits non-zero and writes to stderr. */
function ghError(stderr: string): Error & { stderr: string; code?: string | number } {
  return Object.assign(new Error(`Command failed: gh\n${stderr}`), { stderr, code: 1 });
}

const NO_PR = 'no pull requests found for branch "codiva/x"';

/** A PR already known for the session (what the poll passes as `knownPr`). */
const PR_42 = { number: 42, url: 'https://github.com/o/r/pull/42' };
const PR_7 = { number: 7, url: 'https://github.com/o/r/pull/7' };

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
    await expect(lookupPr('/wt/a', 'codiva/feature', {}, exec)).resolves.toEqual({
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
    await expect(lookupPr('/wt/a', 'codiva/feature', {}, exec)).resolves.toEqual({
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
    const result = await lookupPr('/wt', 'codiva/x', {}, exec);
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
    const result = await lookupPr('/wt', 'codiva/x', {}, exec);
    expect(result.kind === 'found' && result.pr.checks).toBe(c.expected);
  });

  describe('failingChecks (named red checks, carved out of the same payload)', () => {
    /** Resolve a PR whose rollup is `rollup`, and hand back the parsed PrInfo. */
    async function pr(rollup: unknown) {
      const exec = vi.fn<ExecLike>(async (file) =>
        file === 'git'
          ? { stdout: 'codiva/x\n' }
          : { stdout: JSON.stringify({ number: 1, url: 'u', statusCheckRollup: rollup }) },
      );
      const result = await lookupPr('/wt', 'codiva/x', {}, exec);
      return result.kind === 'found' ? result.pr : undefined;
    }

    it('names each failing check as <workflow> / <job> with its link', async () => {
      const info = await pr([
        { status: 'COMPLETED', conclusion: 'SUCCESS', name: 'lint', workflowName: 'CI' },
        {
          status: 'COMPLETED',
          conclusion: 'FAILURE',
          name: 'test (20.x)',
          workflowName: 'CI',
          detailsUrl: 'https://example.test/run/9',
        },
      ]);
      expect(info?.failingChecks).toEqual([
        { name: 'CI / test (20.x)', url: 'https://example.test/run/9' },
      ]);
    });

    it('falls back to the legacy status-context fields', async () => {
      // External CI (CircleCI, Codecov, Jenkins…) arrives as a StatusContext, which
      // carries `context`/`targetUrl` instead of `name`/`detailsUrl`. Reading only the
      // check-run fields would name every one of them a useless "check".
      const info = await pr([
        { state: 'ERROR', context: 'ci/circleci: build', targetUrl: 'https://example.test/cci' },
      ]);
      expect(info?.failingChecks).toEqual([
        { name: 'ci/circleci: build', url: 'https://example.test/cci' },
      ]);
    });

    it('names an unlabelled failure rather than dropping it', async () => {
      const info = await pr([{ status: 'COMPLETED', conclusion: 'FAILURE' }]);
      expect(info?.failingChecks).toEqual([{ name: 'check' }]);
    });

    it('caps a fan-out matrix so the fix instruction stays readable', async () => {
      const info = await pr(
        Array.from({ length: MAX_FAILING_CHECKS + 4 }, (_, i) => ({
          status: 'COMPLETED',
          conclusion: 'FAILURE',
          name: `job-${i}`,
        })),
      );
      expect(info?.failingChecks).toHaveLength(MAX_FAILING_CHECKS);
    });

    it.each(['passing', 'pending', 'none'] as const)(
      'is absent while the aggregate is %s (it would only churn the reducer)',
      async (expected) => {
        const rollup =
          expected === 'passing'
            ? [{ status: 'COMPLETED', conclusion: 'SUCCESS' }]
            : expected === 'pending'
              ? [{ status: 'IN_PROGRESS' }]
              : [];
        const info = await pr(rollup);
        expect(info?.checks).toBe(expected);
        expect(info?.failingChecks).toBeUndefined();
      },
    );
  });

  it('looks the PR up by the worktree HEAD branch, not the recorded branch', async () => {
    // HEAD has moved to a fresh feat/ branch (git rules cut one before the PR),
    // so the PR lives there — not on the original codiva/<slug> worktree branch.
    const exec = vi.fn<ExecLike>(async (file) =>
      file === 'git' ? { stdout: 'feat/new-thing\n' } : { stdout: ghPr(7) },
    );
    const result = await lookupPr('/wt/a', 'codiva/feature', {}, exec);
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
    const result = await lookupPr('/wt', 'codiva/feature', {}, exec);
    expect(result.kind === 'found' && result.pr.number).toBe(5);
    expect(exec).toHaveBeenCalledWith('gh', ['pr', 'view', 'codiva/feature', '--json', FIELDS], {
      cwd: '/wt',
    });
  });

  it('queries only once when HEAD equals the recorded branch', async () => {
    const exec = vi.fn<ExecLike>(async (file) =>
      file === 'git' ? { stdout: 'codiva/feature\n' } : { stdout: ghPr(3) },
    );
    const result = await lookupPr('/wt', 'codiva/feature', {}, exec);
    expect(result.kind === 'found' && result.pr.number).toBe(3);
    expect(exec.mock.calls.filter(([file]) => file === 'gh')).toHaveLength(1);
  });

  it('uses the recorded branch when HEAD cannot be resolved (git fails)', async () => {
    const exec = vi.fn<ExecLike>(async (file) => {
      if (file === 'git') throw new Error('fatal: not a git repository');
      return { stdout: ghPr(7) };
    });
    const result = await lookupPr('/wt/a', 'codiva/feature', {}, exec);
    expect(result.kind === 'found' && result.pr.number).toBe(7);
    expect(exec).toHaveBeenCalledWith('gh', ['pr', 'view', 'codiva/feature', '--json', FIELDS], {
      cwd: '/wt/a',
    });
  });

  it('treats a detached HEAD as unresolvable and uses the recorded branch', async () => {
    const exec = vi.fn<ExecLike>(async (file) =>
      file === 'git' ? { stdout: 'HEAD\n' } : { stdout: ghPr(9) },
    );
    const result = await lookupPr('/wt', 'codiva/x', {}, exec);
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
    await expect(lookupPr('/wt', 'codiva/x', {}, exec)).resolves.toEqual({ kind: 'absent' });
  });

  // The session opened its own PR from a throwaway branch it no longer has checked
  // out: no branch name resolves it, so the known ref is the only handle on its state.
  it('falls back to the known PR (by URL) when no branch has a PR', async () => {
    const exec = vi.fn<ExecLike>(async (file, args) => {
      if (file === 'git') return { stdout: 'codiva/x\n' };
      if (args[2] === PR_42.url) return { stdout: ghPr(42) };
      throw ghError(NO_PR);
    });
    const result = await lookupPr('/wt', 'codiva/x', { knownPr: PR_42 }, exec);
    expect(result.kind === 'found' && result.pr.number).toBe(42);
    expect(exec).toHaveBeenCalledWith('gh', ['pr', 'view', PR_42.url, '--json', FIELDS], {
      cwd: '/wt',
    });
  });

  // PR numbers are per-repo, so a bare `gh pr view 42` in the worktree would answer
  // with *this* repo's #42: an unrelated PR to adopt, glyph and possibly ready.
  it('never asks by bare number (a same-numbered PR in this repo must not stand in)', async () => {
    const otherRepo = { number: 42, url: 'https://github.com/acme/other/pull/42' };
    const exec = vi.fn<ExecLike>(async (file, args) => {
      if (file === 'git') return { stdout: 'codiva/x\n' };
      if (args[2] === otherRepo.url) {
        return { stdout: JSON.stringify({ number: 42, url: otherRepo.url, state: 'OPEN' }) };
      }
      throw ghError(NO_PR); // this repo's own #42 / branches must never be consulted
    });
    const result = await lookupPr('/wt', 'codiva/x', { knownPr: otherRepo }, exec);
    expect(result.kind === 'found' && result.pr.url).toBe(otherRepo.url);
    expect(exec.mock.calls.some(([, a]) => a[2] === '42')).toBe(false);
  });

  it('prefers a branch PR over the known PR (a newer PR on the branch wins)', async () => {
    const exec = vi.fn<ExecLike>(async (file) =>
      file === 'git' ? { stdout: 'codiva/x\n' } : { stdout: ghPr(9) },
    );
    const result = await lookupPr('/wt', 'codiva/x', { knownPr: PR_42 }, exec);
    expect(result.kind === 'found' && result.pr.number).toBe(9);
    expect(exec.mock.calls.filter(([file]) => file === 'gh')).toHaveLength(1);
  });

  it('reports `absent` when even the known PR is gone', async () => {
    const exec = vi.fn<ExecLike>(async (file) => {
      if (file === 'git') return { stdout: 'codiva/x\n' };
      throw ghError(NO_PR);
    });
    await expect(lookupPr('/wt', 'codiva/x', { knownPr: PR_42 }, exec)).resolves.toEqual({
      kind: 'absent',
    });
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
    await expect(lookupPr('/wt', 'codiva/x', {}, exec)).resolves.toEqual({
      kind: 'unavailable',
      reason: c.reason satisfies PrUnavailableReason,
    });
  });

  it('reports unavailable/cli when `gh` is not installed', async () => {
    const exec = vi.fn<ExecLike>(async (file) => {
      if (file === 'git') return { stdout: 'codiva/x\n' };
      throw Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' });
    });
    await expect(lookupPr('/wt', 'codiva/x', {}, exec)).resolves.toEqual({
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
    await expect(lookupPr('/wt', 'codiva/x', {}, exec)).resolves.toEqual({
      kind: 'unavailable',
      reason: 'rate_limit',
    });
  });

  it('reports unavailable (not absent) on malformed / partial JSON', async () => {
    const bad = vi.fn<ExecLike>(async (file) =>
      file === 'git' ? { stdout: 'codiva/x\n' } : { stdout: '{ not json' },
    );
    await expect(lookupPr('/wt', 'codiva/x', {}, bad)).resolves.toEqual({
      kind: 'unavailable',
      reason: 'unknown',
    });

    const partial = vi.fn<ExecLike>(async (file) =>
      file === 'git' ? { stdout: 'codiva/x\n' } : { stdout: JSON.stringify({ number: 3 }) },
    );
    await expect(lookupPr('/wt', 'codiva/x', {}, partial)).resolves.toEqual({
      kind: 'unavailable',
      reason: 'unknown',
    });
  });
});

describe('lookupPrs (batched)', () => {
  const LIST_FIELDS = `headRefName,${FIELDS}`;
  const targets = [
    { id: 'a', cwd: '/wt/a', branch: 'codiva/a' },
    { id: 'b', cwd: '/wt/b', branch: 'codiva/b' },
    { id: 'c', cwd: '/wt/c', branch: 'codiva/c' },
  ];

  /** exec that answers `git rev-parse` with the recorded branch and `pr list` with `rows`. */
  function listExec(rows: unknown[]) {
    return vi.fn<ExecLike>(async (file, args, opts) => {
      if (file === 'git') return { stdout: `codiva/${opts.cwd.slice(-1)}\n` };
      if (args[1] === 'list') return { stdout: JSON.stringify(rows) };
      throw ghError(NO_PR);
    });
  }

  const row = (branch: string, number: number, over: Record<string, unknown> = {}) => ({
    headRefName: branch,
    number,
    url: `https://x/${number}`,
    state: 'OPEN',
    mergeable: 'MERGEABLE',
    statusCheckRollup: [{ status: 'IN_PROGRESS' }],
    ...over,
  });

  // The point of batching: API cost stops scaling with the number of sessions.
  it('resolves every session with a single `gh pr list`', async () => {
    const exec = listExec([row('codiva/a', 1), row('codiva/c', 3)]);
    const results = await lookupPrs(targets, exec);

    expect(results.get('a')).toEqual({
      kind: 'found',
      pr: { number: 1, url: 'https://x/1', mergeStatus: 'mergeable', checks: 'pending' },
    });
    expect(results.get('b')).toEqual({ kind: 'absent' });
    expect(results.get('c')?.kind).toBe('found');

    const ghCalls = exec.mock.calls.filter(([file]) => file === 'gh');
    expect(ghCalls).toHaveLength(1);
    expect(ghCalls[0]?.[1]).toEqual([
      'pr',
      'list',
      '--state',
      'all',
      '--limit',
      '30',
      '--json',
      LIST_FIELDS,
    ]);
  });

  it('matches the worktree HEAD branch, not just the recorded one', async () => {
    const exec = vi.fn<ExecLike>(async (file, args) => {
      if (file === 'git') return { stdout: 'feat/new-thing\n' };
      if (args[1] === 'list') return { stdout: JSON.stringify([row('feat/new-thing', 9)]) };
      throw ghError(NO_PR);
    });
    const results = await lookupPrs([targets[0] ?? { id: 'a', cwd: '/wt/a', branch: 'x' }], exec);
    const result = results.get('a');
    expect(result?.kind === 'found' && result.pr.number).toBe(9);
  });

  it('prefers an open PR over a closed one on the same branch', async () => {
    // Newest-first ordering would otherwise pick the closed PR listed above.
    const exec = listExec([
      row('codiva/a', 5, { state: 'CLOSED', mergeable: 'UNKNOWN' }),
      row('codiva/a', 4, { state: 'OPEN' }),
    ]);
    const results = await lookupPrs(targets, exec);
    const result = results.get('a');
    expect(result?.kind === 'found' && result.pr.number).toBe(4);
  });

  it('scales the page size with the number of sessions (capped at 100)', async () => {
    const many = Array.from({ length: 60 }, (_, i) => ({
      id: `s${i}`,
      cwd: '/wt/x',
      branch: `codiva/s${i}`,
    }));
    const exec = listExec([]);
    await lookupPrs(many, exec);
    const args = exec.mock.calls.find(([, a]) => a[1] === 'list')?.[1];
    expect(args?.[5]).toBe('100');
  });

  // Same invariant as the single lookup: a failure must never read as "no PR".
  it.each([
    { stderr: 'GraphQL: API rate limit already exceeded', reason: 'rate_limit' },
    { stderr: 'gh auth login', reason: 'auth' },
  ] as const)('marks every target unavailable/$reason when the list fails', async (c) => {
    const exec = vi.fn<ExecLike>(async (file) => {
      if (file === 'git') return { stdout: 'codiva/a\n' };
      throw ghError(c.stderr);
    });
    const results = await lookupPrs(targets, exec);
    for (const t of targets) {
      expect(results.get(t.id)).toEqual({ kind: 'unavailable', reason: c.reason });
    }
  });

  it('marks every target unavailable on malformed list output', async () => {
    const exec = vi.fn<ExecLike>(async (file, args) => {
      if (file === 'git') return { stdout: 'codiva/a\n' };
      if (args[1] === 'list') return { stdout: '{ not json' };
      throw ghError(NO_PR);
    });
    const results = await lookupPrs(targets, exec);
    expect(results.get('a')).toEqual({ kind: 'unavailable', reason: 'unknown' });
  });

  it('skips unparsable rows instead of failing the whole batch', async () => {
    const exec = listExec([null, { headRefName: 'codiva/a' }, row('codiva/b', 2)]);
    const results = await lookupPrs(targets, exec);
    expect(results.get('a')).toEqual({ kind: 'absent' }); // no number/url → not a match
    expect(results.get('b')?.kind).toBe('found');
  });

  it('verifies a known PR with a targeted view when the page was truncated', async () => {
    // 3 targets → limit 30. A full page means older PRs were cut off, so a session
    // whose PR we already knew must not be declared gone on that basis alone.
    const full = Array.from({ length: 30 }, (_, i) => row(`other/${i}`, 100 + i));
    const exec = vi.fn<ExecLike>(async (file, args) => {
      if (file === 'git') return { stdout: 'codiva/a\n' };
      if (args[1] === 'list') return { stdout: JSON.stringify(full) };
      return { stdout: JSON.stringify({ number: 7, url: 'u', state: 'OPEN' }) };
    });
    const results = await lookupPrs(
      [{ id: 'a', cwd: '/wt/a', branch: 'codiva/a', knownPr: PR_7 }],
      exec,
    );
    const result = results.get('a');
    expect(result?.kind === 'found' && result.pr.number).toBe(7);
    expect(exec.mock.calls.filter(([, a]) => a[1] === 'view')).toHaveLength(1);
  });

  // A PR the session opened itself lives on a branch this worktree doesn't have (or in
  // another repo), so no row in the page can match it however short the page is.
  // Reporting `absent` here is what used to strand such a PR without any state at all.
  it('verifies a known PR by URL when no branch in the page matches it', async () => {
    const exec = vi.fn<ExecLike>(async (file, args) => {
      if (file === 'git') return { stdout: 'codiva/a\n' };
      if (args[1] === 'list') return { stdout: JSON.stringify([row('other/1', 100)]) };
      if (args[2] === PR_7.url) {
        return { stdout: JSON.stringify({ number: 7, url: PR_7.url, state: 'MERGED' }) };
      }
      throw ghError(NO_PR); // the session's branch itself has no PR
    });
    const results = await lookupPrs(
      [{ id: 'a', cwd: '/wt/a', branch: 'codiva/a', knownPr: PR_7 }],
      exec,
    );
    expect(results.get('a')).toEqual({
      kind: 'found',
      pr: { number: 7, url: PR_7.url, mergeStatus: 'merged', checks: 'none' },
    });
    // Asked about that PR itself — never by bare number, which is repo-relative.
    expect(exec.mock.calls.some(([, a]) => a[1] === 'view' && a[2] === PR_7.url)).toBe(true);
    expect(exec.mock.calls.some(([, a]) => a[2] === '7')).toBe(false);
  });

  // The batch runs `gh pr list` in *this* repo, so a cross-repo PR can never match a
  // row: it must be verified by its own URL, not declared gone and not confused with a
  // same-numbered PR here.
  it("verifies a cross-repo PR without touching this repo's PR of the same number", async () => {
    const otherRepo = { number: 42, url: 'https://github.com/acme/other/pull/42' };
    const exec = vi.fn<ExecLike>(async (file, args) => {
      if (file === 'git') return { stdout: 'codiva/a\n' };
      // This repo *does* have a #42, on an unrelated branch.
      if (args[1] === 'list') return { stdout: JSON.stringify([row('someone/else', 42)]) };
      if (args[2] === otherRepo.url) {
        return { stdout: JSON.stringify({ number: 42, url: otherRepo.url, state: 'OPEN' }) };
      }
      throw ghError(NO_PR);
    });
    const results = await lookupPrs(
      [{ id: 'a', cwd: '/wt/a', branch: 'codiva/a', knownPr: otherRepo }],
      exec,
    );
    const result = results.get('a');
    expect(result?.kind === 'found' && result.pr.url).toBe(otherRepo.url);
    expect(exec.mock.calls.some(([, a]) => a[2] === '42')).toBe(false);
  });

  it('reports absent (no extra call) for a session with no PR to verify', async () => {
    const exec = listExec([row('other/1', 100)]);
    const results = await lookupPrs([{ id: 'a', cwd: '/wt/a', branch: 'codiva/a' }], exec);
    expect(results.get('a')).toEqual({ kind: 'absent' });
    expect(exec.mock.calls.filter(([, a]) => a[1] === 'view')).toHaveLength(0);
  });

  it('resolves an empty map for no targets (never runs `gh`)', async () => {
    const exec = vi.fn<ExecLike>(async () => ({ stdout: '' }));
    await expect(lookupPrs([], exec)).resolves.toEqual(new Map());
    expect(exec).not.toHaveBeenCalled();
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
  it.each(['codiva/feature', '42'])('runs `gh pr ready %s`', async (ref) => {
    const exec = vi.fn<ExecLike>(async () => ({ stdout: '' }));
    await markPrReady('/wt', ref, exec);
    expect(exec).toHaveBeenCalledWith('gh', ['pr', 'ready', ref], { cwd: '/wt' });
  });
});
