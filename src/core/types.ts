import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

/** Lifecycle state of a single session. See docs/ARCHITECTURE.md state machine. */
export type SessionStatus =
  | 'creating' // worktree being created / query not yet started
  | 'running' // Claude is working
  | 'awaiting_permission' // a tool needs user allow/deny
  | 'awaiting_input' // Claude asked the user a question (AskUserQuestion)
  | 'completed' // a turn finished successfully (idle, can receive more input)
  | 'failed' // query errored or was aborted
  | 'archived'; // merged or discarded; kept for reference

export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'deleted';

/** One item of Claude's own task list (from TaskCreate/TaskUpdate, or legacy TodoWrite). */
export interface TodoItem {
  id: string;
  subject: string;
  status: TaskStatus;
  activeForm?: string;
}

export type LogKind =
  | 'assistant_text'
  | 'tool_use'
  | 'tool_result'
  | 'result'
  | 'user'
  | 'system'
  | 'error';

/** A rendered line for the session detail log. */
export interface LogEntry {
  seq: number;
  kind: LogKind;
  text: string;
  timestamp?: number;
}

/** One question surfaced by the AskUserQuestion tool. */
export interface QuestionSpec {
  question: string;
  header: string;
  multiSelect: boolean;
  options: { label: string; description: string }[];
}

/**
 * A pending decision the session is blocked on. `kind: 'question'` is an
 * AskUserQuestion (answered via `answers`); `kind: 'tool'` is a plain
 * permission prompt (allow/deny).
 */
export interface PermissionRequest {
  id: string;
  toolName: string;
  input: Record<string, unknown>;
  kind: 'question' | 'tool';
  questions?: QuestionSpec[];
}

/** Immutable snapshot the UI renders. Produced only by the reducer. */
export interface SessionState {
  id: string;
  title: string;
  status: SessionStatus;
  prompt: string;
  branch: string;
  worktreePath: string;
  todos: TodoItem[];
  progress?: { done: number; total: number };
  messages: LogEntry[];
  pendingPermission?: PermissionRequest;
  sdkSessionId?: string;
  startedAt: number;
  finishedAt?: number;
  totalCostUsd?: number;
  error?: string;
  /** Internal monotonic counter for LogEntry.seq; keeps the reducer pure. */
  logSeq: number;
}

/**
 * Everything that can change a session's state. The reducer is a pure function
 * of (state, event); Session translates SDK output and UI actions into events.
 */
export type CodivaEvent =
  | { kind: 'sdk'; message: SDKMessage; at: number }
  | { kind: 'permission_request'; request: PermissionRequest; at: number }
  | { kind: 'permission_resolved'; at: number }
  | { kind: 'user_input'; text: string; at: number }
  // A Claude-generated title (from the content of the task), replacing the
  // input-derived placeholder. Fired once, asynchronously, after a fresh start.
  | { kind: 'title'; title: string; at: number }
  | { kind: 'aborted'; error?: string; at: number }
  | { kind: 'archived'; at: number };

export interface CreateSessionInput {
  id: string;
  title: string;
  prompt: string;
  branch: string;
  worktreePath: string;
  startedAt: number;
}
