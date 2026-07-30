import { describe, expect, it } from 'vitest';
import {
  compactRateLimitWindows,
  hasRateLimitDetail,
  mergeEventWindow,
  type RateLimitWindow,
  rateLimitLabelKey,
  resetCountdown,
  sameRateLimitWindow,
  sortRateLimitWindows,
  toRateLimitWindow,
} from './rate-limit';

describe('toRateLimitWindow', () => {
  it('parses a real SDK rate_limit_info payload (resetsAt seconds → ms)', () => {
    // Shape taken verbatim from src/core/__fixtures__/session-basic.jsonl (real SDK output).
    const window = toRateLimitWindow({
      status: 'allowed_warning',
      resetsAt: 1785542400,
      rateLimitType: 'overage',
      utilization: 3.49,
    });
    expect(window).toEqual({
      type: 'overage',
      status: 'allowed_warning',
      utilization: 3.49,
      resetsAt: 1785542400_000,
    });
  });

  it('parses a five_hour window', () => {
    expect(
      toRateLimitWindow({
        status: 'allowed',
        resetsAt: 1785542400,
        rateLimitType: 'five_hour',
        utilization: 5,
      }),
    ).toEqual({ type: 'five_hour', status: 'allowed', utilization: 5, resetsAt: 1785542400_000 });
  });

  it('passes through a value that is already epoch ms', () => {
    const window = toRateLimitWindow({
      status: 'allowed',
      resetsAt: 1785542400_000,
      rateLimitType: 'five_hour',
    });
    expect(window?.resetsAt).toBe(1785542400_000);
  });

  it.each([
    ['missing info', undefined],
    ['unknown type', { status: 'allowed', rateLimitType: 'monthly' }],
    ['missing type', { status: 'allowed' }],
    ['unknown status', { status: 'throttled', rateLimitType: 'five_hour' }],
    ['missing status', { rateLimitType: 'five_hour' }],
  ])('returns undefined for %s', (_label, info) => {
    expect(toRateLimitWindow(info)).toBeUndefined();
  });

  it('drops an unusable utilization but keeps the window', () => {
    const window = toRateLimitWindow({
      status: 'allowed',
      rateLimitType: 'five_hour',
      utilization: -1,
    });
    expect(window?.utilization).toBeUndefined();
  });

  it('drops an unusable resetsAt but keeps the window', () => {
    const window = toRateLimitWindow({
      status: 'allowed',
      rateLimitType: 'five_hour',
      resetsAt: 0,
    });
    expect(window?.resetsAt).toBeUndefined();
  });
});

describe('rateLimitLabelKey', () => {
  it.each([
    ['five_hour', 'session'],
    ['seven_day', 'week'],
    ['seven_day_overage_included', 'week'],
    ['seven_day_sonnet', 'weekSonnet'],
    ['seven_day_opus', 'weekOpus'],
    ['overage', 'overage'],
  ] as const)('maps %s → %s', (type, key) => {
    expect(rateLimitLabelKey(type)).toBe(key);
  });
});

describe('sortRateLimitWindows', () => {
  it('orders five_hour first and overage last regardless of input order', () => {
    const w = (type: RateLimitWindow['type']): RateLimitWindow => ({ type, status: 'allowed' });
    const sorted = sortRateLimitWindows([w('overage'), w('seven_day'), w('five_hour')]);
    expect(sorted.map((x) => x.type)).toEqual(['five_hour', 'seven_day', 'overage']);
  });

  it('collapses windows that share a display label, keeping the higher-priority type', () => {
    const w = (type: RateLimitWindow['type']): RateLimitWindow => ({ type, status: 'allowed' });
    // seven_day and seven_day_overage_included both label as "week" → only one row.
    const sorted = sortRateLimitWindows([w('seven_day_overage_included'), w('seven_day')]);
    expect(sorted.map((x) => x.type)).toEqual(['seven_day']);
  });
});

describe('sameRateLimitWindow', () => {
  const base: RateLimitWindow = {
    type: 'five_hour',
    status: 'allowed',
    utilization: 5,
    resetsAt: 1000,
  };
  it('is true for identical windows', () => {
    expect(sameRateLimitWindow(base, { ...base })).toBe(true);
  });
  it('is false when any field differs', () => {
    expect(sameRateLimitWindow(base, { ...base, utilization: 6 })).toBe(false);
    expect(sameRateLimitWindow(base, { ...base, status: 'rejected' })).toBe(false);
    expect(sameRateLimitWindow(base, { ...base, resetsAt: 2000 })).toBe(false);
  });
});

