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

/**
 * どのコーディングエージェントがセッションを駆動しているか。
 *
 * **セッション単位で固定ではない**: worktree（＝実際の成果物）は provider に依存しない
 * ので、Claude で始めた作業を途中から Codex に引き継ぐことができる。モデル側の文脈は
 * provider をまたいで移せない（各 CLI が自分のトランスクリプトを持つ）ため、切替は
 * 「今の provider のターンを終える → 別 provider の新しいセッションを同じ worktree で
 * 開く」という形になる。だから id ごとの resume 用セッション id を
 * {@link SessionState.agentSessions} に控えておき、戻ってきたときは続きから再開する。
 */
export type AgentId = 'claude' | 'codex' | 'grok';

/**
 * ターンが「完了以外」で終わった理由の分類。`failed` だけが終端で、他の 3 つは
 * resumable な idle（`core/status-meta.ts` の `resumable`）へ落ちる。
 *
 * **文言ではなく分類を運ぶ**のが要点。どの文言がどれに当たるかは provider ごとに
 * 違う（Claude CLI の "OAuth session expired" は Codex には存在しない）ので、
 * 判定はアダプタ（`AgentAdapter.classifyError`）に閉じ込め、状態機械はこの 4 値
 * だけを見る。
 */
export type AgentStopCause = 'auth' | 'rate_limit' | 'connection' | 'failed';

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
  /**
   * この行を出したエージェント。セッション途中で切り替えた（Claude → Codex）とき、
   * どこからが別のエージェントの発言かをログに残すためのもの。切替を使っていない
   * セッションでは undefined のまま（既存の行・復元した行も undefined）。
   */
  agent?: AgentId;
}

/**
 * Merge state of a PR, shown as a glyph next to `#<number>`:
 *  - `merged`      — already merged (fork mark)
 *  - `mergeable`   — can be merged cleanly (check)
 *  - `conflicting` — has conflicts, cannot merge (cross)
 *  - `unknown`     — GitHub hasn't computed mergeability yet (no glyph)
 */
export type PrMergeStatus = 'merged' | 'mergeable' | 'conflicting' | 'unknown';

/**
 * *Which* PR a session's branch corresponds to. Stable: a branch keeps the same PR
 * number and URL for the PR's whole life, which is why this half is cached
 * aggressively (persisted across restarts) and shown the moment it's known —
 * independent of whether the volatile {@link PrStatus} could be fetched.
 */
export interface PrRef {
  /** PR number, shown as `#<number>` in the list. */
  number: number;
  /** Web URL, opened in the browser on click / `p`. */
  url: string;
}

/**
 * The *volatile* half of a PR: everything that changes while the PR is open, so it
 * has to be re-polled and can legitimately be unknown (right after a restart, or
 * while `gh` can't answer). Kept separate from {@link PrRef} so a missing status
 * never hides the number.
 */
export interface PrStatus {
  /** Whether the PR is merged / mergeable / conflicting; drives the status glyph. */
  mergeStatus: PrMergeStatus;
  /** True while the PR is still a draft (auto-PR opens drafts, then readies on green checks). */
  isDraft?: boolean;
  /** Aggregate CI state of the PR's checks; drives the checks glyph and auto-ready. */
  checks?: PrChecksState;
  /**
   * The individual checks that are red, when `checks === 'failing'`. Carved out of
   * the *same* `statusCheckRollup` payload the aggregate comes from, so naming them
   * costs no extra API call — and knowing *which* job failed is what turns
   * "CI is red" into an instruction Claude can act on (`core/pr-recovery.ts`).
   * Capped (see `MAX_FAILING_CHECKS`) so a fan-out matrix can't flood the prompt.
   */
  failingChecks?: readonly PrCheckRun[];
}

/** One red check on a PR: what to call it and where its log lives. */
export interface PrCheckRun {
  /** Job/context name as GitHub reports it (`build (20.x)`, `lint`, …). */
  name: string;
  /** Link to the run's details page, when the rollup carried one. */
  url?: string;
}

/**
 * A pull request as `gh` reports it — both halves together, since one `gh pr view`
 * returns them at once. `SessionState` stores them apart (`pr` + `prStatus`).
 */
