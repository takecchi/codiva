import type { PrChecksState, PrInfo, SessionState } from './types';
import type { DiffStat, Worktree } from './worktree';

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
  remove(wt: Worktree, opts?: { force?: boolean }): Promise<void>;
}

/** The subset of Session the manager drives (for DI in tests). */
export interface SessionHandle {
  getState(): SessionState;
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
  markConflict(files: string[]): void;
}

/**
 * GitHub PR automation seam (via `gh`), injected so the manager stays testable.
 * All calls are best-effort at the call site; failures never break a session.
 */
export interface PrAutomation {
  /** Open a draft PR for a pushed branch (or return the existing one). */
  createPr(cwd: string, branch: string): Promise<PrInfo | undefined>;
  /** Aggregate CI state of the PR's checks. */
  checks(cwd: string, branch: string): Promise<PrChecksState>;
  /** Flip a draft PR to ready-for-review. */
  markReady(cwd: string, branch: string): Promise<void>;
}

/** Look up the open PR for a branch (via `gh`), or undefined if there is none. */
export type PrLookup = (cwd: string, branch: string) => Promise<PrInfo | undefined>;

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