describe('resetCountdown', () => {
  const MIN = 60_000;
  it('splits remaining time into d/h/m', () => {
    const now = 0;
    const resetsAt = (4 * 60 + 45) * MIN; // 4h45m
    expect(resetCountdown(resetsAt, now)).toEqual({ days: 0, hours: 4, minutes: 45 });
  });
  it('handles multi-day windows', () => {
    const now = 0;
    const resetsAt = (6 * 1440 + 3 * 60 + 12) * MIN; // 6d3h12m
    expect(resetCountdown(resetsAt, now)).toEqual({ days: 6, hours: 3, minutes: 12 });
  });
  it('clamps a past reset to zero', () => {
    expect(resetCountdown(0, 10 * MIN)).toEqual({ days: 0, hours: 0, minutes: 0 });
  });
});

describe('hasRateLimitDetail', () => {
  it.each([
    ['a percentage', { type: 'five_hour', status: 'allowed', utilization: 1 }, true],
    ['a reset time', { type: 'five_hour', status: 'allowed', resetsAt: 1000 }, true],
    ['neither', { type: 'five_hour', status: 'allowed' }, false],
  ])('%s → %s', (_label, window, expected) => {
    expect(hasRateLimitDetail(window as RateLimitWindow)).toBe(expected);
  });
});

describe('compactRateLimitWindows', () => {
  const w = (
    type: RateLimitWindow['type'],
    status: RateLimitWindow['status'] = 'allowed',
  ): RateLimitWindow => ({ type, status, utilization: 10 });

  it('keeps display order and caps the count for the one-line footer', () => {
    const shown = compactRateLimitWindows([w('overage'), w('seven_day'), w('five_hour')]);
    expect(shown.map((x) => x.type)).toEqual(['five_hour', 'seven_day']);
  });

  it('floats a rejected window to the front so it is never the row that gets cut', () => {
    const shown = compactRateLimitWindows([
      w('five_hour'),
      w('seven_day'),
      w('overage', 'rejected'),
    ]);
    expect(shown.map((x) => x.type)).toEqual(['overage', 'five_hour']);
  });

  it('floats a warning window too', () => {
    const shown = compactRateLimitWindows([w('five_hour'), w('seven_day', 'allowed_warning')], 1);
    expect(shown.map((x) => x.type)).toEqual(['seven_day']);
  });

  it('drops windows with nothing to show', () => {
    const empty: RateLimitWindow = { type: 'seven_day', status: 'allowed' };
    const shown = compactRateLimitWindows([w('five_hour'), empty]);
    expect(shown.map((x) => x.type)).toEqual(['five_hour']);
  });

  it.each([0, -1])('returns nothing for max=%s', (max) => {
    expect(compactRateLimitWindows([w('five_hour')], max)).toEqual([]);
  });
});

describe('mergeEventWindow', () => {
  const polled: RateLimitWindow = {
    type: 'five_hour',
    status: 'allowed',
    utilization: 42,
    resetsAt: 1000,
  };

  it('takes the event as-is when there was nothing before', () => {
    const event: RateLimitWindow = { type: 'five_hour', status: 'allowed', resetsAt: 1000 };
    expect(mergeEventWindow(undefined, event)).toBe(event);
  });

  it('keeps the polled percentage when the event omits utilization (same window)', () => {
    // The real five_hour event carries resetsAt + status but no utilization; without
    // this the gauge would vanish at the start of every turn.
    const event: RateLimitWindow = { type: 'five_hour', status: 'allowed_warning', resetsAt: 1000 };
    expect(mergeEventWindow(polled, event)).toEqual({
      type: 'five_hour',
      status: 'allowed_warning',
      utilization: 42,
      resetsAt: 1000,
    });
  });

  it('drops the old percentage once the window rolled over', () => {
    const event: RateLimitWindow = { type: 'five_hour', status: 'allowed', resetsAt: 9999 };
    expect(mergeEventWindow(polled, event)).toEqual({
      type: 'five_hour',
      status: 'allowed',
      utilization: undefined,
      resetsAt: 9999,
    });
  });

  it("prefers the event's own utilization over the carried one", () => {
    const event: RateLimitWindow = {
      type: 'five_hour',
      status: 'allowed',
      utilization: 7,
      resetsAt: 1000,
    };
    expect(mergeEventWindow(polled, event).utilization).toBe(7);
  });

  it('keeps the reference when nothing displayable moved (no re-render)', () => {
    const event: RateLimitWindow = { type: 'five_hour', status: 'allowed', resetsAt: 1000 };
    expect(mergeEventWindow(polled, event)).toBe(polled);
  });

  it('carries the percentage when either side has no reset time (cannot tell)', () => {
    const noReset: RateLimitWindow = { type: 'overage', status: 'allowed', utilization: 3.5 };
    const event: RateLimitWindow = { type: 'overage', status: 'rejected' };
    expect(mergeEventWindow(noReset, event)).toEqual({
      type: 'overage',
      status: 'rejected',
      utilization: 3.5,
      resetsAt: undefined,
    });
  });
});
