import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { appendLog, isRateLimitError, progressOf, toRateLimited } from './status-reducer';
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

/** One-line log summary for a tool_use block. Shared with `transcript.ts` (history restore). */
export function summarizeToolUse(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case 'Write':
    case 'Edit':
      return `${name} ${String(input.file_path ?? input.path ?? '')}`.trim();
    case 'Bash':
      return `Bash ${String(input.command ?? '')}`.trim();
    case 'TaskCreate':
      return `TaskCreate "${String(input.subject ?? '')}"`;
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

/**
 * One-line log summary for a tool_result block's content (first line, capped).
 * Shared with `transcript.ts` so restored history matches the live log format.
 */
export function toolResultSummary(content: unknown): string {
  return asString(content).split('\n')[0]?.slice(0, 200) ?? '';
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
  // stored trimmed, so trim the result before comparing.
  const resultText = result.resultText.trim();
  const lastAssistantText = state.messages.findLast((m) => m.kind === 'assistant_text')?.text;
  const isEcho = resultText.length > 0 && resultText === lastAssistantText;
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
        messages = [...messages, { seq, kind: 'assistant_text', text, timestamp }];
        logSeq = seq;
      }
    } else if (block.type === 'tool_use') {
      const tu = raw as ToolUseBlock;
      todos = applyTaskTool(todos, tu);
      const seq = logSeq + 1;
      messages = [
        ...messages,
        { seq, kind: 'tool_use', text: summarizeToolUse(tu.name, tu.input ?? {}), timestamp },
      ];
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
        streamingText: (state.streamingText ?? '') + delta.text,
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
        messages = [...messages, { seq, kind: 'tool_result', text }];
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
    if (message.subtype === 'success') {
      const resultText = asString(message.result);
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
    const error = String(message.subtype ?? 'error');
    const resultText = asString(message.result);
    // A usage/rate-limit stop is not a real failure — surface it distinctly so
    // the user can wait for the reset and resume rather than treating it as an error.
    if (isRateLimitError(error) || isRateLimitError(resultText)) {
      return { ...toRateLimited(state, at, resultText || error), totalCostUsd: cost };
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
