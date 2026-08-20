import type { AgentId } from './types';

/**
 * 「どのセッションが何で走っているか」を出すための純粋なヘルパ。
 *
 * 状態には `SessionState.agent` / `LogEntry.agent` が載っているが、長らく**どこにも
 * 描いていなかった**（docs/TASKS.md Phase D）。表示名そのものはアダプタが持つ固有名詞
 * （`AgentAdapter.displayName`）なので、ここが持つのは「誰の行か」と「列を出すか」の判定だけ。
 */

/**
 * `agent` を持たない状態を読むときの既定。エージェント切替に対応する前に保存された
 * スナップショットの復元（`core/persistence.ts`）と同じ扱いに揃えてある。
 */
const FALLBACK_AGENT: AgentId = 'claude';

/** そのセッションを駆動している provider（未設定 = 切替対応より前の状態は既定扱い）。 */
export function sessionAgentId(session: { agent?: AgentId }): AgentId {
  return session.agent ?? FALLBACK_AGENT;
}

/**
 * 一覧に並んでいるセッションが 2 種類以上の provider で走っているか。
 *
 * 列を**常に**出さないのはヘッダに既定エージェントが出ているから: 全部同じ provider
 * なら 1 行ぶんの情報が全行で重複するだけで、狭い端末では title / branch から幅を
 * 奪う。混ざった瞬間だけ「どれが何か」が読めれば足りる。
 */
export function usesMultipleAgents(sessions: readonly { agent?: AgentId }[]): boolean {
  const seen = new Set<AgentId>();
  for (const session of sessions) {
    seen.add(sessionAgentId(session));
    if (seen.size > 1) {
      return true;
    }
  }
  return false;
}
