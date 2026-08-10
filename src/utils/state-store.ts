import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
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

function serialize(state: PersistedState): string {
  return `${JSON.stringify(state, null, 2)}\n`;
}

/**
 * Temp file for the atomic write, in the same directory so `rename` stays within
 * one filesystem. The name is fixed per (path, process, writer) instead of unique
 * per call so a process killed mid-write leaves at most two strays, not one per
 * write: async writes are serialized (see `saveState`) and the sync writer gets its
 * own name, so no two live writes ever share a temp file. The pid keeps a second
 * codiva running on the same repo from clobbering our half-written temp.
 */
function tempPath(path: string, writer: 'async' | 'sync'): string {
  return `${path}.${process.pid}.${writer}.tmp`;
}

/** Serializes writes per state path — see `saveState`. */
const writeQueues = new Map<string, Promise<void>>();

async function writeAtomic(state: PersistedState, path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = tempPath(path, 'async');
  try {
    const handle = await open(tmp, 'w');
    try {
      await handle.writeFile(serialize(state), 'utf8');
      // fsync before the rename: without it a crash can publish a rename whose
      // bytes never reached disk, and `loadState` would fall back to empty state.
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmp, path);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
}

/**
 * Write persisted state, creating `.codiva/` if needed.
 *
 * Two hazards this has to avoid, both of which lose every restorable session:
 * 1. **Torn file** — writing `path` in place leaves truncated JSON if the process
 *    dies mid-write, and `loadState` reads that as "no sessions". So we write a
 *    temp file, fsync it, and `rename` it over the target (atomic on POSIX).
 * 2. **Out-of-order writes** — a debounced save still in flight must not land
 *    after a newer one. Writes to the same path are chained, so the renames
 *    happen in call order and the last caller wins.
 */
export async function saveState(state: PersistedState, path: string): Promise<void> {
  const tail = writeQueues.get(path) ?? Promise.resolve();
  const run = tail.then(() => writeAtomic(state, path));
  // The queue itself must never reject: one failed write must not poison later saves.
  writeQueues.set(
    path,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  await run;
}

/**
 * Synchronous save for exit/signal handlers (SIGTERM/SIGHUP), where the event
 * loop won't run pending async writes before the process dies. Same temp+rename
 * dance as `saveState`, on its own temp file so it can't collide with an async
 * write that is still in flight (that one's rename never happens — the process
 * exits first — so it cannot roll this snapshot back either).
 */
export function saveStateSync(state: PersistedState, path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = tempPath(path, 'sync');
  try {
    const fd = openSync(tmp, 'w');
    try {
      writeSync(fd, serialize(state));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
  } catch (error) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // leaving a stray temp file behind is better than masking the real error
    }
    throw error;
  }
}

/**
 * Drop persisted sessions whose worktree directory no longer exists (e.g. removed
 * outside codiva). Prevents restoring dangling sessions that can't be resumed.
 */
export function pruneMissingWorktrees(state: PersistedState): PersistedState {
  return { ...state, sessions: state.sessions.filter((s) => existsSync(s.worktreePath)) };
}
