/**
 * The claude.ai `/usage` snapshot: subscription plan + rate-limit utilization
 * windows, as returned by the SDK's experimental usage control request
 * (`Query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET()`).
 *
 * Why a second source at all — `rate_limit_event` (see rate-limit.ts) only arrives
 * while a session is running a turn, so a freshly started codiva (or one whose
 * sessions are all idle) has nothing to show. This snapshot can be polled without
 * running any inference, which is what keeps the status line close to live.
 *
 * Two facts from the real API, both load-bearing (spiked 2026-07-30):
 *  - The window payloads carry **no status** field (`allowed` / `rejected` only
 *    exists on `rate_limit_event`), hence {@link UsageWindow} is status-less and
 *    {@link mergeUsageWindow} keeps whatever status the event stream last saw.
 *  - `rate_limits` can be `null` **even when `rate_limits_available` is true**
 *    (observed on a Claude Team account). So "available" is not a promise of
 *    windows: treat a null/absent `rate_limits` as "no windows" and keep relying
 *    on `rate_limit_event`. Never render a 0% gauge from a missing window.
 *
 * `resets_at` here is an ISO 8601 string (the event stream uses Unix seconds).
 * The `model_scoped` / `extra_usage` / `behaviors` sections are intentionally
 * ignored — codiva shows the fixed 5-hour + weekly windows only.
 */

import { type RateLimitType, type RateLimitWindow, sameRateLimitWindow } from './rate-limit';

/** A usage window as reported by the usage endpoint (no status — see the file docs). */
export interface UsageWindow {
  type: RateLimitType;
  /** Percent used (0–100). Undefined when the API reported null. */
  utilization?: number;
  /** Epoch **milliseconds** at which the window resets. Undefined when null/unparsable. */
  resetsAt?: number;
}

/** Normalized `/usage` response: the plan name plus whatever windows came with it. */
export interface UsageSnapshot {
  /** Plan display name (title-cased, e.g. `'Team'`), when the API reported one. */
  plan?: string;
  /** The API's own claim that plan limits apply (false for API key / Bedrock / Vertex). */
  limitsAvailable: boolean;
  /** Parsed windows, in API order. Empty when `rate_limits` was null. */
  windows: UsageWindow[];
}

/**
 * Which response keys map to which window type. `seven_day_oauth_apps` has no
 * codiva label (it measures third-party OAuth apps, not this CLI), so it is
 * skipped rather than shown under a misleading heading.
 */
const WINDOW_KEYS: Readonly<Record<string, RateLimitType>> = {
  five_hour: 'five_hour',
  seven_day: 'seven_day',
  seven_day_opus: 'seven_day_opus',
  seven_day_sonnet: 'seven_day_sonnet',
};

interface UsageWindowJson {
  utilization?: unknown;
  resets_at?: unknown;
}

function toUtilization(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** ISO 8601 → epoch ms, or undefined when null / unparsable (never NaN downstream). */
function toResetsAt(value: unknown): number | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/** Parse one window entry, or undefined when it carries neither number we display. */
function toUsageWindow(type: RateLimitType, value: unknown): UsageWindow | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const json = value as UsageWindowJson;
  const utilization = toUtilization(json.utilization);
  const resetsAt = toResetsAt(json.resets_at);
  if (utilization === undefined && resetsAt === undefined) {
    return undefined;
  }
  return { type, utilization, resetsAt };
}

interface UsageResponseJson {
  subscription_type?: unknown;
  rate_limits_available?: unknown;
  rate_limits?: unknown;
}

/**
 * Normalize the experimental usage response. Never throws and never invents a
 * window: an unexpected shape degrades to `{ limitsAvailable: false, windows: [] }`
 * so the caller simply keeps showing event-derived data.
 */
export function toUsageSnapshot(json: unknown): UsageSnapshot {
  if (typeof json !== 'object' || json === null) {
    return { limitsAvailable: false, windows: [] };
  }
  const response = json as UsageResponseJson;
  const rawPlan = typeof response.subscription_type === 'string' ? response.subscription_type : '';
  const plan = rawPlan.trim().length > 0 ? rawPlan.trim() : undefined;
  const limits = response.rate_limits;
  const windows: UsageWindow[] = [];
  if (typeof limits === 'object' && limits !== null) {
    const record = limits as Record<string, unknown>;
    for (const [key, type] of Object.entries(WINDOW_KEYS)) {
      const window = toUsageWindow(type, record[key]);
      if (window) {
        windows.push(window);
      }
    }
  }
  return {
    plan,
    limitsAvailable: response.rate_limits_available === true,
    windows,
  };
}

/**
 * Fold a polled usage window into the window the event stream produced.
 *
 * The usage endpoint has no status, and `rate_limit_event` sometimes omits
 * `utilization` (the real five_hour event does), so neither source is a superset.
 * Field-wise merge with the poll winning on the numbers it actually reported, and
 * the last known status carried forward (defaulting to `allowed`: we only display
 * a window the account is being served on until an event says otherwise).
 *
 * A value is only carried over while the window instance is unchanged: a different
 * reset time means the period rolled over, so the old percentage is stale and gets
 * dropped rather than shown against the new window.
 *
 * Returns `prev` unchanged when nothing displayable moved, so the manager's
 * snapshot keeps its reference identity and the status line doesn't re-render.
 */
export function mergeUsageWindow(
  prev: RateLimitWindow | undefined,
  next: UsageWindow,
): RateLimitWindow {
  const rolledOver =
    prev !== undefined &&
    prev.resetsAt !== undefined &&
    next.resetsAt !== undefined &&
    prev.resetsAt !== next.resetsAt;
  const merged: RateLimitWindow = {
    type: next.type,
    status: prev?.status ?? 'allowed',
    utilization: next.utilization ?? (rolledOver ? undefined : prev?.utilization),
    resetsAt: next.resetsAt ?? prev?.resetsAt,
  };
  return prev && sameRateLimitWindow(prev, merged) ? prev : merged;
}
