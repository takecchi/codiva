import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import {
  isAuthError,
  isAuthErrorKind,
  isConnectionError,
  isTransientApiErrorKind,
  isTransientApiStatus,
} from './errors';
import { clipLogText, clipStreamText, MAX_LOG_ENTRY_CHARS, pushLogEntry } from './log-buffer';
import { isResumable } from './status-meta';
import {
  appendLog,
  isRateLimitError,
  progressOf,
  toInterrupted,
  toNeedsLogin,
  toRateLimited,
} from './status-reducer';
import type { SessionState, TaskStatus, TodoItem } from './types';

/**
 * All knowledge of the SDK message *shape* lives here. `Session.consume` feeds each
 * raw `SDKMessage` to `applySdkMessage`, which parses it (content blocks, subtypes,
 * stream events) and folds it into the session state via the same log/state helpers
 * the pure reducer uses. This keeps `status-reducer.ts` free of `message.type` /
 * `message.subtype` parsing — it only handles the typed `CodivaEvent` union.
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
 * ~200 characters are ever shown: flattening the entire payload — and then
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

/**
 * One-line log summary for a tool_result block's content (first line, capped).
 * Shared with `transcript.ts` so restored history matches the live log format.
 * Only the first {@link TOOL_RESULT_SUMMARY_CHARS} characters are read out of the
 * payload — the rest of a multi-megabyte result is never materialized.
 */
export function toolResultSummary(content: unknown): string {
  const head = asStringHead(content, TOOL_RESULT_SUMMARY_CHARS);
  const br = head.search(/[\r\n]/);
  return br === -1 ? head : head.slice(0, br);
}

/** Apply a TaskCreate/TaskUpdate/TodoWrite tool_use block to the todo list. */
function applyTaskTool(todos: TodoItem[], block: ToolUseBlock): TodoItem[] {
  if (block.name === 'TaskCreate') {
    const next: TodoItem = {
      id: String(todos.length + 1),
      subject: String(block.input.subject ?? ''),
      status: 'pending',
      activeForm: block.input.activeForm ? String(block.input.activeForm) : undefined,
    };
    return [...todos, next];
  }

  if (block.name === 'TaskUpdate') {
    const taskId = String(block.input.taskId ?? '');
    return todos.map((t) => {
      if (t.id !== taskId) {
        return t;
      }
      return {
        ...t,
        status: (block.input.status as TaskStatus | undefined) ?? t.status,
        subject: block.input.subject ? String(block.input.subject) : t.subject,
        activeForm: block.input.activeForm ? String(block.input.activeForm) : t.activeForm,
      };
    });
  }

  if (block.name === 'TodoWrite') {
    const list =
      (block.input.todos as { content?: string; status?: string; activeForm?: string }[]) ?? [];
    return list.map((t, i) => ({
      id: String(i + 1),
      subject: String(t.content ?? ''),
      status: (t.status as TaskStatus | undefined) ?? 'pending',
      activeForm: t.activeForm ? String(t.activeForm) : undefined,
    }));
  }

  return todos;
}

/**
 * Finalize a successful turn into `completed`, appending the result text (if any)
 * to the log. Shared by the direct path (no sub-agent work in flight) and the
 * deferred path (a `result` that had to wait for the last sub-agent task to settle).
 */
function completeWith(
  state: SessionState,
  result: { at: number; totalCostUsd?: number; resultText: string },
): SessionState {
  // The SDK's success `result` text echoes the final assistant message, which is
  // already in the log as an `assistant_text` entry (verified against real
  // fixtures — the two strings are identical). Appending it again as a `result`
  // line doubles the last message on screen (white assistant_text + green
  // result). Log the result only when it carries something new, matching the
  // restore path (transcript.ts never emits a `result` entry). assistant_text is
  // stored trimmed, so trim the result before comparing — and stored *clipped*
  // (log-buffer), so compare the clipped forms: otherwise an answer longer than
  // MAX_LOG_ENTRY_CHARS stops matching its own echo and shows up twice.
  const resultText = result.resultText.trim();
  const lastAssistantText = state.messages.findLast((m) => m.kind === 'assistant_text')?.text;
  const isEcho = resultText.length > 0 && clipLogText(resultText) === lastAssistantText;
  const withLog =
    resultText.length > 0 && !isEcho
      ? appendLog(state, 'result', resultText)
      : { messages: state.messages, logSeq: state.logSeq };
  // Drop the transient deferral bookkeeping — the turn is genuinely done now.
  const { deferredResult, activeTaskIds, ...rest } = state;
  void deferredResult;
  void activeTaskIds;
  return {
    ...rest,
    status: 'completed',
    finishedAt: result.at,
    totalCostUsd: result.totalCostUsd,
    streamingText: undefined,
    messages: withLog.messages,
    logSeq: withLog.logSeq,
  };
}

