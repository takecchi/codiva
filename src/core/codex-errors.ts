import type { AgentStopCause } from './types';

/**
 * Codex CLI の失敗文言を {@link AgentStopCause} へ分類する。`core/claude-errors.ts` の
 * Codex 版で、**provider 固有の文言知識はここだけ**が持つ（状態機械は分類結果しか見ない）。
 *
 * 文言の出所は Codex の `thiserror` の `#[error("...")]`（`codex-rs/protocol/src/error.rs` /
 * `codex-rs/codex-api/src/error.rs` / `codex-rs/http-client/src/error.rs`）と、実際に採取した
 * 出力（`__fixtures__/codex-auth-error.jsonl` / `codex-failure.jsonl`）。
 *
 * 判定順は Claude 側と同じく **認証切れが最優先**。認証エラーがタイムアウトに言及する
 * ことがあり（トークン更新の失敗）、通信断と読み違えると「ログインし直せ」と言うべき
 * 場面で素の再開を勧めてしまうため。
 */

/**
 * 認証切れ。待っても再試行しても直らない唯一の失敗なので最優先で判定する。
 * `codex login` のやり直しが要る。
 */
const AUTH_RE =
  /\b(?:sign in again|log out and sign in|please (?:run )?(?:`?codex login`?|login)|not logged in|no credentials|refresh token|access token could not be refreshed|invalid api key|incorrect api key|unauthorized|authentication (?:failed|required))\b|(?:api|http) error \d*\s*401|\bhttp 401\b/i;

/**
 * 使用量・レート制限。時間を置けば直るので resumable な idle（`rate_limited`）へ落とす。
 * ChatGPT プラン（"usage limit"）と API 課金（"quota" / "rate_limit_exceeded"）の両方。
 */
const RATE_LIMIT_RE =
  /\b(?:rate limit|rate_limit_exceeded|usage limit|quota exceeded|insufficient_quota|usage not included|check your plan and billing)\b|(?:api|http) error \d*\s*429|\bhttp 429\b/i;

/**
 * 通信断・一過性の失敗。**失敗ではなく中断**として扱い、同じ会話を続けられるようにする。
 * Codex はストリームが切れると `Reconnecting... n/5` を吐いてから最終的にこの文言で落ちる
 * （実測: `__fixtures__/codex-failure.jsonl`）。
 */
const CONNECTION_RE =
  /\b(?:stream disconnected|stream (?:error|failed)|connection (?:failed|error|reset|closed)|network error|request timed out|timed out|timeout|retry limit reached|server overloaded|experiencing high demand|at capacity|temporarily unavailable|econnreset|enotfound|etimedout|socket hang up)\b|(?:api|http) error \d*\s*5\d\d|\bhttp 5\d\d\b/i;

/**
 * Codex が「ユーザーが止めた」ときに使う文言。codiva 側の `Ctrl+C`（`Session.interrupt`）は
 * 状態を先に確定させるので通常はここへ来ないが、CLI 側の都合で落ちた場合の受け皿。
 * 自分で止めたのだから失敗ではないので resumable にする。
 */
const INTERRUPT_RE = /\b(?:interrupted \(ctrl-c\)|turn aborted|operation was aborted|aborted)\b/i;

/** Codex の失敗文言 → 停止理由。分からないものは `failed`（終端）。 */
export function classifyCodexError(text: string): AgentStopCause {
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

/**
 * その `error` 行が「再試行の実況」か。Codex は接続が切れると
 * `Reconnecting... 1/5 (stream disconnected before completion: ...)` を **stdout の
 * JSONL として**流し続けたうえで、諦めたときだけ `turn.failed` を出す（実測）。
 * これをそのまま失敗として扱うと、勝手に回復するセッションが赤くなる。
 */
export function isCodexRetryNotice(message: string): boolean {
  return /^\s*reconnecting\b/i.test(message);
}
