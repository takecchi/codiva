import { type AccountSummary, toAccountSummary, toUsageSnapshot, type UsageSnapshot } from '@/core';
import { type ProbeQuery, runSdkProbe } from './sdk-probe';

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
 * Both halves are best-effort and read independently: on a Team account the
 * experimental usage request answers with `rate_limits: null` while `accountInfo()`
 * still reports the plan, so one failing must not hide the other. Never throws;
 * an all-failed probe returns `{}` and the caller keeps its previous values.
 */
export async function fetchUsageSnapshot(
  queryFn: ProbeQuery,
  opts: { cwd: string; signal?: AbortSignal },
): Promise<UsageProbeResult> {
  const result = await runSdkProbe(queryFn, opts, async (handle) => {
    const [account, usage] = await Promise.allSettled([
      handle.accountInfo ? handle.accountInfo() : Promise.reject(new Error('unsupported')),
      handle.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET
        ? handle.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET()
        : Promise.reject(new Error('unsupported')),
    ]);
    return {
      account: account.status === 'fulfilled' ? toAccountSummary(account.value) : undefined,
      usage: usage.status === 'fulfilled' ? toUsageSnapshot(usage.value) : undefined,
    };
  });
  return result ?? {};
}

/**
 * Whether a probe result carries anything worth polling for again.
 *
 * False means this login has no subscription usage to show at all (API key,
 * Bedrock/Vertex, or an SDK that dropped the requests) — the poller stops instead
 * of spawning a subprocess forever for data that will never arrive.
 */
export function hasUsageData(result: UsageProbeResult): boolean {
  return result.account !== undefined || (result.usage?.windows.length ?? 0) > 0;
}
