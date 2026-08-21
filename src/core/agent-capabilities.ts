import type { AgentCapabilities } from './agent-ports';
import type { AgentId } from './types';

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
 * ヘッダのアカウント節（プラン名 + 使用状況ゲージ）を出すか。
 *
 * 判定は**新規セッションの既定エージェントだけ**を見る。ヘッダのその節が説明して
 * いるのは「次に動くエージェント」で、プラン / モデル / 使用状況は 1 つのアカウントの
 * 話として並んでいるので、`/agent` で切り替えたら 3 つ揃って切り替わるのが読み方として
 * 一貫している（Codex / Grok を選んでいる人に claude.ai のプラン名と枠を出しても、
 * それを埋めているのは別のツールなので読みようがない）。
 *
 * **稼働中のセッションは見ない**。Claude のセッションが走っている最中に既定を切り替える
 * とその消費は見えなくなるが、既定を戻せばまた出る — 「ヘッダは既定エージェントの説明」
 * という一貫性を、消費を覗ける便利さより優先する（かつては「既定 or archived でない
 * セッションのどれか」で判定していたので、Codex に切り替えても Claude のプランと枠が
 * 残り続けていた）。
 *
 * プラン名も使用状況も**同じ 1 回の probe**（`utils/usage-probe.ts`）が運ぶので、判定も
 * 1 つに束ねてある。表示と取得はこの同じ純関数を通す（`bootstrap/usage-poller.ts` の
 * `enabled`）ので、出していないゲージのために `claude` のサブプロセスが立つことはない。
 */
export function showsAccountInfo(input: {
  defaultAgent?: AgentId;
  capabilities: CapabilityLookup;
}): boolean {
  return agentSupports(input.capabilities, input.defaultAgent, 'usage');
}
