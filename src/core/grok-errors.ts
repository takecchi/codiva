import type { AgentStopCause } from './types';

/**
 * Grok CLI（`grok agent stdio`）の失敗を {@link AgentStopCause} へ分類する。
 * `core/claude-errors.ts` / `core/codex-errors.ts` の Grok 版で、**provider 固有の
 * 文言知識はここだけ**が持つ（状態機械は分類結果しか見ない）。
 *
 * Grok には他の 2 つに無い手がかりがある: `retry_state` 通知が **CLI 自身の分類**
 * （`error_type`）を運ぶ（実測: `__fixtures__/grok-autherror.jsonl` の
 * `"error_type":"auth"`）。取れるならそちらを優先し、無いときだけ文言を見る。
 *
 * 文言判定の順は Claude / Codex と同じく **認証切れが最優先**。認証エラーが
 * タイムアウトに言及することがあり、通信断と読み違えると「ログインし直せ」と
 * 言うべき場面で素の再開を勧めてしまうため。
 */

/**
 * 認証切れ。待っても再試行しても直らない唯一の失敗なので最優先で判定する。
 * `grok login` のやり直しが要る（実測の文言: `Not signed in. To authenticate ...` /
 * `Unauthorized (401) from ...` / `Incorrect API key provided.`）。
 */
const AUTH_RE =
  /\b(?:not signed in|sign in again|please (?:run )?(?:`?grok login`?|login)|not logged in|no credentials|invalid api key|incorrect api key|unauthorized|authentication (?:failed|required))\b|\(401\)|(?:api|http) error \d*\s*401|\bhttp 401\b/i;

/** 使用量・レート制限。時間を置けば直るので resumable な idle（`rate_limited`）へ。 */
const RATE_LIMIT_RE =
  /\b(?:rate limit|rate_limit_exceeded|usage limit|quota exceeded|insufficient_quota|too many requests|check your plan and billing)\b|\(429\)|(?:api|http) error \d*\s*429|\bhttp 429\b/i;

/** 通信断・一過性の失敗。**失敗ではなく中断**として扱い、同じ会話を続けられるようにする。 */
const CONNECTION_RE =
  /\b(?:stream disconnected|stream (?:error|failed)|connection (?:failed|error|reset|closed)|network error|request timed out|timed out|timeout|server overloaded|temporarily unavailable|econnreset|enotfound|etimedout|socket hang up)\b|\((?:5\d\d)\)|(?:api|http) error \d*\s*5\d\d|\bhttp 5\d\d\b/i;

/** ユーザー/クライアント都合の中止。失敗ではないので resumable にする。 */
const INTERRUPT_RE = /\b(?:cancelled|canceled|aborted|interrupted)\b/i;

/**
 * `retry_state.error_type` の値 → 停止理由。CLI が自分で分けているものを尊重する。
 * 未知の値は文言判定へ落とす（`undefined` を返す）。
 */
export function grokErrorTypeCause(errorType: string | undefined): AgentStopCause | undefined {
  switch (errorType) {
    case 'auth':
      return 'auth';
    case 'rate_limit':
      return 'rate_limit';
    case 'network':
    case 'connection':
      return 'connection';
    default:
      // `api` は 4xx/5xx を一緒くたにするので**文言判定へ委ねる**（ここで `failed` に
      // 丸めると 401 が「よく分からない失敗」に格下げされ、再ログインを促せない）。
      return undefined;
  }
}

/** Grok の失敗文言 → 停止理由。分からないものは `failed`（終端）。 */
export function classifyGrokError(text: string): AgentStopCause {
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
 * `error_type` があればそれを、無ければ文言を見る合成版。アダプタはこれを使う。
 */
export function grokStopCause(text: string, errorType?: string): AgentStopCause {
  return grokErrorTypeCause(errorType) ?? classifyGrokError(text);
}

/**
 * 再試行の実況をログでまとめるための接頭辞。Grok は再接続のたびに `retry_state`
 * を流すので、`AgentEvent.notice` の `coalesceKey` に使って 1 行へ畳む
 * （Codex の `Reconnecting` と同じ扱い）。
 */
export const GROK_RETRY_PREFIX = 'retry:';
