import { describe, expect, it } from 'vitest';
import {
  isPrRefreshDue,
  PR_POLL_FAST_MS,
  PR_POLL_SOON_MS,
  PR_POLL_STABLE_MS,
  prPollIntervalMs,
} from './pr-refresh';
import { initialState } from './status-reducer';
import type { PrRef, PrStatus, SessionState } from './types';

const BASE = initialState({
  id: 's1',
  title: 't',
  prompt: 'p',
  branch: 'codiva/demo',
  worktreePath: '/wt/demo',
  startedAt: 0,
});

const state = (over: Partial<SessionState>): SessionState => ({ ...BASE, ...over });
const REF: PrRef = { number: 1, url: 'u' };
/** A known PR whose status is known too (the steady state after one poll). */
const withPr = (status: Partial<PrStatus> = {}): Partial<SessionState> => ({
  pr: REF,
  prStatus: { mergeStatus: 'mergeable', checks: 'passing', ...status },
});

describe('prPollIntervalMs', () => {
  it.each([
    {
      label: 'a merged PR never needs another look',
      state: state({ status: 'completed', ...withPr({ mergeStatus: 'merged' }) }),
      expected: undefined,
    },
    {
      label: 'an archived row is done with',
      state: state({ status: 'archived' }),
      expected: undefined,
    },
    {
      label: 'checks running moves minute-to-minute (and gates auto-ready)',
      state: state({ status: 'completed', ...withPr({ checks: 'pending' }) }),
      expected: PR_POLL_FAST_MS,
    },
    {
      label: 'mergeability not computed yet settles within seconds',
      state: state({ status: 'completed', ...withPr({ mergeStatus: 'unknown', checks: 'none' }) }),
      expected: PR_POLL_SOON_MS,
    },
    {
      label: 'a settled PR only changes when the base branch moves',
      state: state({ status: 'completed', ...withPr() }),
      expected: PR_POLL_STABLE_MS,
    },
    {
      label: 'failed checks are settled too (a push is what changes them)',
      state: state({ status: 'completed', ...withPr({ checks: 'failing' }) }),
      expected: PR_POLL_STABLE_MS,
    },
    {
      // 再オープンはあり得るので merged のように止めはしないが、閉じた PR の CI が
      // 終わっても見に行く理由は無いので、pending でも fast へ落とさない。
      label: 'a closed PR is as good as final, but can be reopened',
      state: state({
        status: 'completed',
        ...withPr({ mergeStatus: 'closed', checks: 'pending' }),
      }),
      expected: PR_POLL_STABLE_MS,
    },
    {
      label: 'the number is known but the status is not — fetch it right away',
      state: state({ status: 'completed', pr: REF }),
      expected: 0,
    },
    {
      label: 'no PR on a finished session — one may appear right about now',
      state: state({ status: 'completed' }),
      expected: PR_POLL_SOON_MS,
    },
    {
      label: 'no PR while still working — the PR comes at the end',
      state: state({ status: 'running' }),
      expected: PR_POLL_STABLE_MS,
    },
    {
      label: 'a conflicted session is terminal, so watch for its PR',
      state: state({ status: 'conflict' }),
      expected: PR_POLL_SOON_MS,
    },
  ] as const)('$label', (c) => {
    expect(prPollIntervalMs(c.state)).toBe(c.expected);
  });
});

describe('isPrRefreshDue', () => {
  it('is due when never fetched', () => {
    expect(isPrRefreshDue(state({ status: 'running' }), undefined, 0)).toBe(true);
  });

  it('is never due for rows with no interval, even if never fetched', () => {
    expect(isPrRefreshDue(state({ status: 'archived' }), undefined, 10 ** 9)).toBe(false);
    expect(isPrRefreshDue(state(withPr({ mergeStatus: 'merged' })), undefined, 10 ** 9)).toBe(
      false,
    );
  });

  it('waits out the interval, then comes due (cached value reused meanwhile)', () => {
    const s = state({ status: 'completed', ...withPr({ checks: 'pending' }) });
    expect(isPrRefreshDue(s, 1000, 1000 + PR_POLL_FAST_MS - 1)).toBe(false);
    expect(isPrRefreshDue(s, 1000, 1000 + PR_POLL_FAST_MS)).toBe(true);
  });

  it('keeps a stable PR cached far longer than the poll tick', () => {
    const s = state({ status: 'completed', ...withPr() });
    // 20s tick, 3min freshness → 8 of every 9 ticks cost nothing.
    expect(isPrRefreshDue(s, 0, 20_000)).toBe(false);
    expect(isPrRefreshDue(s, 0, PR_POLL_STABLE_MS)).toBe(true);
  });
});
