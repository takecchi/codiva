import { USAGE_LIMIT_ERROR_PREFIXES } from '@anthropic-ai/claude-agent-sdk';
import { makeTitle } from './slug';
import type {
  CodivaEvent,
  CreateSessionInput,
  LogEntry,
  LogKind,
  SessionState,
  TodoItem,
} from './types';

/**
 * True when an error/result string signals a genuine usage- or rate-limit stop
 * (rather than an ordinary failure). We match the SDK's own `getLimitReachedText`
 * prefixes so we stay in sync with the CLI wording, plus a loose "rate limit" /
 * "usage limit" fallback for messages that arrive wrapped (e.g. `Error: …`).
 */
export function isRateLimitError(text: string): boolean {
  return (
    USAGE_LIMIT_ERROR_PREFIXES.some((p) => text.includes(p)) ||
    /rate.?limit|usage limit/i.test(text)
  );
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

/**
 * Append a log entry and bump the monotonic seq. Shared with `sdk-parse.ts` so the
 * live SDK stream and the reducer's own events produce identically-sequenced logs.
 */
export function appendLog(
  state: SessionState,
  kind: LogKind,
  text: string,
  timestamp?: number,
): { messages: LogEntry[]; logSeq: number } {
  const seq = state.logSeq + 1;
  const entry: LogEntry = { seq, kind, text, timestamp };
  return { messages: [...state.messages, entry], logSeq: seq };
}

/**
 * Transition into the `rate_limited` state: the session stopped because a usage/
 * rate limit was hit. Idle & resumable once the limit resets (like a completed
 * turn, it can receive more input) — but flagged distinctly so the user sees it
 * wasn't a clean finish and can wait for the reset. Records the reason in the log.
 * Shared with `sdk-parse.ts` (a limit can surface both as an SDK message and as a
 * thrown error caught by the reducer's `aborted` event).
 */
export function toRateLimited(
  state: SessionState,
  at: number,
  detail: string,
  resetsAt?: number,
): SessionState {
  const withLog = appendLog(state, 'system', detail);
  return {
    ...state,
    status: 'rate_limited',
    finishedAt: at,
    rateLimitResetsAt: resetsAt,
    streamingText: undefined,
    messages: withLog.messages,
    logSeq: withLog.logSeq,
  };
}

/** Pure reducer: the single source of truth for session state transitions. */
export function reduce(state: SessionState, event: CodivaEvent): SessionState {
  switch (event.kind) {
    case 'permission_request': {
      const status = event.request.kind === 'question' ? 'awaiting_input' : 'awaiting_permission';
      // The question text is already parsed onto the request (QuestionSpec[]),
      // so we read it directly rather than re-parsing the raw tool input here —
      // that keeps SDK-shape parsing out of the reducer (see sdk-parse.ts).
      const summary =
        event.request.kind === 'question'
          ? `AskUserQuestion: ${event.request.questions?.[0]?.question ?? ''}`
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

    case 'model':
      // No-op when unchanged so subscribers don't re-render needlessly.
      return state.model === event.model ? state : { ...state, model: event.model };

    case 'title': {
      const title = makeTitle(event.title);
      // Ignore empty generations; keep the placeholder rather than blank it.
      return title.length === 0 || title === state.title ? state : { ...state, title };
    }

    case 'pr': {
      // No-op when unchanged so subscribers don't re-render on every poll.
      // mergeStatus is part of the identity: it flips (unknown → mergeable →
      // merged, or → conflicting) on the same PR and must repaint the glyph.
      // isDraft likewise flips (draft → ready) and must repaint.
      if (
        state.pr?.number === event.pr?.number &&
        state.pr?.url === event.pr?.url &&
        state.pr?.mergeStatus === event.pr?.mergeStatus &&
        state.pr?.isDraft === event.pr?.isDraft
      ) {
        return state;
      }
      return { ...state, pr: event.pr };
    }

    case 'conflict': {
      const summary =
        event.files.length > 0 ? `merge conflict in ${event.files.join(', ')}` : 'merge conflict';
      const withLog = appendLog(state, 'error', summary);
      return {
        ...state,
        status: 'conflict',
        conflictFiles: event.files,
        streamingText: undefined,
        messages: withLog.messages,
        logSeq: withLog.logSeq,
      };
    }

    case 'aborted': {
      const error = event.error ?? 'aborted';
      // A rate/usage limit can surface as a thrown error (caught in consume) —
      // classify it as rate_limited rather than a generic failure.
      if (isRateLimitError(error)) {
        return toRateLimited(state, event.at, error);
      }
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

    case 'archived':
      return state.status === 'archived'
        ? state
        : { ...state, status: 'archived', streamingText: undefined };

    default:
      return state;
  }
}
