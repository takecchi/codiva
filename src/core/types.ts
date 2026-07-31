/** Lifecycle state of a single session. See docs/ARCHITECTURE.md state machine. */
export type SessionStatus =
  | 'creating' // worktree being created / query not yet started
  | 'running' // Claude is working
  | 'awaiting_permission' // a tool needs user allow/deny
  | 'awaiting_input' // Claude asked the user a question (AskUserQuestion)
  | 'completed' // a turn finished successfully (idle, can receive more input)
  | 'interrupted' // app was closed mid-flight (running/awaiting_*); idle & resumable, not a real completion
  | 'rate_limited' // stopped because a usage/rate limit was hit; idle & resumable once the limit resets
  | 'needs_login' // stopped because Claude could not authenticate; needs `claude` /login, then resumable
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

/**
 * Merge state of a PR, shown as a glyph next to `#<number>`:
 *  - `merged`      — already merged (fork mark)
 *  - `mergeable`   — can be merged cleanly (check)
 *  - `conflicting` — has conflicts, cannot merge (cross)
 *  - `unknown`     — GitHub hasn't computed mergeability yet (no glyph)
 */
export type PrMergeStatus = 'merged' | 'mergeable' | 'conflicting' | 'unknown';

/** A pull request opened for a session's branch (detected via `gh`). */
export interface PrInfo {
  /** PR number, shown as `#<number>` in the list. */
  number: number;
  /** Web URL, opened in the browser on click / `p`. */
  url: string;
  /** Whether the PR is merged / mergeable / conflicting; drives the status glyph. */
  mergeStatus: PrMergeStatus;
  /** True while the PR is still a draft (auto-PR opens drafts, then readies on green checks). */
  isDraft?: boolean;
  /** Aggregate CI state of the PR's checks; drives the checks glyph and auto-ready. */
  checks?: PrChecksState;
}

/**
 * Aggregate CI state of a PR's checks (from `gh pr view --json statusCheckRollup`).
 * `none` = the PR has no checks configured. Drives auto-ready (only `passing` readies).
 */
export type PrChecksState = 'passing' | 'pending' | 'failing' | 'none';

/**
 * Why a `gh` PR lookup couldn't answer the question:
 *  - `cli`        — `gh` isn't installed (ENOENT)
 *  - `auth`       — `gh` isn't authenticated / token rejected
 *  - `rate_limit` — GitHub API quota exhausted (`gh pr view --json mergeable` spends
 *                   the *GraphQL* budget, which the user's other tools share)
 *  - `network`    — offline / DNS / timeout
 *  - `unknown`    — anything else, including unparsable output
 *
 * Split out because the fix for each differs — and because `cli`/`auth`/`rate_limit`
 * are worth backing off from (they can't succeed on the next 20s tick).
 */
export type PrUnavailableReason = 'cli' | 'auth' | 'rate_limit' | 'network' | 'unknown';

/**
 * Outcome of looking up the PR for a branch. The three cases must stay distinct:
 * folding `unavailable` into "no PR" is what used to make a `#<n>` badge blink out
 * of the list whenever `gh` hit a rate limit or a network hiccup, since the poll
 * then reported "this branch has no PR" and the reducer dutifully cleared it.
 */
export type PrLookupResult =
  | { kind: 'found'; pr: PrInfo }
  /** `gh` answered: this branch has no PR. */
  | { kind: 'absent' }
  /** `gh` couldn't answer — the previous value (if any) must be kept. */
  | { kind: 'unavailable'; reason: PrUnavailableReason };

/**
 * What the background PR poll is currently doing for a session, so the list can
 * say "still looking" / "couldn't check" instead of rendering an empty cell that
 * is indistinguishable from "this branch has no PR".
 *  - `loading` — the first lookup is in flight and there's nothing to show yet
 *  - `error`   — the last lookup failed; sticky until one succeeds (re-marking
 *                `loading` on every retry would just flicker the cell)
 * Transient — never persisted.
 */
