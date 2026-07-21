/**
 * claude.ai subscription usage limits, as reported by the SDK's `rate_limit_event`
 * (see `SDKRateLimitInfo`). Pure domain: parsing, normalization, and display
 * selectors live here so `sdk-parse` / `session-manager` stay free of shape logic
 * and the UI stays free of arithmetic. This is account-wide data (not per-session):
 * every live session's SDK stream reports the same limits, so the manager keeps the
 * latest window per type and the banner renders them.
 */

/** The usage windows the SDK reports for a claude.ai subscription. */
export type RateLimitType =
  | 'five_hour'
  | 'seven_day'
  | 'seven_day_opus'
  | 'seven_day_sonnet'
  | 'seven_day_overage_included'
  | 'overage';

/** Whether the account is still being served on a window (`rejected` = turned away). */
export type RateLimitStatus = 'allowed' | 'allowed_warning' | 'rejected';

/**
 * Which display label a window maps to. Several SDK types collapse to one
 * category (both `seven_day` and `seven_day_overage_included` read as "this week").
 */
export type RateLimitLabelKey = 'session' | 'week' | 'weekOpus' | 'weekSonnet' | 'overage';

/** A single normalized usage window (account-wide) derived from a rate_limit_event. */
export interface RateLimitWindow {
  type: RateLimitType;
  status: RateLimitStatus;
  /** Percent used (0–100), as reported by the SDK's `utilization`. Undefined if absent. */
  utilization?: number;
  /** Epoch **milliseconds** at which this window resets. Undefined if absent. */
  resetsAt?: number;
}

/** The loosely-typed shape read out of `rate_limit_event.rate_limit_info`. */
export interface RateLimitInfoJson {
  status?: string;
  resetsAt?: number;
  rateLimitType?: string;
  utilization?: number;
}

const KNOWN_TYPES: readonly RateLimitType[] = [
  'five_hour',
  'seven_day',
  'seven_day_opus',
  'seven_day_sonnet',
  'seven_day_overage_included',
  'overage',
];

const KNOWN_STATUSES: readonly RateLimitStatus[] = ['allowed', 'allowed_warning', 'rejected'];

/**
 * Display order + de-dupe priority: the 5-hour "current session" window first,
 * then the weekly windows, with pooled overage last. When two types collapse to
 * the same display label (e.g. `seven_day` and `seven_day_overage_included` both
 * read as "this week"), the one earlier in this list wins so the banner never
 * shows two identically-labeled rows.
 */
const PRIORITY: readonly RateLimitType[] = [
  'five_hour',
  'seven_day',
  'seven_day_sonnet',
  'seven_day_opus',
  'seven_day_overage_included',
  'overage',
];

const LABEL_KEYS: Record<RateLimitType, RateLimitLabelKey> = {
  five_hour: 'session',
  seven_day: 'week',
  seven_day_overage_included: 'week',
  seven_day_sonnet: 'weekSonnet',
  seven_day_opus: 'weekOpus',
  overage: 'overage',
};

function isType(value: string | undefined): value is RateLimitType {
  return value !== undefined && (KNOWN_TYPES as readonly string[]).includes(value);
}

function isStatus(value: string | undefined): value is RateLimitStatus {
  return value !== undefined && (KNOWN_STATUSES as readonly string[]).includes(value);
}

/**
 * `resetsAt` arrives as a Unix timestamp in **seconds** (observed in real SDK
 * output, e.g. `1785542400`). Normalize to epoch ms. Guard against a future SDK
 * that switches to ms: anything already past ~2001 in ms magnitude is treated as
 * ms and passed through (a seconds value large enough to trip this is year ~5138,
 * so real seconds never collide).
 */
function normalizeResetsAt(resetsAt: number | undefined): number | undefined {
  if (typeof resetsAt !== 'number' || !Number.isFinite(resetsAt) || resetsAt <= 0) {
    return undefined;
  }
  return resetsAt > 1e11 ? resetsAt : resetsAt * 1000;
}

/**
 * Parse one `rate_limit_info` payload into a normalized window, or undefined when
 * it lacks a usable type/status (we never surface a window we can't label).
 */
export function toRateLimitWindow(
  info: RateLimitInfoJson | undefined,
): RateLimitWindow | undefined {
  if (!info || !isType(info.rateLimitType) || !isStatus(info.status)) {
    return undefined;
  }
  const utilization =
    typeof info.utilization === 'number' &&
    Number.isFinite(info.utilization) &&
    info.utilization >= 0
      ? info.utilization
      : undefined;
  return {
    type: info.rateLimitType,
    status: info.status,
    utilization,
    resetsAt: normalizeResetsAt(info.resetsAt),
  };
}

/** The display-label category for a window's type. */
export function rateLimitLabelKey(type: RateLimitType): RateLimitLabelKey {
  return LABEL_KEYS[type];
}

/** Two windows are equivalent for churn-avoidance (skip re-render on no-op events). */
export function sameRateLimitWindow(a: RateLimitWindow, b: RateLimitWindow): boolean {
  return (
    a.type === b.type &&
    a.status === b.status &&
    a.utilization === b.utilization &&
    a.resetsAt === b.resetsAt
  );
}

/**
 * Order windows for display (5-hour first, overage last) and collapse any that
 * share a display label, keeping the highest-priority type. Guarantees at most
 * one row per label so the banner can't render two identical "This week" lines.
 */
export function sortRateLimitWindows(windows: readonly RateLimitWindow[]): RateLimitWindow[] {
  const ordered = [...windows].sort((a, b) => PRIORITY.indexOf(a.type) - PRIORITY.indexOf(b.type));
  const seenLabels = new Set<RateLimitLabelKey>();
  return ordered.filter((w) => {
    const label = rateLimitLabelKey(w.type);
    if (seenLabels.has(label)) {
      return false;
    }
    seenLabels.add(label);
    return true;
  });
}

/** Days/hours/minutes remaining until `resetsAtMs`, clamped at zero (never negative). */
export interface ResetCountdown {
  days: number;
  hours: number;
  minutes: number;
}

/** Time remaining until a window resets, split into d/h/m and clamped at zero. */
export function resetCountdown(resetsAtMs: number, nowMs: number): ResetCountdown {
  const totalMinutes = Math.max(0, Math.floor((resetsAtMs - nowMs) / 60000));
  return {
    days: Math.floor(totalMinutes / 1440),
    hours: Math.floor((totalMinutes % 1440) / 60),
    minutes: totalMinutes % 60,
  };
}
