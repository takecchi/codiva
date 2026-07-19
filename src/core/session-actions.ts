import { errorMessage } from './errors';
import type { ActionResult, SessionHandle, WorktreeMeta, WorktreeService } from './session-ports';
import { type DiffStat, MergeConflictError } from './worktree';

/** Committed diff stat vs. base plus uncommitted paths for a session's worktree. */
export function sessionDiffStat(worktrees: WorktreeService, meta: WorktreeMeta): Promise<DiffStat> {
  return worktrees.diffStat(meta.worktree, meta.base);
}

/**
 * Merge a session's branch into base, then archive it. On a merge conflict the
 * session is flagged (so the list shows a `conflict` badge) and the failure is
 * surfaced to the UI; we never auto-resolve.
 */
export async function mergeSession(
  worktrees: WorktreeService,
  meta: WorktreeMeta,
  session: SessionHandle | undefined,
): Promise<ActionResult> {
  try {
    await worktrees.merge(meta.worktree, meta.base);
    session?.archive();
    return { ok: true };
  } catch (err) {
    if (err instanceof MergeConflictError) {
      session?.markConflict(err.files);
    }
    return { ok: false, error: errorMessage(err) };
  }
}

/**
 * Abort a session and remove its worktree + branch, then archive it. Returns the
 * outcome; the caller drops the session's worktree metadata on success.
 */
export async function discardSession(
  worktrees: WorktreeService,
  meta: WorktreeMeta,
  session: SessionHandle | undefined,
  opts: { force?: boolean } = {},
): Promise<ActionResult> {
  session?.abort();
  try {
    await worktrees.remove(meta.worktree, opts);
    session?.archive();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}
