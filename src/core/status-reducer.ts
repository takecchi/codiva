import { makeTitle } from './slug';
import type {
  CodivaEvent,
  CreateSessionInput,
  LogEntry,
  LogKind,
  SessionState,
  TaskStatus,
  TodoItem,
} from './types';

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

export function initialState(input: CreateSessionInput): SessionState {
  return {
    id: input.id,
    title: input.title,
    status: 'creating',
    prompt: input.prompt,
    branch: input.branch,
    worktreePath: input.worktreePath,
    todos: [],
    messages: [],
    startedAt: input.startedAt,
    logSeq: 0,
  };
}

/** Derive Step n/m progress from a todo list. Exported for session restoration. */
export function progressOf(todos: TodoItem[]): { done: number; total: number } | undefined {
  const active = todos.filter((t) => t.status !== 'deleted');
  if (active.length === 0) {
    return undefined;
  }
  return { done: active.filter((t) => t.status === 'completed').length, total: active.length };
}

function appendLog(
  state: SessionState,
  kind: LogKind,
  text: string,
  timestamp?: number,
): { messages: LogEntry[]; logSeq: number } {
  const seq = state.logSeq + 1;
  const entry: LogEntry = { seq, kind, text, timestamp };
  return { messages: [...state.messages, entry], logSeq: seq };
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

function summarizeToolUse(name: string, input: Record<string, unknown>): string {
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

  // The full assistant message is authoritative — drop the streamed preview.
  if (messages === state.messages && todos === state.todos) {
    if (state.status === 'running' && state.streamingText === undefined && model === state.model) {
      return state;
    }
    return { ...state, status: 'running', streamingText: undefined, model };
  }
  return {
    ...state,
    status: 'running',
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
        status: state.status === 'running' ? state.status : 'running',
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
      const text = asString(tr.content).split('\n')[0]?.slice(0, 200) ?? '';
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
      return { ...state, status: 'running', sdkSessionId: sid ?? state.sdkSessionId, model };
    }
    return state;
  }

  if (type === 'assistant') {
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
      const withLog =
        resultText.length > 0
          ? appendLog(state, 'result', resultText)
          : { messages: state.messages, logSeq: state.logSeq };
      return {
        ...state,
        status: 'completed',
        finishedAt: at,
        totalCostUsd: cost,
        streamingText: undefined,
        messages: withLog.messages,
        logSeq: withLog.logSeq,
      };
    }
    const error = String(message.subtype ?? 'error');
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

  // thinking_tokens, rate_limit_event, stream_event, etc. — no state change.
  return state;
}

/** Pure reducer: the single source of truth for session state transitions. */
export function reduce(state: SessionState, event: CodivaEvent): SessionState {
  switch (event.kind) {
    case 'sdk':
      return reduceSdk(state, event.message as unknown as Record<string, unknown>, event.at);

    case 'permission_request': {
      const status = event.request.kind === 'question' ? 'awaiting_input' : 'awaiting_permission';
      const summary =
        event.request.kind === 'question'
          ? summarizeToolUse('AskUserQuestion', event.request.input)
          : `permission: ${event.request.toolName}`;
      const withLog = appendLog(state, 'system', summary);
      return {
        ...state,
        status,
        pendingPermission: event.request,
        messages: withLog.messages,
        logSeq: withLog.logSeq,
      };
    }

    case 'permission_resolved': {
      if (state.pendingPermission === undefined) {
        return state;
      }
      const { pendingPermission, ...rest } = state;
      void pendingPermission;
      return { ...rest, status: 'running' };
    }

    case 'user_input': {
      const withLog = appendLog(state, 'user', event.text, event.at);
      return {
        ...state,
        status: 'running',
        finishedAt: undefined,
        streamingText: undefined,
        messages: withLog.messages,
        logSeq: withLog.logSeq,
      };
    }

    case 'title': {
      const title = makeTitle(event.title);
      // Ignore empty generations; keep the placeholder rather than blank it.
      return title.length === 0 || title === state.title ? state : { ...state, title };
    }

    case 'pr': {
      // No-op when unchanged so subscribers don't re-render on every poll.
      if (state.pr?.number === event.pr?.number && state.pr?.url === event.pr?.url) {
        return state;
      }
      return { ...state, pr: event.pr };
    }

    case 'aborted': {
      const error = event.error ?? 'aborted';
      const withLog = appendLog(state, 'error', error);
      return {
        ...state,
        status: 'failed',
        finishedAt: event.at,
        error,
        streamingText: undefined,
        messages: withLog.messages,
        logSeq: withLog.logSeq,
      };
    }

    case 'detached':
      return state.status === 'external'
        ? state
        : {
            ...state,
            status: 'external',
            // claude CLI 側で続きが進むため、codiva 側の保留・経過時間はここで閉じる。
            pendingPermission: undefined,
            streamingText: undefined,
            finishedAt: event.at,
          };

    case 'archived':
      return state.status === 'archived'
        ? state
        : { ...state, status: 'archived', streamingText: undefined };

    default:
      return state;
  }
}