/**
 * `system/task_started`: a sub-agent (Task tool) began. Track its id so a `result`
 * that arrives while it is still running is recognized as premature (a backgrounded
 * Task returns its tool_result immediately and the top-level turn continues). Ambient
 * housekeeping tasks (`skip_transcript`) are ignored — they must not gate completion.
 */
function onTaskStarted(state: SessionState, message: Record<string, unknown>): SessionState {
  if (message.skip_transcript === true) {
    return state;
  }
  const taskId = typeof message.task_id === 'string' ? message.task_id : undefined;
  if (taskId === undefined) {
    return state;
  }
  const active = state.activeTaskIds ?? [];
  if (active.includes(taskId)) {
    return state;
  }
  return { ...state, activeTaskIds: [...active, taskId] };
}

/**
 * `system/task_notification`: a sub-agent task settled (completed/failed/stopped).
 * Drop it from the in-flight set; if that empties the set and a `result` was already
 * deferred, finalize the completion now (the turn really is done). We only finalize
 * a still-`running` session — a session that meanwhile failed/was aborted must not be
 * flipped to completed by a late notification.
 */
function onTaskSettled(
  state: SessionState,
  message: Record<string, unknown>,
  at: number,
): SessionState {
  const taskId = typeof message.task_id === 'string' ? message.task_id : undefined;
  const active = state.activeTaskIds ?? [];
  const nextActive = taskId ? active.filter((id) => id !== taskId) : active;
  if (nextActive.length === 0 && state.deferredResult && state.status === 'running') {
    return completeWith(state, { ...state.deferredResult, at });
  }
  if (nextActive.length === active.length) {
    return state;
  }
  return { ...state, activeTaskIds: nextActive };
}

/** Log-line prefix for `system/api_retry`; also the key for coalescing them. */
const API_RETRY_PREFIX = 'api retry';

/**
 * `system/api_retry`: an API request failed with a retryable error and the CLI is
 * about to retry it after a delay. Informational only (state doesn't change), but
 * worth a log line: without it a flaky connection looks exactly like the session
 * hanging, and when the retries do run out the `interrupted` notice arrives with no
 * trace of what led up to it. `error_status` is null for connection-level failures
 * that never got an HTTP response, so it is only shown when present.
 *
 * Retries arrive in bursts (up to `max_retries` per request), so consecutive ones
 * *rewrite* the same log line (keeping its seq) instead of appending one per attempt
 * — a flaky connection must not push the actual conversation out of the viewport.
 */
function onApiRetry(state: SessionState, message: Record<string, unknown>): SessionState {
  const attempt = typeof message.attempt === 'number' ? message.attempt : undefined;
  const max = typeof message.max_retries === 'number' ? message.max_retries : undefined;
  const of = attempt !== undefined && max !== undefined ? ` ${attempt}/${max}` : '';
  const kind = typeof message.error === 'string' ? message.error : 'error';
  const status = typeof message.error_status === 'number' ? ` ${message.error_status}` : '';
  const text = `${API_RETRY_PREFIX}${of}: ${kind}${status}`;
  // Matching on our own prefix is enough to tell "the previous line is a retry
  // counter" — no other producer writes it.
  const last = state.messages.at(-1);
  if (last?.kind === 'system' && last.text.startsWith(API_RETRY_PREFIX)) {
    return { ...state, messages: [...state.messages.slice(0, -1), { ...last, text }] };
  }
  const withLog = appendLog(state, 'system', text);
  return { ...state, messages: withLog.messages, logSeq: withLog.logSeq };
}

