import { describe, expect, it, vi } from 'vitest';
import type { ProbeHandle, ProbeQuery } from './sdk-probe';
import { fetchUsageSnapshot, hasUsageData } from './usage-probe';

/** Minimal fake of the probe handle: only the two control-channel reads are used. */
function fakeQuery(
  handle: Omit<ProbeHandle, typeof Symbol.asyncIterator>,
  spy?: (params: Parameters<ProbeQuery>[0]) => void,
): ProbeQuery {
  return (params) => {
    spy?.(params);
    return {
      [Symbol.asyncIterator]: async function* () {
        // Never yields: the probe completes on the control channel alone.
      },
      ...handle,
    };
  };
}

const ACCOUNT = {
  email: 'someone@example.com',
  organization: 'Example Inc',
  subscriptionType: 'Claude Team',
  apiProvider: 'firstParty',
};

// Real Team-account response: the plan is there, the windows are not.
const USAGE = { subscription_type: 'team', rate_limits_available: true, rate_limits: null };

describe('fetchUsageSnapshot', () => {
  it('reads the account and the usage snapshot in one probe', async () => {
    const spy = vi.fn();
    const result = await fetchUsageSnapshot(
      fakeQuery(
        {
          accountInfo: async () => ACCOUNT,
          usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => USAGE,
        },
        spy,
      ),
      { cwd: '/repo' },
    );
    expect(result.account).toEqual({
      plan: 'Claude Team',
      organization: 'Example Inc',
      apiProvider: 'firstParty',
    });
    expect(result.usage).toEqual({ plan: 'team', limitsAvailable: true, windows: [] });
    // One subprocess for both reads, and it is never left resident.
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[0]?.options.cwd).toBe('/repo');
    expect(spy.mock.calls[0]?.[0]?.options.abortController?.signal.aborted).toBe(true);
  });

  it('keeps the account when the experimental usage request fails', async () => {
    const result = await fetchUsageSnapshot(
      fakeQuery({
        accountInfo: async () => ACCOUNT,
        usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => {
          throw new Error('unsupported control request');
        },
      }),
      { cwd: '/repo' },
    );
    expect(result.account?.plan).toBe('Claude Team');
    expect(result.usage).toBeUndefined();
  });

  it('keeps the usage snapshot when accountInfo fails', async () => {
    const result = await fetchUsageSnapshot(
      fakeQuery({
        accountInfo: async () => {
          throw new Error('nope');
        },
        usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => USAGE,
      }),
      { cwd: '/repo' },
    );
    expect(result.account).toBeUndefined();
    expect(result.usage?.plan).toBe('team');
  });

  it('returns {} when the SDK dropped both methods (never throws)', async () => {
    await expect(fetchUsageSnapshot(fakeQuery({}), { cwd: '/repo' })).resolves.toEqual({
      account: undefined,
      usage: undefined,
    });
  });

  it('returns {} when the query itself throws', async () => {
    const query: ProbeQuery = () => {
      throw new Error('claude not found');
    };
    await expect(fetchUsageSnapshot(query, { cwd: '/repo' })).resolves.toEqual({});
  });

  it('gives up on its own deadline when the SDK never answers', async () => {
    vi.useFakeTimers();
    try {
      const pending = fetchUsageSnapshot(
        fakeQuery({
          accountInfo: () => new Promise<unknown>(() => {}),
          usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: () =>
            new Promise<unknown>(() => {}),
        }),
        { cwd: '/repo' },
      );
      await vi.advanceTimersByTimeAsync(10_000);
      await expect(pending).resolves.toEqual({});
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops early when the caller aborts (shutdown mid-probe)', async () => {
    const shutdown = new AbortController();
    const spy = vi.fn();
    const pending = fetchUsageSnapshot(
      fakeQuery(
        {
          accountInfo: () =>
            new Promise<unknown>((_resolve, reject) => {
              const signal = spy.mock.calls[0]?.[0]?.options.abortController?.signal;
              signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
            }),
        },
        spy,
      ),
      { cwd: '/repo', signal: shutdown.signal },
    );
    shutdown.abort();
    await expect(pending).resolves.toEqual({ account: undefined, usage: undefined });
  });
});

describe('hasUsageData', () => {
  it.each([
    ['an account', { account: { plan: 'Claude Team' } }, true],
    [
      'windows only',
      {
        usage: { limitsAvailable: true, windows: [{ type: 'five_hour' as const, utilization: 1 }] },
      },
      true,
    ],
    ['nothing', {}, false],
    ['a usage snapshot with no windows', { usage: { limitsAvailable: true, windows: [] } }, false],
    // An API-key login: the endpoint says limits don't apply and reports no plan.
    ['limits unavailable', { usage: { limitsAvailable: false, windows: [] } }, false],
  ])('%s → %s', (_label, result, expected) => {
    expect(hasUsageData(result)).toBe(expected);
  });
});
