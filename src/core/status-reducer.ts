import { USAGE_LIMIT_ERROR_PREFIXES } from '@anthropic-ai/claude-agent-sdk';
import { makeTitle } from './slug';
import { isActiveStatus } from './status-meta';
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
    // `creating` is an active status, so the clock starts running immediately.
    activeMs: 0,
    activeSince: input.startedAt,
    logSeq: 0,
  };
}

/**
 * Fold a status transition into the active-time accumulator. Called centrally
 * for every adopted state (see `Session.commit`) so we don't have to touch each
 * individual transition: whenever the session crosses the active/idle boundary
 * we either open a new segment (`activeSince = at`) or close the current one
 * (`activeMs += at - activeSince`). Staying on the same side is a no-op — the
 * spread in the reducers already carried `activeMs`/`activeSince` forward, so we
 * return `next` unchanged to preserve the caller's no-op/ref-equality checks.
 */
export function accrueActive(prev: SessionState, next: SessionState, at: number): SessionState {
  const wasActive = isActiveStatus(prev.status);
  const nowActive = isActiveStatus(next.status);
  if (wasActive === nowActive) {
    return next;
  }
  if (nowActive) {
    return { ...next, activeSince: at };
  }
  const segment = prev.activeSince !== undefined ? Math.max(0, at - prev.activeSince) : 0;
  return { ...next, activeMs: next.activeMs + segment, activeSince: undefined };
}

/**
 * Total active (working) time in ms as of `now`: the accumulated completed
 * segments plus the currently-open segment if the session is still active. This
 * is what the UI shows for "session running time" — idle waiting never counts.
 */
export function activeElapsedMs(state: SessionState, now: number): number {
  const open = state.activeSince !== undefined ? Math.max(0, now - state.activeSince) : 0;
  return state.activeMs + open;
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

/**
 * Transition into the `interrupted` state: the live query dropped mid-flight
 * because the connection was interrupted (not a clean finish, not a real
 * failure). Idle & resumable — sending a follow-up (or the explicit "resume"
 * action) restarts the query with `resume` so Claude continues where it left
 * off. Records the reason in the log. Shared with `sdk-parse.ts` (a connection
 * drop can surface both as a thrown error caught by `Session.consume` and as an
 * error `result` on the stream). Transient bookkeeping (`pendingPermission` from
 * a turn that can never resolve now, deferred sub-agent results) is dropped so a
 * resumed turn starts clean.
 */
export function toInterrupted(state: SessionState, at: number, detail: string): SessionState {
  const withLog = appendLog(state, 'system', detail);
  const { pendingPermission, deferredResult, activeTaskIds, ...rest } = state;
  void pendingPermission;
  void deferredResult;
  void activeTaskIds;
  return {
    ...rest,
    status: 'interrupted',
    finishedAt: at,
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
        // 保留中の決定（質問/許可待ち）があるセッションを running へ降格させない。
        // 追加指示を送っても pendingPermission は解決されないため、ダイアログは
        // 出たまま awaiting_* を維持する（#37 と同じ不変条件: pending がある間は
        // 決して "Running" に戻さない）。解決は permission_resolved のみが行う。
        status: state.pendingPermission ? state.status : 'running',
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

    case 'interrupted':
      return toInterrupted(state, event.at, event.error ?? 'connection interrupted');

    case 'archived':
      return state.status === 'archived'
        ? state
        : { ...state, status: 'archived', streamingText: undefined };

    default:
      return state;
  }
}