function reduceAssistant(state: SessionState, message: Record<string, unknown>): SessionState {
  const inner = message.message as { content?: unknown; model?: unknown } | undefined;
  const content = Array.isArray(inner?.content) ? inner.content : [];
  const timestamp = typeof message.timestamp === 'number' ? message.timestamp : undefined;
  // Each assistant message reports the model that produced it — track it so a
  // mid-session model switch is reflected (init only fires at the start).
  const model =
    typeof inner?.model === 'string' && inner.model.length > 0 ? inner.model : state.model;

  let todos = state.todos;
  let messages = state.messages;
  let logSeq = state.logSeq;

  for (const raw of content) {
    if (!raw || typeof raw !== 'object') {
      continue;
    }
    const block = raw as { type?: string };
    if (block.type === 'text') {
      const text = (raw as TextBlock).text.trim();
      if (text.length > 0) {
        const seq = logSeq + 1;
        messages = pushLogEntry(messages, { seq, kind: 'assistant_text', text, timestamp });
        logSeq = seq;
      }
    } else if (block.type === 'tool_use') {
      const tu = raw as ToolUseBlock;
      todos = applyTaskTool(todos, tu);
      const seq = logSeq + 1;
      messages = pushLogEntry(messages, {
        seq,
        kind: 'tool_use',
        text: summarizeToolUse(tu.name, tu.input ?? {}),
        timestamp,
      });
      logSeq = seq;
    }
  }

  // Don't downgrade a blocked session back to running. The `assistant` message
  // that carries an AskUserQuestion/tool_use arrives out-of-band from the
  // canUseTool control callback that set pendingPermission; if canUseTool won
  // the race we're already awaiting_input/awaiting_permission and must stay
  // there (otherwise the badge flips back to "Running" with a question pending).
  const nextStatus = state.pendingPermission ? state.status : 'running';

  // The full assistant message is authoritative — drop the streamed preview.
  if (messages === state.messages && todos === state.todos) {
    if (state.status === nextStatus && state.streamingText === undefined && model === state.model) {
      return state;
    }
    return { ...state, status: nextStatus, streamingText: undefined, model };
  }
  return {
    ...state,
    status: nextStatus,
    todos,
    progress: progressOf(todos),
    messages,
    logSeq,
    streamingText: undefined,
    model,
  };
}

/**
 * A partial (streaming) assistant message from `includePartialMessages`. We only
 * surface incremental text so the detail view can show a live "typing" preview;
 * the full `assistant` message that follows replaces it. Non-text deltas
 * (tool-input JSON, thinking, etc.) don't change UI state.
 */
function reduceStreamEvent(state: SessionState, message: Record<string, unknown>): SessionState {
  const event = message.event;
  if (!event || typeof event !== 'object') {
    return state;
  }
  const ev = event as { type?: string; delta?: unknown };
  if (ev.type === 'message_start') {
    // A new assistant message begins — start its preview fresh.
    return state.streamingText === undefined ? state : { ...state, streamingText: undefined };
  }
  if (ev.type === 'content_block_delta') {
    const delta = ev.delta as { type?: string; text?: string } | undefined;
    // Guard non-empty text so an empty delta stays a no-op (same reference).
    if (delta?.type === 'text_delta' && typeof delta.text === 'string' && delta.text.length > 0) {
      return {
        ...state,
        // Keep a blocked session (pendingPermission) in its awaiting_* status;
        // only an unblocked stream implies the model is actively running.
        status: state.pendingPermission ? state.status : 'running',
        // Only the tail is ever rendered (one preview line), and the buffer is
        // re-split on every frame — so don't carry a whole message around.
        streamingText: clipStreamText((state.streamingText ?? '') + delta.text),
      };
    }
  }
  return state;
}

function reduceUser(state: SessionState, message: Record<string, unknown>): SessionState {
  const inner = message.message as { content?: unknown } | undefined;
  const content = Array.isArray(inner?.content) ? inner.content : [];
  let messages = state.messages;
  let logSeq = state.logSeq;
  for (const raw of content) {
    if (raw && typeof raw === 'object' && (raw as { type?: string }).type === 'tool_result') {
      const tr = raw as ToolResultBlock;
      const text = toolResultSummary(tr.content);
      if (text.length > 0) {
        const seq = logSeq + 1;
        messages = pushLogEntry(messages, { seq, kind: 'tool_result', text });
        logSeq = seq;
      }
    }
  }
  if (messages === state.messages) {
    return state;
  }
  return { ...state, messages, logSeq };
}

