import type { DOMElement } from 'ink';
import { type RefObject, useCallback, useEffect, useState, useSyncExternalStore } from 'react';
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

/** Position of a box relative to the Ink output origin (terminal cells). */
export interface AbsolutePosition {
  left: number;
  top: number;
}

/**
 * Absolute (output-origin) position of an Ink box. `useCursor` expects
 * output-origin coordinates but `useBoxMetrics` is parent-relative, so this
 * walks up the node tree summing each ancestor's computed offset. Measured
 * after every render (same cadence as Ink's own `useBoxMetrics`); re-renders
 * only when the position actually changes.
 */
export function useAbsolutePosition(
  ref: RefObject<DOMElement | null>,
): AbsolutePosition | undefined {
  const [pos, setPos] = useState<AbsolutePosition | undefined>(undefined);
  useEffect(() => {
    if (!ref.current) {
      setPos(undefined);
      return;
    }
    let left = 0;
    let top = 0;
    for (let node: DOMElement | undefined = ref.current; node; node = node.parentNode) {
      const layout = node.yogaNode?.getComputedLayout();
      if (!layout) {
        // Detached from the tree mid-walk — treat as unmeasured.
        setPos(undefined);
        return;
      }
      left += layout.left;
      top += layout.top;
    }
    setPos((prev) => (prev && prev.left === left && prev.top === top ? prev : { left, top }));
  });
  return pos;
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
