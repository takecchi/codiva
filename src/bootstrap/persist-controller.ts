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
  const save = () => saveState(snapshot(), statePath).catch(() => undefined);
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
