import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UsageProbeResult } from '@/utils';
import { startUsagePolling, USAGE_POLL_INTERVAL_MS } from './usage-poller';

const WITH_DATA: UsageProbeResult = { account: { plan: 'Claude Team' } };
const EMPTY: UsageProbeResult = {};

describe('startUsagePolling', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('probes immediately and then on the interval', async () => {
    const fetch = vi.fn(async () => WITH_DATA);
    const apply = vi.fn();
    const stop = startUsagePolling({ fetch, apply });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledWith(WITH_DATA);

    await vi.advanceTimersByTimeAsync(USAGE_POLL_INTERVAL_MS);
    expect(fetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(USAGE_POLL_INTERVAL_MS);
    expect(fetch).toHaveBeenCalledTimes(3);
    stop();
  });

  it('stops probing after stop() (no subprocess left behind on shutdown)', async () => {
    const fetch = vi.fn(async () => WITH_DATA);
    const stop = startUsagePolling({ fetch, apply: vi.fn(), intervalMs: 1000 });
    await vi.advanceTimersByTimeAsync(0);
    stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('does not apply a result that landed after stop()', async () => {
    let release: ((value: UsageProbeResult) => void) | undefined;
    const apply = vi.fn();
    const stop = startUsagePolling({
      fetch: () => new Promise<UsageProbeResult>((resolve) => (release = resolve)),
      apply,
      intervalMs: 1000,
    });
    await vi.advanceTimersByTimeAsync(0);
    stop();
    release?.(WITH_DATA);
    await vi.advanceTimersByTimeAsync(0);
    expect(apply).not.toHaveBeenCalled();
  });

  it('skips overlapping probes instead of stacking subprocesses', async () => {
    let pending = 0;
    const fetch = vi.fn(() => {
      pending += 1;
      return new Promise<UsageProbeResult>(() => {}); // never settles
    });
    const stop = startUsagePolling({ fetch, apply: vi.fn(), intervalMs: 1000 });
    await vi.advanceTimersByTimeAsync(5000);
    expect(pending).toBe(1);
    stop();
  });

  it('gives up after two consecutive empty probes (API-key login)', async () => {
    const fetch = vi.fn(async () => EMPTY);
    const stop = startUsagePolling({ fetch, apply: vi.fn(), intervalMs: 1000 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetch).toHaveBeenCalledTimes(2);
    stop();
  });

  it('treats one empty probe as transient and keeps polling', async () => {
    const results = [WITH_DATA, EMPTY, WITH_DATA, WITH_DATA];
    const fetch = vi.fn(async () => results.shift() ?? WITH_DATA);
    const stop = startUsagePolling({ fetch, apply: vi.fn(), intervalMs: 1000 });
    await vi.advanceTimersByTimeAsync(3000);
    expect(fetch).toHaveBeenCalledTimes(4);
    stop();
  });

  it('keeps polling when a probe rejects (offline, claude busy)', async () => {
    let calls = 0;
    const fetch = vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        throw new Error('spawn failed');
      }
      return WITH_DATA;
    });
    const apply = vi.fn();
    const stop = startUsagePolling({ fetch, apply, intervalMs: 1000 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(apply).toHaveBeenLastCalledWith(WITH_DATA);
    stop();
  });
});
