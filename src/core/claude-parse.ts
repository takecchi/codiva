import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { type AgentEvent, type AgentToolKind, applyAgentEvent, type TodoOp } from './agent-events';
import {
  isAuthError,
  isAuthErrorKind,
  isConnectionError,
  isRateLimitError,
  isTransientApiErrorKind,
  isTransientApiStatus,
} from './claude-errors';
import { MAX_LOG_ENTRY_CHARS } from './log-buffer';
import { isPrCreateTool, PR_DETECT_SCAN_CHARS } from './pr-detect';
import type { RateLimitInfoJson } from './rate-limit';
import { USER_INTERRUPT_DETAIL } from './status-reducer';
import type { AgentId, AgentStopCause, SessionState, TaskStatus } from './types';

/**
 * Claude Agent SDK のメッセージの**形**を知る唯一の場所。
 *
 * ここの仕事は「`SDKMessage` を読んで {@link AgentEvent} の列に写す」ことだけで、
 * 状態をどう変えるかは持たない（畳み込みは `core/agent-events.ts` の
 * `applyAgentEvent` が全 provider 共通で行う）。この分割のおかげで、Codex / Grok の
 * アダプタは自分のストリームをこの語彙へ写すだけで済み、ログの上限・サブエージェントの
 * 完了ゲート・PR 検出・コスト集計を再実装しなくてよい。
 *
 * 形は想定で書かない — `src/core/__fixtures__/*.jsonl` の実データでテストする
 * （規約: `.claude/rules/sdk-integration.md`）。
 */

/** Minimal shapes we read out of the (loosely-typed) SDK content blocks. */
interface TextBlock {
  type: 'text';
  text: string;
}
interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}
interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: unknown;
  is_error?: boolean;
}

function asString(v: unknown): string {
  if (typeof v === 'string') {
    return v;
  }
  if (Array.isArray(v)) {
    return v
      .map((b) =>
        b && typeof b === 'object' && 'text' in b ? String((b as { text: unknown }).text) : '',
      )
      .join('');
  }
  return v == null ? '' : JSON.stringify(v);
}

/**
 * Like {@link asString} but materializes at most `limit` characters. Tool results
 * carry whole file reads and command outputs (megabytes), and only their first
 * few hundred characters are ever shown: flattening the entire payload — and then
 * splitting it into every one of its lines — allocated the whole thing on the
 * heap just to throw it away, once per tool call.
 */
function asStringHead(v: unknown, limit: number): string {
  if (typeof v === 'string') {
    return v.slice(0, limit);
  }
  if (Array.isArray(v)) {
    let out = '';
    for (const b of v) {
      if (out.length >= limit) {
        break;
      }
      if (b && typeof b === 'object' && 'text' in b) {
        out += String((b as { text: unknown }).text).slice(0, limit - out.length);
      }
    }
    return out;
  }
  return v == null ? '' : JSON.stringify(v).slice(0, limit);
}

/**
 * Flatten an error `result`'s `errors: string[]` into one string. The error result
 * variants have no `result` field, so this is the only description they carry.
 */
function joinErrors(errors: unknown): string {
  return Array.isArray(errors) ? errors.map((e) => String(e)).join('\n') : '';
}

/**
 * A tool input field as a string, cut to what the log can hold. `Bash` commands
 * carry heredocs with whole file bodies, so building the full string first would
 * allocate megabytes per tool call only for `pushLogEntry` to clip them.
 */
function inputText(value: unknown): string {
  return value == null ? '' : String(value).slice(0, MAX_LOG_ENTRY_CHARS);
}

/** One-line log summary for a tool_use block. Shared with `transcript.ts` (history restore). */
export function summarizeToolUse(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case 'Write':
    case 'Edit':
      return `${name} ${inputText(input.file_path ?? input.path)}`.trim();
    case 'Bash':
      return `Bash ${inputText(input.command)}`.trim();
    case 'TaskCreate':
      return `TaskCreate "${inputText(input.subject)}"`;
    case 'TaskUpdate':
      return `TaskUpdate #${String(input.taskId ?? '')} → ${String(input.status ?? '')}`;
    case 'AskUserQuestion': {
      const questions = (input.questions as { question?: string }[] | undefined) ?? [];
      return `AskUserQuestion: ${questions[0]?.question ?? ''}`;
    }
    default:
      return name;
  }
}