export interface PrInfo extends PrRef, PrStatus {}

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
  /**
   * 今このセッションを駆動しているエージェント。未設定は `'claude'` 相当
   * （この項目が無かった頃に保存されたセッションの復元経路のため optional）。
   */
  agent?: AgentId;
  /**
   * 現在のエージェントの resume 用セッション id。`agentSessions[agent]` と同じ値で、
   * 「今どれを resume すればよいか」を 1 か所で読めるようにした写し。
   */
  sdkSessionId?: string;
  /**
   * エージェントごとの resume 用セッション id。切り替えて戻ってきたときに、その
   * provider の会話を**続きから**再開するために保持する（新規セッションを開き直すと
   * それまでの文脈が消える）。**永続化される**。
   */
  agentSessions?: Partial<Record<AgentId, string>>;
  /**
   * The model this session is actually running on, as reported by the SDK
   * (`system/init` and each `assistant` message). This is the *resolved* model —
   * present even when config left `model` unset — so it can differ from the
   * globally configured model shown in the banner. Undefined until the first
   * SDK message arrives. Raw id (e.g. `claude-opus-4-8`); format for display
   * with `formatModel`.
   */
  model?: string;
  /**
   * The PR codiva **tracks** for this session, if any (detected asynchronously via
   * `gh`) — normally the one on the session's branch. When the branch has none but
   * the session opened its own PR (`extraPrs` below), the poll adopts that one here,
   * which is what gives it a status glyph; the reducer folds it out of `extraPrs` so
   * the same PR is never counted twice.
   *
   * Only an authoritative "no PR for this session" clears it, so a failed lookup never
   * hides the number. **Persisted** — a PR's number doesn't change, so the list can
   * show `#<n>` immediately after a restart while the status below is still being
   * fetched.
   */
  pr?: PrRef;
  /**
   * PRs the session opened *itself* (`gh pr create` from another branch), on top of
   * the branch PR above. A session is not limited to one PR: it can split its work,
   * or land a prerequisite first. codiva can't find these by branch name — they're
   * read out of the `gh pr create` tool result (`core/pr-detect.ts`).
   *
   * Identity only (number + URL), like `pr`: codiva neither readies nor merges these,
   * and only the one it adopts as `pr` (when the branch has no PR of its own) gets a
   * status glyph — showing the rest is what keeps a second PR from silently
   * disappearing from the list.
   * **Persisted** (see `pr`); capped by `MAX_SESSION_PRS`.
   */
  extraPrs?: readonly PrRef[];
  /**
   * tool_use ids of `gh pr create` calls whose result hasn't come back yet. The URL
   * of a newly created PR only exists in the *result*, so the id has to be carried
   * from the assistant message to the matching tool_result — pairing them is what
   * keeps `gh pr list` / `gh pr view` output (other people's PRs) out of `extraPrs`.
   * Transient — never persisted.
   */
  prCreateToolIds?: readonly string[];
  /**
   * The volatile half of `pr` (merge state / checks / draft), refreshed on a
   * staleness schedule (see `core/pr-refresh.ts`) and cached in between. Undefined
   * means "not known yet" — the number renders without a status glyph rather than
   * the row waiting for both. Transient — never persisted (a stale glyph from the
   * previous run would be worse than briefly showing none).
   */
  prStatus?: PrStatus;
  /**
   * Progress/health of the background `gh` lookup that fills the two above.
   * Undefined once a lookup has answered (whether it found a PR or not).
   * Transient — never persisted.
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
 * abort, …).
 *
 * エージェントの出力はここには来ない: provider のストリームはアダプタが
 * `AgentEvent`（`core/agent-events.ts`）へ正規化し、`applyAgentEvent` が畳み込む。
 * 2 本に分けているのは役割が違うため — `CodivaEvent` は「codiva（UI/manager）が
 * 起こしたこと」、`AgentEvent` は「エージェントに起きたこと」。
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
  // `gh` was asked about this exact PR (by URL) and answered that it does not
  // exist. Drops the reference so a phantom — a `gh pr create` URL we misread, or
  // a PR in a repo that has since gone away — stops being displayed as this
  // session's PR. Only for an *authoritative* answer: a lookup that couldn't tell
  // us (rate limit / offline) must keep the reference (`pr_lookup: 'error'`).
  | { kind: 'pr_gone'; pr: PrRef; at: number }
  // The PR lookup started / failed, without an authoritative answer about the PR
  // itself. Drives the list's "looking…" / "couldn't check" cell.
  | { kind: 'pr_lookup'; lookup: PrLookupState | undefined; at: number }
  // A merge of this session's branch into base hit conflicts (detected out of
  // band during the merge action). Carries the conflicted file paths.
  | { kind: 'conflict'; files: string[]; at: number }
  // ストリームが例外で終わった。`cause` は**アダプタが分類した**停止理由
  // （`AgentAdapter.classifyError`）。reducer が文言を見て分類し直さないのは、
  // 「認証切れ」「レート制限」「通信断」の見分け方が provider ごとに違うため。
  // 省略時は `failed`（UI 起点の abort など、分類する材料が無いケース）。
  | { kind: 'aborted'; error?: string; cause?: AgentStopCause; at: number }
  // 駆動するエージェントを切り替えた（Claude → Codex）。worktree はそのままで、
  // 直前の provider の resume id を退避し、切替先の id（あれば）を現在値にする。
  | { kind: 'agent_switched'; agent: AgentId; at: number }
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
