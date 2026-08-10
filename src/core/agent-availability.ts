import type { AgentAvailability } from './agent-ports';
import type { AgentId } from './types';

/**
 * 自動選択の優先順位（設定 `agent` が無いとき、導入済みのうち先頭を既定にする）。
 * codiva の元々の既定が Claude なので Claude を先に置く。
 */
export const DEFAULT_AGENT_ORDER: readonly AgentId[] = ['claude', 'codex'];

/**
 * 新規セッションを既定でどのエージェントで動かすかを決める純関数。
 *
 * 方針:
 * - **明示設定（`config.agent`）が登録済みなら必ずそれ**。導入されていなくても尊重する
 *   （UI が「使えません・導入してください」と案内する側に回るので、勝手に別 provider へ
 *   すり替えない）。
 * - 設定が無いときだけ**導入済みのものを自動で選ぶ**（`order` の先頭優先）。これが
 *   「設定ファイルを書かなくても、入っている方で動く」を成立させる。
 * - どれも導入されていなければ `order` の先頭（登録済み）に倒す。UI がセットアップを促す。
 *
 * `availability` は非同期検出の結果で、検出前は空でよい（その場合は「導入済み扱い」で
 * `order` 先頭になる）。
 */
export function resolveDefaultAgentId(
  configured: AgentId | undefined,
  registered: readonly AgentId[],
  availability: ReadonlyMap<AgentId, AgentAvailability>,
  order: readonly AgentId[],
): AgentId | undefined {
  const isRegistered = (id: AgentId): boolean => registered.includes(id);
  if (configured && isRegistered(configured)) {
    return configured;
  }
  const installed = order.find((id) => isRegistered(id) && availability.get(id)?.installed);
  if (installed) {
    return installed;
  }
  return order.find(isRegistered) ?? registered[0];
}

/**
 * 「今すぐ新しいセッションを開始できるエージェントが 1 つも無い」か。
 * = 登録済みのどれも導入されていない。ここが true のとき、UI はセットアップ案内を出す。
 *
 * `loggedIn` は見ない — 導入済みでログイン切れなら、セッションを作って `needs_login` で
 * 気付ける（「入っているが未ログイン」は「入っていない」とは別物）。検出前（availability に
 * 情報が無い）は false（＝まだ分からないので案内を出さない）。
 */
export function noAgentInstalled(
  registered: readonly AgentId[],
  availability: ReadonlyMap<AgentId, AgentAvailability>,
): boolean {
  if (registered.length === 0) {
    return true;
  }
  // 1 件でも「検出済みかつ導入済み」があれば案内は不要。検出できていない（情報なし）は
  // 「まだ分からない」なので導入済みとはみなさないが、案内も出さない（下の判定）。
  const anyInstalled = registered.some((id) => availability.get(id)?.installed === true);
  if (anyInstalled) {
    return false;
  }
  // まだ 1 件も検出結果が無いなら「分からない」= 案内しない。全件が「未導入」と確定して
  // 初めて案内する。
  const allResolved = registered.every((id) => availability.has(id));
  return allResolved;
}
