import type { PersistedState } from '@/core';
import { saveState, saveStateSync } from '@/utils';

export interface PersistController {
  /** Debounced async save (coalesces a burst of updates to one write per window). */
  schedule: () => void;
  /** Synchronous save for hard termination (SIGTERM/SIGHUP), where async wouldn't run. */
  flushSync: () => void;
  /** Cancel any pending debounce and write once more (normal quit). */
  flushAsync: () => Promise<void>;
}

/**
 * Owns writing the restore snapshot to `<repo>/.codiva/state.json`. The three
 * flush paths (debounced during a run, synchronous on kill, final on quit) are one
 * concern, so they live together here rather than scattered through the entry point.
 * `snapshot` is read lazily at write time so the manager can be wired after this.
 */
export function createPersistController(
  snapshot: () => PersistedState,
  statePath: string,
): PersistController {
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Bumped by every synchronous flush. An async write that was already running
  // captured the snapshot *before* that flush, so its rename rolled the file back
  // to older state — write the current snapshot again to repair it. (In the real
  // shutdown path `process.exit` follows the sync flush and nothing runs, but the
  // repair keeps the ordering honest wherever the process survives.)
  let syncGeneration = 0;
  // Writes are chained so the *content* is current too: the snapshot is read when
  // the write starts, never when it was scheduled. That makes it impossible for a
  // queued save to land state older than what the previous write already published.
  let queue: Promise<void> = Promise.resolve();
  const save = (): Promise<void> => {
    const run = queue.then(async () => {
      // Loop until no sync flush landed while we were writing: repairing once is
      // not enough, since a second flush during the repair write would itself be
      // rolled back by that write's rename. Terminates because the only caller of
      // `flushSync` is the signal handler, which exits right after.
      let generation = syncGeneration;
      for (;;) {
        await saveState(snapshot(), statePath);
        if (generation === syncGeneration) {
          return;
        }
        generation = syncGeneration;
      }
    });
    // Keep the chain alive after a failed write; saves are best-effort.
    queue = run.catch(() => undefined);
    return queue;
  };
  return {
    schedule: () => {
      if (timer) {
        clearTimeout(timer);
      }
      timer = setTimeout(() => {
        void save();
      }, 500);
    },
    flushSync: () => {
      try {
        saveStateSync(snapshot(), statePath);
      } catch {
        // best-effort — never block shutdown on a failed save
      } finally {
        syncGeneration += 1;
      }
    },
    flushAsync: async () => {
      if (timer) {
        clearTimeout(timer);
      }
      await save();
    },
  };
}