/** How many characters of a tool_result's first line the log keeps. */
const TOOL_RESULT_SUMMARY_CHARS = 200;

/** First line of a flattened payload, capped — the shared log summary shape. */
function firstLine(head: string): string {
  const cut = head.slice(0, TOOL_RESULT_SUMMARY_CHARS);
  const br = cut.search(/[\r\n]/);
  return br === -1 ? cut : cut.slice(0, br);
}

/**
 * One-line log summary for a tool_result block's content (first line, capped).
 * Shared with `transcript.ts` so restored history matches the live log format.
 * Only the first {@link TOOL_RESULT_SUMMARY_CHARS} characters are read out of the
 * payload — the rest of a multi-megabyte result is never materialized.
 */
export function toolResultSummary(content: unknown): string {
  return firstLine(asStringHead(content, TOOL_RESULT_SUMMARY_CHARS));
}

/** Claude のツール名を provider 非依存の「意味」へ写す。 */
function toolKindOf(name: string): AgentToolKind {
  switch (name) {
    case 'Write':
    case 'Edit':
      return 'edit';
    case 'Bash':
      return 'shell';
    case 'TaskCreate':
    case 'TaskUpdate':
    case 'TodoWrite':
      return 'todo';
    case 'AskUserQuestion':
      return 'question';
    default:
      return 'other';
  }
}

/** TaskCreate / TaskUpdate / TodoWrite の入力を中立の {@link TodoOp} へ写す。 */
function todoOpOf(block: ToolUseBlock): TodoOp | undefined {
  if (block.name === 'TaskCreate') {
    return {
      op: 'create',
      subject: String(block.input.subject ?? ''),
      activeForm: block.input.activeForm ? String(block.input.activeForm) : undefined,
    };
  }
  if (block.name === 'TaskUpdate') {
    return {
      op: 'update',
      id: String(block.input.taskId ?? ''),
      status: block.input.status as TaskStatus | undefined,
      subject: block.input.subject ? String(block.input.subject) : undefined,
      activeForm: block.input.activeForm ? String(block.input.activeForm) : undefined,
    };
  }
  if (block.name === 'TodoWrite') {
    const list =
      (block.input.todos as { content?: string; status?: string; activeForm?: string }[]) ?? [];
    return {
      op: 'replace',
      items: list.map((t) => ({
        subject: String(t.content ?? ''),
        status: (t.status as TaskStatus | undefined) ?? 'pending',
        activeForm: t.activeForm ? String(t.activeForm) : undefined,
      })),
    };
  }
  return undefined;
}

/** Log-line prefix for `system/api_retry`; also the key for coalescing them. */
const API_RETRY_PREFIX = 'api retry';

/**
 * `system/task_updated` の `patch.status` のうち「まだ走っている」もの。
 * 決着の判定はこの**否定**で行う — 知らない言い回し（cancelled / killed / timed_out …）が
 * 来ても決着側に倒したいため（決着を取りこぼすと完了ゲートが解けず、セッションが
 * 永久に `running` になる）。
 */
const LIVE_TASK_STATUSES = new Set(['pending', 'queued', 'created', 'in_progress', 'running']);

/** `system/task_updated` の patch が「タスクが終わった」ことを示しているか。 */
function isSettledTaskPatch(patch: unknown): boolean {
  if (typeof patch !== 'object' || patch === null) {
    return false;
  }
  const status = (patch as { status?: unknown }).status;
  return typeof status === 'string' && !LIVE_TASK_STATUSES.has(status);
}

