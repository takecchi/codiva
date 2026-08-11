import type { AgentAdapter } from './agent-ports';
import type { PrInfo, PrLookupResult, PrLookupState, SessionState } from './types';
import type { DiffStat, SyncBaseResult, Worktree } from './worktree';

/**
 * The dependency-injection seams the session layer drives. Kept in one leaf
 * module (depends only on `types`/`worktree`) so `session-manager`,
 * `session-actions`, and `pr-coordinator` can share them without importing each
 * other — which would form a cycle.
 */

/** The subset of WorktreeManager the session layer needs (for DI in tests). */
export interface WorktreeService {
  baseBranch(): Promise<string>;
  takenSlugs(): Promise<Set<string>>;
  add(slug: string, startPoint?: string): Promise<Worktree>;
  syncedStartPoint(base: string): Promise<string | undefined>;
  pushBranch(wt: Worktree): Promise<void>;
  diffStat(wt: Worktree, base: string): Promise<DiffStat>;
  merge(wt: Worktree, base: string): Promise<void>;
  /** Take `base` into the session's branch (the other direction from `merge`). */
  syncBase(wt: Worktree, base: string): Promise<SyncBaseResult>;
  remove(wt: Worktree, opts?: { force?: boolean }): Promise<void>;
}

/** The subset of Session the manager drives (for DI in tests). */
export interface SessionHandle {
  getState(): SessionState;
  /**
   * 現在のエージェントと、その差し替え（Claude → Codex）。UI は `getAgent()` から
   * capability を引いて、持たない機能のキー操作を隠す。
   *
   * optional なのは、状態だけを動かすテスト用フェイクにエージェントの概念が
   * 要らないため（`tests/helpers.ts` の `noopSession`）。
   */
  getAgent?(): AgentAdapter;
  setAgent?(adapter: AgentAdapter): void;
  start(): void;
  send(text: string): void;
  answerPending(answers: Record<string, string>): void;
  allowPending(): void;
  denyPending(message: string): void;
  interrupt(): Promise<void>;
  setModel(model: string | undefined): void;
  abort(): void;
  stop(): void;
  archive(): void;
  setPr(pr: PrInfo | undefined): void;
  setPrLookup(lookup: PrLookupState | undefined): void;
  markConflict(files: string[]): void;
}

/**
 * GitHub PR automation seam (via `gh`), injected so the manager stays testable.
 * All calls are best-effort at the call site; failures never break a session.
 */
export interface PrAutomation {
  /** Open a draft PR for a pushed branch (or return the existing one). */
  createPr(cwd: string, branch: string): Promise<PrInfo | undefined>;
  /** Flip a draft PR to ready-for-review. `ref` is a branch name or a PR number. */
  markReady(cwd: string, ref: string): Promise<void>;
}

/** Extra hints for a PR lookup beyond the session's branch. */
export interface PrLookupOptions {
  /**
   * Number of a PR already associated with this session. Tried after the branches,
   * and it is the *only* way to reach a PR the session opened itself on a branch that
   * isn't checked out in the worktree (see {@link PrLookupTarget.knownPr}).
   */
  knownPr?: number;
}

/**
 * Look up the PR to track for a session (via `gh`). Returns a three-way result —
 * found / absent / unavailable — never a bare undefined, so a failed lookup can't be
 * mistaken for "this session has no PR" (which would clear the badge).
 */
export type PrLookup = (
  cwd: string,
  branch: string,
  opts?: PrLookupOptions,
) => Promise<PrLookupResult>;

/** One session to resolve a PR for in a batched lookup. */
export interface PrLookupTarget {
  /** Session id — the key of the returned map. */
  id: string;
  /** The session's worktree path (`gh` / `git` cwd). */
  cwd: string;
  /** The recorded `codiva/<slug>` branch (HEAD is preferred when it differs). */
  branch: string;
  /**
   * PR number already known for this session, if any — including one the session
   * opened itself (`extraPrs`). Lets the implementation tell "this PR is gone" from
   * "the listing didn't reach it" (truncated, or its head branch isn't checked out
   * here), and is what makes a session-opened PR's state trackable at all.
   */
  knownPr?: number;
}

/**
 * Resolve many sessions' PRs in one go (one `gh pr list` instead of one
 * `gh pr view` each), keyed by session id. Every target must get an entry.
 * Optional: without it the coordinator falls back to per-session lookups.
 */
export type PrBatchLookup = (
  targets: readonly PrLookupTarget[],
) => Promise<ReadonlyMap<string, PrLookupResult>>;

/** Result of a lifecycle action (merge/discard) surfaced to the UI. */
export interface ActionResult {
  ok: boolean;
  error?: string;
}

/** A session's worktree and the base branch it was cut from. */
export interface WorktreeMeta {
  worktree: Worktree;
  base: string;
}