function reduceSdk(
  state: SessionState,
  message: Record<string, unknown>,
  at: number,
): SessionState {
  const type = message.type as string;

  if (type === 'system') {
    if (message.subtype === 'init') {
      const sid = typeof message.session_id === 'string' ? message.session_id : state.sdkSessionId;
      // init carries the *resolved* model even when config left it unset.
      const model = typeof message.model === 'string' ? message.model : state.model;
      return {
        ...state,
        // pendingPermission がある間は awaiting_* を維持する（#37 と同じ不変条件）。
        // 通常の初回 init は pending 無し（creating → running）で通り、保留中に
        // 別の init が来ても質問ダイアログの裏で "Running" に戻さない。
        status: state.pendingPermission ? state.status : 'running',
        sdkSessionId: sid ?? state.sdkSessionId,
        model,
      };
    }
    // Sub-agent (Task tool) lifecycle — track in-flight tasks so a backgrounded
    // Task can't let the top-level `result` mark the session completed early.
    if (message.subtype === 'task_started') {
      return onTaskStarted(state, message);
    }
    if (message.subtype === 'task_notification') {
      return onTaskSettled(state, message, at);
    }
    // A retryable API failure (the connection dropped, the upstream is at
    // capacity): the CLI is retrying, so the session stays running — we only note
    // it in the log.
    if (message.subtype === 'api_retry') {
      return onApiRetry(state, message);
    }
    return state;
  }

  if (type === 'rate_limit_event') {
    // Structured signal: `rejected` means requests are being turned away — the
    // session is blocked. `allowed` / `allowed_warning` are informational (still
    // serving), so they leave state untouched.
    const info = message.rate_limit_info as { status?: string; resetsAt?: number } | undefined;
    if (info?.status === 'rejected') {
      return toRateLimited(state, at, 'rate limit reached', info.resetsAt);
    }
    return state;
  }

  if (type === 'assistant') {
    // The turn was rejected by a rate/usage limit (top-level SDK error field).
    if (message.error === 'rate_limit') {
      return toRateLimited(state, at, 'rate limit reached');
    }
    // Claude could not authenticate. This typed `error` kind is the primary auth
    // signal: the CLI flags the (virtual) assistant message it synthesizes for the
    // failure, and the human-readable reason is its text content. Catching it here
    // means we don't depend on the wording — the `result` that rolls this up is
    // then recognized as the same failure and stays a no-op (see toNeedsLogin).
    if (isAuthErrorKind(message.error)) {
      const inner = message.message as { content?: unknown } | undefined;
      const text = asString(inner?.content).trim();
      return toNeedsLogin(state, at, text || String(message.error));
    }
    // The API call failed transiently — most often the response stream was cut
    // partway (`API Error: Connection closed mid-response. The response above may
    // be incomplete.`). Whatever content had already arrived was delivered as
    // ordinary assistant messages before this one; this flagged message carries
    // only the notice, and it ends the turn with a truncated answer. So land on
    // `interrupted` (resumable) rather than logging the notice as ordinary
    // assistant text and letting the roll-up result show a green "Completed".
    //
    // Only for the top-level turn (`parent_tool_use_id` null): the same failure
    // inside a sub-agent (Task) is reported to the main turn as a failed
    // tool_result, which Claude can retry or work around — the session keeps
    // running and its own `result` decides the end state. (The auth check above
    // needs no such guard: credentials are global, so a sub-agent hitting an
    // expired login means the whole session is stuck.)
    if (isTransientApiErrorKind(message.error) && message.parent_tool_use_id == null) {
      const inner = message.message as { content?: unknown } | undefined;
      const text = asString(inner?.content).trim();
      return toInterrupted(state, at, text || String(message.error));
    }
    return reduceAssistant(state, message);
  }

  if (type === 'user') {
    return reduceUser(state, message);
  }

  if (type === 'stream_event') {
    return reduceStreamEvent(state, message);
  }

  if (type === 'result') {
    const cost =
      typeof message.total_cost_usd === 'number' ? message.total_cost_usd : state.totalCostUsd;
    const subtype = String(message.subtype ?? 'error');
    // `result` is only carried by the success variant; the error variants carry
    // `errors[]` instead (SDKResultSuccess vs SDKResultError), so read both.
    const resultText = asString(message.result) || joinErrors(message.errors);
    // `subtype: 'success'` on its own does NOT mean the turn succeeded — the CLI
    // also reports API-level stops (an expired login, a refused request) with a
    // success subtype plus `is_error: true`, putting the message in `result` (its
    // `terminal_reason` is then `api_error`). Trusting the subtype alone is what
    // made an expired OAuth session show up as a green "Completed" for a session
    // that never did any work.
    const isError = message.is_error === true;
    if (subtype === 'success' && !isError) {
      // A sub-agent (Task) is still running: this top-level `result` arrived
      // because the Task was backgrounded and returned its tool_result early. The
      // session is NOT actually done — hold the result and stay `running` until
      // the last task settles (`task_notification` → onTaskSettled finalizes it).
      if ((state.activeTaskIds?.length ?? 0) > 0) {
        return {
          ...state,
          totalCostUsd: cost,
          streamingText: undefined,
          deferredResult: { at, totalCostUsd: cost, resultText },
        };
      }
      return completeWith(state, { at, totalCostUsd: cost, resultText });
    }
    // For an `is_error` success the subtype carries no information, so the result
    // text is the only description of what stopped the turn.
    const error = subtype === 'success' ? resultText || 'error' : subtype;
    // The stop was already diagnosed while the turn was ending: the CLI flags the
    // assistant message it synthesizes for an expired login / a usage limit / a cut
    // response with a *typed* error kind, which is more precise than any wording
    // check. This result only rolls that up, so keep the diagnosis and take nothing
    // from it but the cost — re-classifying from its text would downgrade a "log in
    // again" (or a "wait for the reset") to a dead-end `failed` whenever the CLI's
    // phrasing isn't one we recognize. Only the resumable stops qualify: `failed`
    // and `completed` are not set from a flagged assistant message.
    if (isResumable(state.status)) {
      return cost === state.totalCostUsd ? state : { ...state, totalCostUsd: cost };
    }
    // An expired/invalid login is neither a completion nor a failure of the task:
    // checked first because — unlike a rate limit or a dropped connection — it
    // never clears by itself, so retrying or waiting is the wrong advice. The user
    // logs in again and resumes (see isAuthError / needs_login).
    if (isAuthError(error) || isAuthError(resultText)) {
      return { ...toNeedsLogin(state, at, resultText || error), totalCostUsd: cost };
    }
    // A usage/rate-limit stop is not a real failure — surface it distinctly so
    // the user can wait for the reset and resume rather than treating it as an error.
    if (isRateLimitError(error) || isRateLimitError(resultText)) {
      return { ...toRateLimited(state, at, resultText || error), totalCostUsd: cost };
    }
    // A dropped connection surfaced as an error result — resumable, not a real
    // failure (same treatment as the thrown-error path in Session.consume).
    if (isConnectionError(error) || isConnectionError(resultText)) {
      return { ...toInterrupted(state, at, resultText || error), totalCostUsd: cost };
    }
    // Structured fallback for the same class of stop: the CLI ends an API-error
    // turn with `terminal_reason: 'api_error'` and reports the HTTP status in
    // `api_error_status` — explicitly `null` when there was no HTTP response at all
    // (a dropped connection). A transient status (no response / 5xx) means the turn
    // can simply be resumed, so it lands on `interrupted` even when the wording is
    // one we don't recognize — the CLI has many phrasings for this ("Server error
    // mid-response", "Please wait a moment and try again", …) and they change.
    // (An expired login is reported with `terminal_reason: 'api_error'` too, but it
    // can't reach here: the typed assistant kind already moved the session to
    // needs_login, which the roll-up guard above returns on.)
    if (message.terminal_reason === 'api_error' && isTransientApiStatus(message.api_error_status)) {
      return { ...toInterrupted(state, at, resultText || error), totalCostUsd: cost };
    }
    const withLog = appendLog(state, 'error', error);
    return {
      ...state,
      status: 'failed',
      finishedAt: at,
      totalCostUsd: cost,
      error,
      streamingText: undefined,
      messages: withLog.messages,
      logSeq: withLog.logSeq,
    };
  }

  // thinking_tokens and other unhandled message types — no state change.
  return state;
}

/**
 * Fold one raw SDK message into the session state. The single entry point for SDK
 * output; `Session.consume` calls this for every message on the stream.
 */
export function applySdkMessage(
  state: SessionState,
  message: SDKMessage,
  at: number,
): SessionState {
  return reduceSdk(state, message as unknown as Record<string, unknown>, at);
}