/** `system/*` を写す。 */
function fromSystem(message: Record<string, unknown>): AgentEvent[] {
  if (message.subtype === 'init') {
    return [
      {
        kind: 'session_started',
        sessionId: typeof message.session_id === 'string' ? message.session_id : undefined,
        // init carries the *resolved* model even when config left it unset.
        model: typeof message.model === 'string' ? message.model : undefined,
      },
    ];
  }
  // サブエージェント（Task ツール）のライフサイクル。バックグラウンド化された Task が
  // 走っている間にトップレベルの result が届くため、完了ゲートとして数える。
  // `skip_transcript` の雑務タスクはゲート対象外。
  if (message.subtype === 'task_started') {
    if (message.skip_transcript === true || typeof message.task_id !== 'string') {
      return [];
    }
    return [{ kind: 'task_started', taskId: message.task_id }];
  }
  if (message.subtype === 'task_notification') {
    return [
      {
        kind: 'task_settled',
        taskId: typeof message.task_id === 'string' ? message.task_id : undefined,
      },
    ];
  }
  // `task_updated` の `patch.status` も決着の信号（実測: `patch: { status: 'completed',
  // end_time: ... }` が `task_notification` の直前に来る）。**両方**見るのは、
  // 通知が来ないまま終わるタスク（TaskStop で止めた・落ちた）でも完了ゲートを
  // 解けるようにするため — 解けないとセッションが永久に `running` に張り付く。
  // 判定は「まだ走っている状態の否定」で書く（知らない言い回しでも決着側に倒す）。
  if (
    message.subtype === 'task_updated' &&
    typeof message.task_id === 'string' &&
    isSettledTaskPatch(message.patch)
  ) {
    return [{ kind: 'task_settled', taskId: message.task_id }];
  }
  // リトライ可能な API 失敗。CLI が再試行するのでセッションは走ったままで、
  // ログに 1 行残すだけ（連発するので直前の同種行を書き換える）。
  if (message.subtype === 'api_retry') {
    const attempt = typeof message.attempt === 'number' ? message.attempt : undefined;
    const max = typeof message.max_retries === 'number' ? message.max_retries : undefined;
    const of = attempt !== undefined && max !== undefined ? ` ${attempt}/${max}` : '';
    const kind = typeof message.error === 'string' ? message.error : 'error';
    // `error_status` は HTTP 応答すら無かった接続断では null なので、あるときだけ出す。
    const status = typeof message.error_status === 'number' ? ` ${message.error_status}` : '';
    return [
      {
        kind: 'notice',
        text: `${API_RETRY_PREFIX}${of}: ${kind}${status}`,
        coalesceKey: API_RETRY_PREFIX,
      },
    ];
  }
  return [];
}

/** `assistant` の本体（content ブロック）を写す。 */
function fromAssistantBlocks(message: Record<string, unknown>): AgentEvent[] {
  const inner = message.message as { content?: unknown; model?: unknown } | undefined;
  const content = Array.isArray(inner?.content) ? inner.content : [];
  const timestamp = typeof message.timestamp === 'number' ? message.timestamp : undefined;
  // 各アシスタントメッセージは自分を生成したモデルを報告するので、途中のモデル切替も
  // 追える（init は最初にしか来ない）。
  const model =
    typeof inner?.model === 'string' && inner.model.length > 0 ? inner.model : undefined;

  const events: AgentEvent[] = [{ kind: 'assistant_message', model }];
  for (const raw of content) {
    if (!raw || typeof raw !== 'object') {
      continue;
    }
    const block = raw as { type?: string };
    if (block.type === 'text') {
      events.push({ kind: 'assistant_text', text: (raw as TextBlock).text, timestamp });
    } else if (block.type === 'tool_use') {
      const tu = raw as ToolUseBlock;
      events.push({
        kind: 'tool_use',
        id: typeof tu.id === 'string' ? tu.id : undefined,
        summary: summarizeToolUse(tu.name, tu.input ?? {}),
        tool: toolKindOf(tu.name),
        todo: todoOpOf(tu),
        // 「このセッションが出した PR」は結果にしか URL が無いので、作成コマンドの
        // tool_use id を控えて次の tool_result と突き合わせる（core/pr-detect.ts）。
        prCreate: isPrCreateTool(tu.name, tu.input ?? {}) || undefined,
        timestamp,
      });
    }
  }
  return events;
}

