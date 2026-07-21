import type { DOMElement } from 'ink';
import {
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import {
  type CommandAction,
  emptyBuffer,
  type RateLimitWindow,
  type RunMode,
  runCommand,
  type SessionManager,
  type SessionState,
  type TextBuffer,
} from '@/core';

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

/**
 * Subscribe to the account-wide claude.ai subscription usage windows. The manager
 * returns a stable array reference across no-op events, so this only re-renders
 * when a window actually changes (safe for useSyncExternalStore).
 */
export function useRateLimit(manager: SessionManager): RateLimitWindow[] {
  return useSyncExternalStore(
    (onChange) => manager.subscribe(onChange),
    () => manager.getRateLimits(),
    () => manager.getRateLimits(),
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

/**
 * Computed content height (terminal rows) of an Ink box, measured after every
 * render. A `flexGrow` box in a height-constrained parent reports its allocated
 * height regardless of how much content it holds, so this yields the space a
 * scrollable list may fill. Undefined until first measured. Re-renders only when
 * the height actually changes.
 */
export function useBoxHeight(ref: RefObject<DOMElement | null>): number | undefined {
  const [height, setHeight] = useState<number | undefined>(undefined);
  useEffect(() => {
    const layout = ref.current?.yogaNode?.getComputedLayout();
    const next = layout?.height;
    setHeight((prev) => (prev === next ? prev : next));
  });
  return height;
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

export interface TextBufferRef {
  buffer: TextBuffer;
  bufferRef: RefObject<TextBuffer>;
  updateBuffer: (next: TextBuffer | ((prev: TextBuffer) => TextBuffer)) => void;
}

/**
 * A composer text buffer whose edits are applied through a ref before the render
 * state. Terminals deliver key repeats / pastes / escape sequences as one chunk,
 * so a `useInput` handler can fire multiple times in the same tick; going through
 * the ref keeps each edit computed from the latest value instead of a stale one
 * (see .claude/rules/ink-components.md). Shared by both composer views.
 *
 * `initial` seeds the buffer once (e.g. the repo-prompt editor opens on the
 * existing `.codiva/prompt.md` content); omitted, it starts empty like a composer.
 */
export function useTextBufferRef(initial?: TextBuffer): TextBufferRef {
  const [buffer, setBuffer] = useState<TextBuffer>(() => initial ?? emptyBuffer());
  const bufferRef = useRef<TextBuffer>(buffer);
  const updateBuffer = (next: TextBuffer | ((prev: TextBuffer) => TextBuffer)) => {
    bufferRef.current = typeof next === 'function' ? next(bufferRef.current) : next;
    setBuffer(bufferRef.current);
  };
  return { buffer, bufferRef, updateBuffer };
}

/**
 * Resolve a `/command` typed in a composer and dispatch its effect. Known actions
 * run the matching handler (a view supplies only the ones it implements — e.g.
 * `/diff` is detail-only); an unknown name surfaces via `onError`. Clears the
 * error on any recognized command. Shared by the list and detail composers.
 */
export function useCommandRunner(
  handlers: Partial<Record<CommandAction, () => void>>,
  onError: (message: string | undefined) => void,
  unknownLabel: (name: string) => string,
): (text: string) => void {
  return (text: string) => {
    const result = runCommand(text);
    if (result.kind === 'unknown') {
      onError(unknownLabel(result.name));
      return;
    }
    onError(undefined);
    handlers[result.command.action]?.();
  };
}

export interface LifecycleAction {
  confirm: 'merge' | 'discard' | null;
  setConfirm: (confirm: 'merge' | 'discard' | null) => void;
  busy: boolean;
  actionError: string | undefined;
  setActionError: (error: string | undefined) => void;
  run: (action: 'merge' | 'discard') => void;
}

/**
 * The merge/discard confirm → busy → run → error flow shared by both views.
 * `run` no-ops when `id` is undefined (nothing selected). `onDone(ok)` fires after
 * completion so a view can react (e.g. the detail view returns to its input panel).
 */
export function useLifecycleAction(
  manager: SessionManager,
  id: string | undefined,
  onDone?: (ok: boolean) => void,
): LifecycleAction {
  const [confirm, setConfirm] = useState<'merge' | 'discard' | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | undefined>(undefined);
  const run = (action: 'merge' | 'discard') => {
    if (id === undefined) {
      return;
    }
    setBusy(true);
    const promise = action === 'merge' ? manager.merge(id) : manager.discard(id, { force: true });
    promise.then((result) => {
      setBusy(false);
      setConfirm(null);
      setActionError(result.ok ? undefined : result.error);
      onDone?.(result.ok);
    });
  };
  return { confirm, setConfirm, busy, actionError, setActionError, run };
}
