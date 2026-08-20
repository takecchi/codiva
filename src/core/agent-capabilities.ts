import type { AgentCapabilities } from './agent-ports';
import type { AgentId, SessionStatus } from './types';

/**
 * capability による UI 縮退の判定（純粋）。
 *
 * 「持たない機能を出さない」だけでなく、**混在時に嘘をつかない**ことがここの目的。
 * ヘッダの使用状況ゲージ・合計コスト・トランスクリプト復元は Claude 由来の仕組みで、
 * Codex / Grok のセッションはそこへ何も供給しない。数字が 0 だから自然に消える、という
 * 偶然に頼っていると「Claude ぶんの合計」を「全体」として出してしまう余地が残る
 * （`AgentCapabilities` を見た明示的な分岐に置き換える。docs/TASKS.md Phase D）。
 */

/** capability を引ける最小の形（`AgentAdapter` の構造部分だけ受ける）。 */
export interface AgentCapabilitySource {
  readonly id: AgentId;
  readonly capabilities: AgentCapabilities;
}

/** `SessionState` のうちここが見る部分だけ（テストから素の値で駆動できるように）。 */
export interface AgentUsageSession {
  readonly agent?: AgentId;
  readonly status: SessionStatus;
}

/** id → capabilities の引き当て（未登録の provider は undefined = 不明）。 */
export type CapabilityLookup = (agent: AgentId | undefined) => AgentCapabilities | undefined;

/**
 * capability の 1 項目。**分からないときは縮退しない**（`true` を返す）。
 *
 * 未登録の provider や `agent` を持たない古いセッションで機能を隠すと、動くはずの
 * 操作が黙って消える（既存の `caps && !caps.setModel` と同じ規約に合わせてある）。
 */
export function supportsCapability(
  caps: AgentCapabilities | undefined,
  key: keyof AgentCapabilities,
): boolean {
  return caps ? caps[key] : true;
}

/** 登録アダプタの一覧から capability の引き当てを作る。 */
export function capabilityLookup(agents: readonly AgentCapabilitySource[]): CapabilityLookup {
  const table = new Map<AgentId, AgentCapabilities>(agents.map((a) => [a.id, a.capabilities]));
  return (agent) => (agent === undefined ? undefined : table.get(agent));
}

/** そのエージェントがその機能を持つか（引き当て + 不明は縮退しない）。 */
export function agentSupports(
  lookup: CapabilityLookup,
  agent: AgentId | undefined,
  key: keyof AgentCapabilities,
): boolean {
  return supportsCapability(lookup(agent), key);
}

/**
 * ヘッダの使用状況ゲージ（アカウント全体の枠）を出すか。
 *
 * ゲージが表しているのは **`usage` を報告する provider のアカウント**の消費であって、
 * codiva 全体の消費ではない。Codex / Grok だけで作業している人に Claude の枠を
 * 出しても読みようがなく（それを埋めているのは別のツール）、5 分ごとの probe
 * サブプロセスも無駄になる。だから「新規セッションの既定」か「まだ生きている
 * セッションのどれか」が `usage` を報告するときだけ出す。
 *
 * `archived` を数えないのは、マージ済みの過去のセッション 1 件で永久に出続けるのを
 * 避けるため（provider を乗り換えた人のヘッダに残る）。
 */
export function showsAccountUsage(input: {
  sessions: readonly AgentUsageSession[];
  defaultAgent?: AgentId;
  capabilities: CapabilityLookup;
}): boolean {
  if (agentSupports(input.capabilities, input.defaultAgent, 'usage')) {
    return true;
  }
  return input.sessions.some(
    (s) => s.status !== 'archived' && agentSupports(input.capabilities, s.agent, 'usage'),
  );
}