/** `user`（= tool_result の運び手）を写す。 */
function fromUser(message: Record<string, unknown>): AgentEvent[] {
  const inner = message.message as { content?: unknown } | undefined;
  const content = Array.isArray(inner?.content) ? inner.content : [];
  const events: AgentEvent[] = [];
  for (const raw of content) {
    if (raw && typeof raw === 'object' && (raw as { type?: string }).type === 'tool_result') {
      const tr = raw as ToolResultBlock;
      // ログ用の要約は先頭 1 行しか使わないが、PR の URL は数行下に出るので少し深く
      // 読む（上限付き）。1 回の走査で両方を作り、巨大な payload は決して展開しない。
      const head = asStringHead(tr.content, PR_DETECT_SCAN_CHARS);
      events.push({
        kind: 'tool_result',
        toolUseId: tr.tool_use_id,
        summary: firstLine(head),
        scanText: head,
      });
    }
  }
  return events;
}

/**
 * `includePartialMessages` の部分メッセージ。ライブプレビューに使う増分テキストだけを
 * 拾う（ツール入力の JSON や thinking の delta は UI 状態を変えない）。
 */
function fromStreamEvent(message: Record<string, unknown>): AgentEvent[] {
  const event = message.event;
  if (!event || typeof event !== 'object') {
    return [];
  }
  const ev = event as { type?: string; delta?: unknown };
  if (ev.type === 'message_start') {
    return [{ kind: 'stream_reset' }];
  }
  if (ev.type === 'content_block_delta') {
    const delta = ev.delta as { type?: string; text?: string } | undefined;
    if (delta?.type === 'text_delta' && typeof delta.text === 'string' && delta.text.length > 0) {
      return [{ kind: 'stream_text', text: delta.text }];
    }
  }
  return [];
}

/**
 * ターン終了の `result` を写す。
 *
 * `subtype: 'success'` **だけでは成功を意味しない** — CLI は認証切れや拒否された
 * リクエストも success + `is_error: true` で報告する（`terminal_reason` は `api_error`）。
 * subtype だけを信じたせいで、何も作業していないセッションが緑の "Completed" に
 * なる不具合が実際に起きた。
 */
function fromResult(message: Record<string, unknown>): AgentEvent[] {
  const totalCostUsd =
    typeof message.total_cost_usd === 'number' ? message.total_cost_usd : undefined;
  const subtype = String(message.subtype ?? 'error');
  // `result` は success 版にしか無く、エラー版は `errors[]` を持つので両方読む。
  const resultText = asString(message.result) || joinErrors(message.errors);
  const isError = message.is_error === true;

  if (subtype === 'success' && !isError) {
    return [{ kind: 'turn_completed', text: resultText, totalCostUsd }];
  }

  // is_error な success では subtype に情報が無いので、結果テキストが唯一の説明。
  const error = subtype === 'success' ? resultText || 'error' : subtype;
  const stop = (cause: AgentStopCause, detail: string): AgentEvent[] => [
    { kind: 'turn_stopped', cause, detail, totalCostUsd, rollup: true },
  ];

  // 認証切れを最優先（待っても再試行しても直らない唯一の失敗）。
  if (isAuthError(error) || isAuthError(resultText)) {
    return stop('auth', resultText || error);
  }
  if (isRateLimitError(error) || isRateLimitError(resultText)) {
    return stop('rate_limit', resultText || error);
  }
  if (isConnectionError(error) || isConnectionError(resultText)) {
    return stop('connection', resultText || error);
  }
  // ユーザーの Ctrl+C。CLI は `terminal_reason: 'aborted_streaming'` でターンを閉じる
  // （実測: `__fixtures__/session-interrupt.jsonl`）。**自分で止めたのだから失敗ではない**
  // ので resumable にする。判定は文言ではなく構造で行い、`errors[]` の内部診断は
  // ユーザーに見せる意味がないので固定文言を書く。
  if (message.terminal_reason === 'aborted_streaming') {
    return stop('connection', USER_INTERRUPT_DETAIL);
  }
  // 同じ種類の停止の構造的フォールバック。CLI は API エラーのターンを
  // `terminal_reason: 'api_error'` で閉じ、HTTP 応答が無かった接続断では
  // `api_error_status` が明示的に null になる。文言は何通りもあり変わるので、
  // 知らない言い回しでも resumable に着地させる。
  if (message.terminal_reason === 'api_error' && isTransientApiStatus(message.api_error_status)) {
    return stop('connection', resultText || error);
  }
  return stop('failed', error);
}

