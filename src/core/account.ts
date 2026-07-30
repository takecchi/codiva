/**
 * The authenticated Claude account, as reported by the SDK's `Query.accountInfo()`.
 * Pure domain: shape parsing and normalization live here so `utils/usage-probe`
 * stays a thin I/O wrapper and the UI stays free of string munging.
 *
 * This is account-wide data (not per-session) and it is the only source for the
 * **plan name** (Pro / Max / Team / Enterprise) — the same identity Claude Code
 * shows in its status line. Real payload (spiked 2026-07-30, Team account):
 *
 * ```json
 * { "email": "…", "organization": "THE PHAGE",
 *   "subscriptionType": "Claude Team", "apiProvider": "firstParty" }
 * ```
 *
 * `subscriptionType` is an SDK-supplied display string, so it is rendered as-is
 * (the same i18n exception as SDK model names — see .claude/rules/i18n.md).
 */

/** The loosely-typed payload read out of `accountInfo()`. */
export interface AccountInfoJson {
  email?: unknown;
  organization?: unknown;
  subscriptionType?: unknown;
  tokenSource?: unknown;
  apiKeySource?: unknown;
  apiProvider?: unknown;
}

/** The account facts codiva displays (everything optional — API-key logins report almost nothing). */
export interface AccountSummary {
  /** Plan display name, e.g. `'Claude Team'`. Absent for API-key / 3P-provider sessions. */
  plan?: string;
  /** Organization the account belongs to (Team / Enterprise), when reported. */
  organization?: string;
  /**
   * Active API backend. `'firstParty'` = claude.ai OAuth login, the only case
   * where subscription limits apply (Bedrock / Vertex / API keys have none).
   */
  apiProvider?: string;
}

function text(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Title-case a raw plan identifier so the two SDK spellings agree: `accountInfo()`
 * reports `'Claude Team'` while the usage endpoint reports `'team'`. Already-cased
 * names pass through unchanged.
 */
export function normalizePlanName(raw: string): string {
  return raw
    .trim()
    .split(/[\s_]+/)
    .filter((part) => part.length > 0)
    .map((part) =>
      part === part.toLowerCase() ? part.charAt(0).toUpperCase() + part.slice(1) : part,
    )
    .join(' ');
}

/**
 * Normalize an `accountInfo()` payload, or undefined when it carries nothing we
 * display (so callers can keep the previous value instead of blanking the line).
 */
export function toAccountSummary(json: unknown): AccountSummary | undefined {
  if (typeof json !== 'object' || json === null) {
    return undefined;
  }
  const info = json as AccountInfoJson;
  const plan = text(info.subscriptionType);
  const summary: AccountSummary = {
    plan: plan === undefined ? undefined : normalizePlanName(plan),
    organization: text(info.organization),
    apiProvider: text(info.apiProvider),
  };
  return summary.plan === undefined &&
    summary.organization === undefined &&
    summary.apiProvider === undefined
    ? undefined
    : summary;
}

/** Whether two summaries are display-equivalent (used to skip no-op re-renders). */
export function sameAccountSummary(
  a: AccountSummary | undefined,
  b: AccountSummary | undefined,
): boolean {
  if (a === undefined || b === undefined) {
    return a === b;
  }
  return a.plan === b.plan && a.organization === b.organization && a.apiProvider === b.apiProvider;
}
