import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProbeHandle, ProbeQuery, UsageProbeResult } from '@/utils';
import { fetchUsageSnapshot } from '@/utils';
import { startUsagePolling, USAGE_POLL_INTERVAL_MS } from './usage-poller';

const WITH_DATA: UsageProbeResult = { account: { plan: 'Claude Team' } };
const EMPTY: UsageProbeResult = {};
/** 実際の Bedrock ログインが返す形（プランも枠も無い = 永久に取れない）。 */
const NO_SUBSCRIPTION: UsageProbeResult = {
  account: { apiProvider: 'bedrock' },
  usage: { limitsAvailable: false, windows: [] },
};

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

  it('stops immediately on a login that can never report usage (Bedrock / API key)', async () => {
    // 「取れなかった」ではなく「この環境には存在しない」という肯定的シグナルなので、
    // 空振りカウンタを待たずに1回で止める（5分ごとのサブプロセスを永久に立てない）。
    const fetch = vi.fn(async () => NO_SUBSCRIPTION);
    const apply = vi.fn();
    const stop = startUsagePolling({ fetch, apply, intervalMs: 1000 });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetch).toHaveBeenCalledTimes(1);
    // 取れた内容自体は反映する（プランが無いので UI は何も描かない）。
    expect(apply).toHaveBeenCalledWith(NO_SUBSCRIPTION);
    stop();
  });

  it('gives up after three consecutive empty probes (nothing answered at all)', async () => {
    const fetch = vi.fn(async () => EMPTY);
    const stop = startUsagePolling({ fetch, apply: vi.fn(), intervalMs: 1000 });
    await vi.advanceTimersByTimeAsync(2000);
    expect(fetch).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetch).toHaveBeenCalledTimes(3);
    stop();
  });

  it('treats two empty probes as transient and keeps polling', async () => {
    // 起動直後の混み合い + 一時的な失敗を「サブスクが無い」と誤判定しない。
    const results = [EMPTY, EMPTY, WITH_DATA, EMPTY, EMPTY, WITH_DATA];
    const fetch = vi.fn(async () => results.shift() ?? WITH_DATA);
    const stop = startUsagePolling({ fetch, apply: vi.fn(), intervalMs: 1000 });
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetch).toHaveBeenCalledTimes(6);
    stop();
  });

  it('keeps polling when apply throws (a UI subscriber must not kill the poller)', async () => {
    const fetch = vi.fn(async () => WITH_DATA);
    const apply = vi.fn(() => {
      throw new Error('render blew up');
    });
    const stop = startUsagePolling({ fetch, apply, intervalMs: 1000 });
    await vi.advanceTimersByTimeAsync(2000);
    expect(fetch).toHaveBeenCalledTimes(3);
    stop();
  });

  it('waits for `after` before the first probe (no two cold starts at once)', async () => {
    let release: (() => void) | undefined;
    const after = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetch = vi.fn(async () => WITH_DATA);
    const stop = startUsagePolling({ fetch, apply: vi.fn(), after, intervalMs: 10_000 });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).not.toHaveBeenCalled();
    release?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledTimes(1);
    stop();
  });

  it('probes anyway when `after` rejects', async () => {
    const fetch = vi.fn(async () => WITH_DATA);
    const stop = startUsagePolling({
      fetch,
      apply: vi.fn(),
      after: Promise.reject(new Error('catalog failed')),
      intervalMs: 10_000,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledTimes(1);
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

/**
 * ポーラーを**実物の probe** に繋いだ結合テスト（間に挟むのは SDK ハンドルのフェイクだけ）。
 * 「この環境ではサブスクの使用状況が取れない」という判定は
 * `fetchUsageSnapshot` → `hasNoSubscription` → ポーラーの3者が噛み合って初めて効くので、
 * 単体テストのフェイク結果だけでは HIGH 級の取りこぼし（永久ポーリング）を検出できない。
 */
function fakeQuery(handle: Omit<ProbeHandle, typeof Symbol.asyncIterator>): ProbeQuery {
  return () => ({
    [Symbol.asyncIterator]: async function* () {
      // Never yields: probe は control channel だけで完結する。
    },
    ...handle,
  });
}

describe('startUsagePolling + fetchUsageSnapshot（結合）', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('Bedrock ログインでは1回で停止する（プランも枠も存在しない）', async () => {
    const query = fakeQuery({
      // 3P プロバイダは apiProvider だけ返す（subscriptionType は無い）。
      accountInfo: async () => ({ apiProvider: 'bedrock' }),
      usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => ({
        subscription_type: null,
        rate_limits_available: false,
        rate_limits: null,
      }),
    });
    const fetch = vi.fn(() => fetchUsageSnapshot(query, { cwd: '/repo' }));
    const stop = startUsagePolling({ fetch, apply: vi.fn(), intervalMs: 1000 });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetch).toHaveBeenCalledTimes(1);
    stop();
  });

  it('claude.ai ログイン（枠が来ない Team でも）はポーリングを続ける', async () => {
    const query = fakeQuery({
      accountInfo: async () => ({
        subscriptionType: 'Claude Team',
        organization: 'Example Inc',
        apiProvider: 'firstParty',
      }),
      // 実測の Team 応答: available=true なのに rate_limits は null。
      usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => ({
        subscription_type: 'team',
        rate_limits_available: true,
        rate_limits: null,
      }),
    });
    const applied: UsageProbeResult[] = [];
    const stop = startUsagePolling({
      fetch: () => fetchUsageSnapshot(query, { cwd: '/repo' }),
      apply: (result) => applied.push(result),
      intervalMs: 1000,
    });
    await vi.advanceTimersByTimeAsync(3000);
    expect(applied.length).toBeGreaterThanOrEqual(4);
    expect(applied.at(-1)?.account?.plan).toBe('Claude Team');
    stop();
  });
});
