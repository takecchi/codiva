import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { emptyPersistedState, fromPersistedJson, type PersistedState } from '@/core';

/**
 * Thin I/O wrapper for the session-restore state file. The pure validation lives
 * in core (`fromPersistedJson`); this only reads/writes the JSON. The file sits at
 * `<repo>/.codiva/state.json`, alongside the worktrees and already git-excluded.
 */
export function defaultStatePath(repoRoot: string): string {
  return join(repoRoot, '.codiva', 'state.json');
}

/** Load persisted state. A missing or corrupt file yields an empty state (never throws). */
export async function loadState(path: string): Promise<PersistedState> {
  try {
    return fromPersistedJson(JSON.parse(await readFile(path, 'utf8')));
  } catch {
    return emptyPersistedState();
  }
}

/** Write persisted state, creating `.codiva/` if needed. */
export async function saveState(state: PersistedState, path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

/**
 * Drop persisted sessions whose worktree directory no longer exists (e.g. removed
 * outside codiva). Prevents restoring dangling sessions that can't be resumed.
 */
export function pruneMissingWorktrees(state: PersistedState): PersistedState {
  return { ...state, sessions: state.sessions.filter((s) => existsSync(s.worktreePath)) };
}
