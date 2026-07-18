import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import type { RunMode, SessionManager, SessionState } from '@/core';

/**
 * Subscribe to the manager's snapshot. Notifications are coalesced to ~100ms so
 * a burst of streaming updates causes at most one re-render per window.
 */
export function useSessions(manager: SessionManager): SessionState[] {
  const subscribe = useCallback(
    (onChange: () => void) => {
      let scheduled = false;
      return manager.subscribe(() => {
        if (scheduled) {
          return;
        }
        scheduled = true;
        setTimeout(() => {
          scheduled = false;
          onChange();
        }, 100);
      });
    },
    [manager],
  );
  return useSyncExternalStore(
    subscribe,
    () => manager.getSnapshot(),
    () => manager.getSnapshot(),
  );
}

/** Subscribe to the manager's global tool-approval mode (auto ⇄ confirm). */
export function useRunMode(manager: SessionManager): RunMode {
  return useSyncExternalStore(
    (onChange) => manager.subscribe(onChange),
    () => manager.getMode(),
    () => manager.getMode(),
  );
}

/** A clock that ticks every `ms` so elapsed-time displays stay current. */
export function useClock(ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(timer);
  }, [ms]);
  return now;
}
