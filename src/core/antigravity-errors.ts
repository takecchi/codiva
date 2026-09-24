import type { AgentStopCause } from './types';

/**
 * Antigravity CLI の失敗文言を {@link AgentStopCause} へ分類する。
 * `claude-errors.ts` / `codex-errors.ts` の Antigravity 版で、**provider 固有の
 * 文言知識はここだけ**が持つ（状態機械は分類結果しか見ない）。
 *
 * 判定順は他 provider と同じく **認証切れが最優先**。認証エラーがタイムアウトに
 * 言及することがあり（実際 `agy` の未認証メッセージは
 * `authentication failed or timed out`）、通信断と読み違えると「ログインし直せ」と
 * 言うべき場面で素の再開を勧めてしまうため。
 *
 * **実測した文言（agy 1.2.10）**:
 * - `Error: authentication required. Run 'agy' to log in, then retry.`（stdin がパイプのとき）
 * - `error: authentication failed or timed out` + `result.error` も同文
 * - `Error: Please sign in to view available models. Launch the CLI without arguments to sign in.`（`agy models`）
 * - `Error: authentication interrupted.`（対話ログインを中断したとき）
 */

/**
 * 認証切れ。待っても再試行しても直らない唯一の失敗なので最優先で判定する。
 * `agy` を素で起動してのサインインが要る。
 */
const AUTH_RE =
  /\b(?:authentication (?:required|failed|interrupted)|please sign in|sign in again|not (?:signed|logged) in|no credentials|invalid api key|incorrect api key|unauthorized|permission denied \(auth|gemini_api_key)\b|(?:api|http) error \d*\s*401|\bhttp 401\b/i;

/**
 * 使用量・レート制限。時間を置けば直るので resumable な idle（`rate_limited`）へ落とす。
 * 無料枠つきの Gemini バックエンドは quota 系の文言を返す。
 */
const RATE_LIMIT_RE =
  /\b(?:rate limit|rate_limit_exceeded|resource_exhausted|usage limit|quota exceeded|exceeded your current quota|insufficient_quota|check your plan and billing)\b|(?:api|http) error \d*\s*429|\bhttp 429\b/i;

/**
 * 通信断・一過性の失敗。**失敗ではなく中断**として扱い、同じ会話を続けられるようにする
 * （`--conversation <id>` で resume できるので、終端の `failed` に落とすと導線が消える）。
 */
const CONNECTION_RE =
  /\b(?:stream (?:disconnected|error|failed)|connection (?:failed|error|reset|closed|refused)|network error|request timed out|timed out|timeout|deadline exceeded|unavailable|server overloaded|at capacity|temporarily unavailable|econnreset|enotfound|etimedout|socket hang up)\b|(?:api|http) error \d*\s*5\d\d|\bhttp 5\d\d\b/i;

/**
 * 「ユーザーが止めた」ときの文言。codiva 側の `Ctrl+C`（`Session.interrupt`）は状態を
 * 先に確定させるので通常はここへ来ないが、CLI 側の都合で落ちた場合の受け皿。
 * 自分で止めたのだから失敗ではないので resumable にする。
 */
const INTERRUPT_RE = /\b(?:canceled|cancelled|interrupted|operation was aborted|aborted)\b/i;

/** Antigravity の失敗文言 → 停止理由。分からないものは `failed`（終端）。 */
export function classifyAntigravityError(text: string): AgentStopCause {
  if (AUTH_RE.test(text)) {
    return 'auth';
  }
  if (RATE_LIMIT_RE.test(text)) {
    return 'rate_limit';
  }
  if (CONNECTION_RE.test(text) || INTERRUPT_RE.test(text)) {
    return 'connection';
  }
  return 'failed';
}