/**
 * 生の `SDKMessage` 1 通を中立イベント列へ写す。**アダプタの入口**。
 * 状態は見ない（純粋・メッセージ単位で決まる）。
 */
export function parseClaudeMessage(message: SDKMessage): AgentEvent[] {
  const raw = message as unknown as Record<string, unknown>;
  const type = raw.type as string;

  if (type === 'system') {
    return fromSystem(raw);
  }

  if (type === 'rate_limit_event') {
    const info = raw.rate_limit_info as RateLimitInfoJson | undefined;
    const events: AgentEvent[] = [];
    if (info) {
      // アカウント全体の使用状況（セッション状態ではない）は横へ流す。
      events.push({ kind: 'usage', info });
    }
    // `rejected` は「リクエストが弾かれている」= セッションが止まっている。
    // `allowed` / `allowed_warning` はまだ通っているので状態は変えない。
    if (info?.status === 'rejected') {
      events.push({
        kind: 'turn_stopped',
        cause: 'rate_limit',
        detail: 'rate limit reached',
        resetsAt: info.resetsAt,
      });
    }
    return events;
  }

  if (type === 'assistant') {
    // ターンがレート/使用量制限で弾かれた（トップレベルの error フィールド）。
    if (raw.error === 'rate_limit') {
      return [{ kind: 'turn_stopped', cause: 'rate_limit', detail: 'rate limit reached' }];
    }
    // 認証できなかった。typed な `error` kind が主信号で、人が読める理由は本文にある。
    // ここで捕まえるので文言に依存せず、これを要約する `result` は同じ失敗として
    // no-op になる（`rollup`）。
    if (isAuthErrorKind(raw.error)) {
      const inner = raw.message as { content?: unknown } | undefined;
      const text = asString(inner?.content).trim();
      return [{ kind: 'turn_stopped', cause: 'auth', detail: text || String(raw.error) }];
    }
    // API 呼び出しが一過性の理由で失敗した（多くは応答ストリームが途中で切れた）。
    // 届いていた内容は通常のアシスタントメッセージとして既に配られていて、この
    // フラグ付きメッセージは通知だけを運ぶ。緑の "Completed" にせず resumable にする。
    //
    // トップレベルのターンのみ（`parent_tool_use_id` が null）: 同じ失敗が
    // サブエージェント内で起きた場合は失敗した tool_result として本流へ報告され、
    // Claude が再試行や回避をできるので、セッションは走り続けてよい。
    if (isTransientApiErrorKind(raw.error) && raw.parent_tool_use_id == null) {
      const inner = raw.message as { content?: unknown } | undefined;
      const text = asString(inner?.content).trim();
      return [{ kind: 'turn_stopped', cause: 'connection', detail: text || String(raw.error) }];
    }
    return fromAssistantBlocks(raw);
  }

  if (type === 'user') {
    return fromUser(raw);
  }

  if (type === 'stream_event') {
    return fromStreamEvent(raw);
  }

  if (type === 'result') {
    return fromResult(raw);
  }

  // thinking_tokens やその他の未処理メッセージ — 状態は変わらない。
  return [];
}

/**
 * 生の `SDKMessage` 1 通をセッション状態へ畳み込む（parse → 共通の fold）。
 *
 * 旧 `applySdkMessage`。中身は 2 段に分かれたが**外から見た振る舞いは同じ**で、
 * 1,100 行超の実データテスト（`claude-parse.spec.ts` + `__fixtures__/*.jsonl`）が
 * そのままこの入口を叩き続けられるようにしてある — 分割のリグレッション網。
 *
 * `agent` を渡すと各ログ行に発言者を刻む。単一エージェントのセッションでは
 * undefined のまま（既存のログ行の形を変えないため。刻むのは
 * `Session.setAgent()` で切り替えが起きた後だけ）。
 */
export function applyClaudeMessage(
  state: SessionState,
  message: SDKMessage,
  at: number,
  agent?: AgentId,
): SessionState {
  let next = state;
  for (const event of parseClaudeMessage(message)) {
    next = applyAgentEvent(next, event, at, agent);
  }
  return next;
}
