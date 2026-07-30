import { describe, expect, it } from 'vitest';
import type { RateLimitWindow } from './rate-limit';
import { mergeUsageWindow, toUsageSnapshot } from './usage';

/**
 * The real response from a Claude Team account (captured 2026-07-30; the
 * `session` / `behaviors` sections are dropped, codiva reads neither). Note the
 * combination this fixture exists to pin: `rate_limits_available: true` with
 * `rate_limits: null` — "available" does not mean "there are windows".
 */
const TEAM_RESPONSE = {
  session: { total_cost_usd: 0, model_usage: {} },
  subscription_type: 'team',
  rate_limits_available: true,
  rate_limits: null,
};

/**
 * A populated response. This account's endpoint never returns windows, so the
 * field names/types here come from the SDK's own declaration of
 * `SDKControlGetUsageResponse.rate_limits` (utilization: number|null,
 * resets_at: ISO string|null) rather than from a capture.
 */
const POPULATED_RESPONSE = {
  subscription_type: 'max',
  rate_limits_available: true,
  rate_limits: {
    five_hour: { utilization: 12.5, resets_at: '2026-07-30T09:00:00.000Z' },
    seven_day: { utilization: 48, resets_at: '2026-08-02T00:00:00.000Z' },
    seven_day_opus: { utilization: null, resets_at: null },
    seven_day_sonnet: { utilization: 3, resets_at: null },
    seven_day_oauth_apps: { utilization: 90, resets_at: '2026-08-02T00:00:00.000Z' },
    extra_usage: { is_enabled: false, monthly_limit: null, used_credits: null, utilization: null },
  },
};

describe('toUsageSnapshot', () => {
  it('reads the plan but no windows from the real Team response', () => {
    expect(toUsageSnapshot(TEAM_RESPONSE)).toEqual({
      plan: 'team',
      limitsAvailable: true,
      windows: [],
    });
  });

  it('parses the documented window shape (ISO resets_at → epoch ms)', () => {
    const snapshot = toUsageSnapshot(POPULATED_RESPONSE);
    expect(snapshot.plan).toBe('max');
    expect(snapshot.limitsAvailable).toBe(true);
    expect(snapshot.windows).toEqual([
      { type: 'five_hour', utilization: 12.5, resetsAt: Date.parse('2026-07-30T09:00:00.000Z') },
      { type: 'seven_day', utilization: 48, resetsAt: Date.parse('2026-08-02T00:00:00.000Z') },
      { type: 'seven_day_sonnet', utilization: 3, resetsAt: undefined },
    ]);
  });

  it('drops an all-null window instead of showing it as 0%', () => {
    const snapshot = toUsageSnapshot(POPULATED_RESPONSE);
    expect(snapshot.windows.some((w) => w.type === 'seven_day_opus')).toBe(false);
  });

  it('ignores third-party OAuth-app usage (no codiva label for it)', () => {
    const types = toUsageSnapshot(POPULATED_RESPONSE).windows.map((w) => w.type);
    expect(types).not.toContain('seven_day_oauth_apps');
  });

  it.each([
    ['a non-object', 'nope'],
    ['null', null],
    ['undefined', undefined],
    ['an empty object', {}],
  ])('degrades to no plan and no windows for %s', (_label, json) => {
    expect(toUsageSnapshot(json)).toEqual({ plan: undefined, limitsAvailable: false, windows: [] });
  });

  it.each([
    ['unparsable resets_at', { five_hour: { utilization: null, resets_at: 'not-a-date' } }, []],
    ['negative utilization', { five_hour: { utilization: -1, resets_at: null } }, []],
    [
      'utilization only',
      { five_hour: { utilization: 0, resets_at: null } },
      [{ type: 'five_hour', utilization: 0, resetsAt: undefined }],
    ],
  ])('handles %s', (_label, rate_limits, expected) => {
    expect(toUsageSnapshot({ rate_limits }).windows).toEqual(expected);
  });
});

describe('mergeUsageWindow', () => {
  const event: RateLimitWindow = {
    type: 'five_hour',
    status: 'allowed_warning',
    utilization: undefined,
    resetsAt: 1_785_414_600_000,
  };

  it('defaults to allowed when there is no event yet', () => {
    expect(mergeUsageWindow(undefined, { type: 'five_hour', utilization: 12 })).toEqual({
      type: 'five_hour',
      status: 'allowed',
      utilization: 12,
      resetsAt: undefined,
    });
  });

  it("keeps the event's status (the usage endpoint reports none) and adds its numbers", () => {
    expect(mergeUsageWindow(event, { type: 'five_hour', utilization: 12 })).toEqual({
      type: 'five_hour',
      status: 'allowed_warning',
      utilization: 12,
      resetsAt: 1_785_414_600_000,
    });
  });

  it('keeps the previous number when the poll reports none', () => {
    const prev: RateLimitWindow = { ...event, utilization: 40 };
    expect(mergeUsageWindow(prev, { type: 'five_hour' }).utilization).toBe(40);
  });

  it('returns the same object reference when nothing displayable moved', () => {
    const prev: RateLimitWindow = { ...event, utilization: 40 };
    expect(mergeUsageWindow(prev, { type: 'five_hour', utilization: 40 })).toBe(prev);
  });

  it('drops a stale percentage when the poll reports a new window', () => {
    const prev: RateLimitWindow = { ...event, utilization: 40 };
    expect(mergeUsageWindow(prev, { type: 'five_hour', resetsAt: 9999 })).toEqual({
      type: 'five_hour',
      status: 'allowed_warning',
      utilization: undefined,
      resetsAt: 9999,
    });
  });

  it('prefers the freshly polled reset time', () => {
    expect(mergeUsageWindow(event, { type: 'five_hour', resetsAt: 999 }).resetsAt).toBe(999);
  });
});
