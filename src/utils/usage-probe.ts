import { type AccountSummary, toAccountSummary, toUsageSnapshot, type UsageSnapshot } from '@/core';
import { type ProbeQuery, runSdkProbe, settleWithin } from './sdk-probe';

/**
 * Per-read deadline, deliberately shorter than the probe's own overall deadline
 * (`PROBE_TIMEOUT_MS` in sdk-probe): the two reads are independent, so a hang in the
 * experimental usage request must not take the account info (which already
 * answered) down with it.
 */
const READ_TIMEOUT_MS = 7_000;

/** What one probe could learn. Either half can be missing (the other is still useful). */
export interface UsageProbeResult {
  /** Plan name / organization from `accountInfo()`. */
  account?: AccountSummary;
  /** Plan + rate-limit utilization windows from the experimental `/usage` request. */
  usage?: UsageSnapshot;
}

/**
 * Read the account identity and the claude.ai usage windows in **one** throwaway
 * probe session (one `claude` subprocess, no inference, no tokens — see
 * `utils/sdk-probe.ts`), then abort it.
 *
 * Both halves are read independently, each with its own deadline: on a Team account
 * the experimental usage request answers `rate_limits: null` while `accountInfo()`
 * still reports the plan, and an experimental control request is exactly the kind of
 * thing that hangs. One failing — or stalling — must not hide the other. Never
 * throws; an all-failed probe returns `{}` and the caller keeps its previous values.
 */
export async function fetchUsageSnapshot(
  queryFn: ProbeQuery,
  opts: { cwd: string; signal?: AbortSignal },
): Promise<UsageProbeResult> {
  const result = await runSdkProbe(queryFn, opts, async (handle) => {
    const [account, usage] = await Promise.all([
      settleWithin(handle.accountInfo?.(), READ_TIMEOUT_MS),
      settleWithin(
        handle.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET?.(),
        READ_TIMEOUT_MS,
      ),
    ]);
    return {
      account: account === undefined ? undefined : toAccountSummary(account),
      usage: usage === undefined ? undefined : toUsageSnapshot(usage),
    };
  });
  return withPlanFallback(result ?? {});
}

/**
 * Use the usage endpoint's `subscription_type` as the plan name when
 * `accountInfo()` didn't report one (it can fail on its own, and the two spell the
 * plan differently — `toUsageSnapshot` already title-cased it to match).
 */
function withPlanFallback(result: UsageProbeResult): UsageProbeResult {
  const fallback = result.usage?.plan;
  if (result.account?.plan !== undefined || fallback === undefined) {
    return result;
  }
  return { ...result, account: { ...result.account, plan: fallback } };
}

/**
 * Whether a probe found **subscription usage** worth polling for again.
 *
 * Deliberately keyed on the plan name and the windows, not on "did `accountInfo()`
 * answer at all": a Bedrock/Vertex login answers with `{apiProvider:'bedrock'}` and
 * an API-key login with `{apiProvider:'firstParty'}` and no `subscriptionType`, so
 * treating any answer as data would keep the poller alive forever for a status line
 * that renders nothing.
 */
export function hasUsageData(result: UsageProbeResult): boolean {
  return result.account?.plan !== undefined || (result.usage?.windows.length ?? 0) > 0;
}

/**
 * Positive evidence that this login can **never** report subscription usage, so the
 * poller can stop immediately instead of waiting out its empty-result counter:
 * either the usage endpoint said plan limits don't apply, or the account is served
 * by a non-claude.ai backend (Bedrock / Vertex / gateway …).
 */
export function hasNoSubscription(result: UsageProbeResult): boolean {
  if (result.usage?.limitsAvailable === false) {
    return true;
  }
  const provider = result.account?.apiProvider;
  return provider !== undefined && provider !== 'firstParty';
}
