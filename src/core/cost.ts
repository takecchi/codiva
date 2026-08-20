import type { AgentId, SessionState } from './types';

/**
 * Running cost helpers. Each session's `totalCostUsd` is the SDK's cumulative
 * `result.total_cost_usd` for that session (kept up to date by the reducer);
 * these derive the run-wide total and a display string. Pure — no I/O.
 */

/**
 * Sum of every session's cost. Archived sessions are included — money was still spent.
 *
 * `reportsCost` は「その provider が金額を報告するか」（`AgentCapabilities.cost`）を
 * 渡す口。持たない provider のセッションは**合計に数えない** — 数字が 0 だから自然に
 * 消える、という偶然に頼っていると、Claude と Codex を混ぜたときに「Claude ぶんの
 * 合計」を全体のコストとして出してしまう（省略時は全件を数える = 従来の挙動）。
 */
export function totalCostUsd(
  states: SessionState[],
  reportsCost?: (agent: AgentId | undefined) => boolean,
): number {
  return states.reduce(
    (sum, s) => (reportsCost && !reportsCost(s.agent) ? sum : sum + (s.totalCostUsd ?? 0)),
    0,
  );
}

/**
 * Format a USD amount for the TUI. Session costs are usually well under a dollar,
 * so show 4 decimals below $1 and 2 decimals at or above it. The `$` is a currency
 * symbol (data, not translatable text) so it stays out of the message catalog.
 */
export function formatUsd(usd: number): string {
  return `$${usd < 1 ? usd.toFixed(4) : usd.toFixed(2)}`;
}
