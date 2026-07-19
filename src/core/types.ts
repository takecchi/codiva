import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

/** Lifecycle state of a single session. See docs/ARCHITECTURE.md state machine. */
export type SessionStatus =
  | 'creating' // worktree being created / query not yet started
  | 'running' // Claude is working
  | 'awaiting_permission' // a tool needs user allow/deny
  | 'awaiting_input' // Claude asked the user a question (AskUserQuestion)
  | 'completed' // a turn finished successfully (idle, can receive more input)
  | 'failed' // query errored or was aborted
  | 'conflict' // a merge into base hit conflicts; needs manual resolution
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

/** A pull request opened for a session's branch (detected via `gh`). */
export interface PrInfo {
  /** PR number, shown as `#<number>` in the list. */
  number: number;
  /** Web URL, opened in the browser on click / `p`. */
  url: string;
  /** True while the PR is still a draft (auto-PR opens drafts, then readies on green checks). */
  isDraft?: boolean;
}

/**
 * Aggregate CI state of a PR's checks (from `gh pr view --json statusCheckRollup`).
 * `none` = no checks or the query failed. Drives auto-ready (only `passing` readies).
 */
export type PrChecksState = 'passing' | 'pending' | 'failing' | 'none';

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
  /**
   * The model this session is actually running on, as reported by the SDK
   * (`system/init` and each `assistant` message). This is the *resolved* model —
   * present even when config left `model` unset — so it can differ from the
   * globally configured model shown in the banner. Undefined until the first
   * SDK message arrives. Raw id (e.g. `claude-opus-4-8`); format for display
   * with `formatModel`.
   */
  model?: string;
  /** Pull request opened for `branch`, if any (detected asynchronously via `gh`). */
  pr?: PrInfo;
  /** Files left conflicted by a failed merge into base (set with `status: 'conflict'`). */
  conflictFiles?: string[];
  startedAt: number;
  finishedAt?: number;
  totalCostUsd?: number;
  error?: string;
  /**
   * The assistant text streamed so far for the in-flight message (from
   * `includePartialMessages` stream events). Transient live-typing preview —
   * cleared when the full message/result arrives; never persisted.
   */
  streamingText?: string;
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
  // A pull request was detected (or cleared) for this session's branch, out of
  // band via `gh`. Carries the info; the reducer only swaps it into state.
  | { kind: 'pr'; pr: PrInfo | undefined; at: number }
  // A merge of this session's branch into base hit conflicts (detected out of
  // band during the merge action). Carries the conflicted file paths.
  | { kind: 'conflict'; files: string[]; at: number }
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
