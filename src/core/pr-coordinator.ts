import type {
  PrAutomation,
  PrLookup,
  SessionHandle,
  WorktreeMeta,
  WorktreeService,
} from './session-ports';
import type { SessionState } from './types';

export interface PrCoordinatorDeps {
  worktrees: WorktreeService;
  /** When true (with prAutomation), a completed session is pushed + gets a draft PR. */
  autoPr?: boolean;
  /** PR create/checks/ready seam (via `gh`); required for autoPr. */
  prAutomation?: PrAutomation;
  /** Open-PR lookup (via `gh`); when set, refreshPrs() polls each live branch. */
  lookupPr?: PrLookup;
  getMeta: (id: string) => WorktreeMeta | undefined;
  getState: (id: string) => SessionState | undefined;
  getSession: (id: string) => SessionHandle | undefined;
  ids: () => readonly string[];
}

/**
 * Best-effort GitHub PR automation for sessions, kept out of SessionManager.
 * Opens a draft PR when a session first completes with committed work, and polls
 * live branches to surface `#<n>` (readying a draft once its checks pass). Every
 * `gh`/network failure is swallowed so it never disrupts a session.
 */
export class PrCoordinator {
  /** Sessions we've already attempted an auto-PR for (avoids repeat push/create). */
  private readonly attempted = new Set<string>();

  constructor(private readonly deps: PrCoordinatorDeps) {}

  /**
   * Push the branch and open a draft PR for a just-completed session (once each).
   * No-op unless autoPr + prAutomation are wired, the session already has a PR, or
   * the branch has nothing committed ahead of base. refreshPrs() later readies it.
   */
  async maybeAutoPr(id: string): Promise<void> {
    if (!this.deps.autoPr || !this.deps.prAutomation || this.attempted.has(id)) {
      return;
    }
    const meta = this.deps.getMeta(id);
    const state = this.deps.getState(id);
    const session = this.deps.getSession(id);
    if (!meta || !state || !session || state.pr) {
      return;
    }
    this.attempted.add(id);
    try {
      const stat = await this.deps.worktrees.diffStat(meta.worktree, meta.base);
      if (stat.committed.trim().length === 0) {
        // Nothing committed ahead of base — there's nothing to open a PR for.
        return;
      }
      await this.deps.worktrees.pushBranch(meta.worktree);
      const pr = await this.deps.prAutomation.createPr(meta.worktree.path, state.branch);
      if (pr) {
        session.setPr(pr);
      }
    } catch {
      // best-effort — a missing remote / `gh` / network issue must not disrupt the session
    }
  }

  /**
   * Poll every live session's branch for an open PR and feed the result back in
   * via session.setPr (the reducer no-ops when unchanged). Best-effort per session;
   * one lookup failure never rejects or affects the others. No-op with no lookupPr.
   */
  async refreshPrs(): Promise<void> {
    const lookup = this.deps.lookupPr;
    if (!lookup) {
      return;
    }
    await Promise.all(
      this.deps.ids().map(async (id) => {
        const state = this.deps.getState(id);
        const meta = this.deps.getMeta(id);
        const session = this.deps.getSession(id);
        // Skip rows with no worktree yet (creating) or already archived — nothing
        // to look up, and no branch that could have a PR.
        if (!state || !meta || !session || state.status === 'archived') {
          return;
        }
        try {
          const pr = await lookup(meta.worktree.path, state.branch);
          session.setPr(pr);
          // Auto-ready: once a draft PR's checks pass, flip it to ready-for-review.
          if (this.deps.autoPr && this.deps.prAutomation && pr?.isDraft) {
            const checks = await this.deps.prAutomation.checks(meta.worktree.path, state.branch);
            if (checks === 'passing') {
              await this.deps.prAutomation.markReady(meta.worktree.path, state.branch);
              session.setPr({ ...pr, isDraft: false });
            }
          }
        } catch {
          // best-effort — a missing `gh`, network hiccup, or auth issue is ignored
        }
      }),
    );
  }
}