export type PrLookupState = 'loading' | 'error';

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
  /**
   * Progress/health of the background `gh` lookup that fills `pr`. Undefined once a
   * lookup has answered (whether it found a PR or not). Transient — never persisted.
   */
  prLookup?: PrLookupState;
  /** Files left conflicted by a failed merge into base (set with `status: 'conflict'`). */
  conflictFiles?: string[];
  startedAt: number;
  finishedAt?: number;
  /**
   * Accumulated *active* (working) time in ms — the sum of every completed
   * running/creating segment. Idle time (awaiting the user, completed, terminal)
   * is excluded, so this is the "session actually ran" duration rather than
   * wall-clock since `startedAt`. In-flight time isn't folded in here; add the
   * current open segment at display time via `activeElapsedMs`.
   */
  activeMs: number;
  /**
   * Epoch ms at which the current active segment began, present iff the session
   * is currently in an active status (see `isActiveStatus`). Undefined while idle
   * or terminal. On a status boundary the reducer accrues `now - activeSince`
   * into `activeMs` and clears/sets this (see `accrueActive`). Transient — never
   * persisted (a restored session resumes idle, so it starts undefined).
   */
  activeSince?: number;
  totalCostUsd?: number;
  error?: string;
  /**
   * When `status: 'rate_limited'`, the epoch ms at which the hit limit resets
   * (from the SDK's `rate_limit_event.rate_limit_info.resetsAt`), if the SDK
   * reported it. Transient — used only for display; never persisted.
   */
  rateLimitResetsAt?: number;
  /**
   * The assistant text streamed so far for the in-flight message (from
   * `includePartialMessages` stream events). Transient live-typing preview —
   * cleared when the full message/result arrives; never persisted.
   */
  streamingText?: string;
  /**
   * Task ids of sub-agent / Task-tool runs that have started (`system/task_started`)
   * but not yet settled (`system/task_notification`). A backgrounded Task lets the
   * top-level turn's `result` arrive while the sub-agent is still working; while this
   * set is non-empty we must NOT treat that `result` as a real completion (the badge
   * would flip to "Completed" mid-work). Transient runtime state; never persisted.
   */
  activeTaskIds?: string[];
  /**
   * A `result/success` that arrived while `activeTaskIds` was non-empty. We hold its
   * payload here and stay `running`; completion is finalized once the last sub-agent
   * task settles. Transient; never persisted.
   */
  deferredResult?: { at: number; totalCostUsd?: number; resultText: string };
  /** Internal monotonic counter for LogEntry.seq; keeps the reducer pure. */
  logSeq: number;
}

/**
 * Everything that can change a session's state via the pure reducer. `Session`
 * dispatches these for its own lifecycle actions (user input, permissions, model,
 * abort, …). Raw SDK output is NOT an event: `Session.consume` folds each SDK
 * message straight into state via `applySdkMessage` (see core/sdk-parse.ts), which
 * keeps all SDK message-shape parsing out of the reducer.
 */
export type CodivaEvent =
  | { kind: 'permission_request'; request: PermissionRequest; at: number }
  | { kind: 'permission_resolved'; at: number }
  | { kind: 'user_input'; text: string; at: number }
  // The model for this session was switched (per-session /model from the detail
  // view). Reflects the chosen model in state.model optimistically; the SDK's
  // resolved model on the next assistant turn confirms/overwrites it.
  | { kind: 'model'; model: string | undefined; at: number }
  // A Claude-generated title (from the content of the task), replacing the
  // input-derived placeholder. Fired once, asynchronously, after a fresh start.
  | { kind: 'title'; title: string; at: number }
  // A pull request was detected (or cleared) for this session's branch, out of
  // band via `gh`. Carries the info; the reducer only swaps it into state. Only
  // dispatched when `gh` actually answered, so it also clears `prLookup`.
  | { kind: 'pr'; pr: PrInfo | undefined; at: number }
  // The PR lookup started / failed, without an authoritative answer about the PR
  // itself. Drives the list's "looking…" / "couldn't check" cell.
  | { kind: 'pr_lookup'; lookup: PrLookupState | undefined; at: number }
  // A merge of this session's branch into base hit conflicts (detected out of
  // band during the merge action). Carries the conflicted file paths.
  | { kind: 'conflict'; files: string[]; at: number }
  | { kind: 'aborted'; error?: string; at: number }
  // The live query dropped mid-flight because the connection was interrupted
  // (see isConnectionError). Unlike `aborted` this is not a failure: the session
  // becomes `interrupted` (idle & resumable) so the user can continue it.
  | { kind: 'interrupted'; error?: string; at: number }
  | { kind: 'archived'; at: number };

export interface CreateSessionInput {
  id: string;
  title: string;
  prompt: string;
  branch: string;
  worktreePath: string;
  startedAt: number;
}
