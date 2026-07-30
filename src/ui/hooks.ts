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
  type AccountSummary,
  type CommandAction,
  emptyBuffer,
  FALLBACK_MODEL_OPTIONS,
  isCommandInput,
  type ModelOption,
  normalizeSelection,
  type RateLimitWindow,
  type RunMode,
  runCommand,
  type SelectionRange,
  type SessionManager,
  type SessionState,
  selectionText,
  type TextBuffer,
  type TrainingOptIn,
  toCommandInput,
  type UpdateCheck,
  type UpdateInfo,
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

/**
 * Subscribe to the authenticated claude.ai account (plan name / organization) the
 * SDK probe reported. Undefined until the first probe answers, and for logins that
 * report no plan at all (API keys, Bedrock/Vertex). The manager keeps the same
 * object reference unless a field actually changes, so this is re-render safe.
 */
export function useAccount(manager: SessionManager): AccountSummary | undefined {
  return useSyncExternalStore(
    (onChange) => manager.subscribe(onChange),
    () => manager.getAccount(),
    () => manager.getAccount(),
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

/**
 * Resolve the startup update check into render state.
 *
 * The check is kicked off in the composition root (`index.tsx`) *before* render
 * and never awaited, so a slow/offline registry can't delay startup. Until it
 * lands (and forever, if no check was injected) this returns `undefined` and the
 * banner simply shows no update line.
 *
 * Only the "there is a newer version" case is surfaced here: "already latest"
 * and "couldn't reach the registry" must not add a banner line — the user asked
 * for an update *notification*, not a status readout. `/update` is where the
 * distinction is spelled out.
 *
 * `clear` を返すのは、更新を適用したあとに案内を引っ込めるため。適用後も実行中の
 * プロセスは旧版なので通知自体は嘘ではないが、「/update で更新」と誘い続けるのは
 * 混乱するので、以降の案内はダイアログの「再起動してください」に一本化する。
 */
export function useUpdateCheck(initial?: Promise<UpdateCheck>): {
  info: UpdateInfo | undefined;
  clear: () => void;
} {
  const [info, setInfo] = useState<UpdateInfo | undefined>(undefined);
  useEffect(() => {
    // Promise が差し替わったら前の結果を持ち越さない（別のチェック結果なので）。
    setInfo(undefined);
    if (!initial) {
      return;
    }
    let live = true;
    initial
      .then((check) => {
        if (live) {
          // 「最新」「確認できず」でも既存の案内を消す（古い判定を残さない）。
          setInfo(check.kind === 'available' ? check.info : undefined);
        }
      })
      // 取得失敗はバナーに何も出さない（起動画面にエラーを増やさない）。
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [initial]);
  const clear = useCallback(() => setInfo(undefined), []);
  return { info, clear };
}

/**
 * Resolve the model catalog fetched from Claude Code into render state.
 *
 * The fetch is kicked off once in the composition root (`index.tsx`) *before*
 * render, so by the time the user opens `/model` it has almost always landed.
 * The promise identity is therefore stable and this never re-fetches.
 *
 * Returns `undefined` while the fetch is still in flight — `ModelSelect` shows a
 * loading line for that state rather than a list that would mutate under the
 * cursor when the real catalog arrives. An empty/failed result falls back to
 * `FALLBACK_MODEL_OPTIONS` so `/model` stays usable offline.
 */
export function useModelCatalog(
  catalog?: Promise<readonly ModelOption[]>,
): readonly ModelOption[] | undefined {
  const [models, setModels] = useState<readonly ModelOption[] | undefined>(
    // No fetch injected (tests, and any host that opts out) → use the fallback
    // immediately instead of parking on a loading line forever.
    catalog ? undefined : FALLBACK_MODEL_OPTIONS,
  );
  useEffect(() => {
    if (!catalog) {
      setModels(FALLBACK_MODEL_OPTIONS);
      return;
    }
    let live = true;
    catalog
      .then((options) => {
        if (live) {
          setModels(options.length > 0 ? options : FALLBACK_MODEL_OPTIONS);
        }
      })
      .catch(() => {
        if (live) {
          setModels(FALLBACK_MODEL_OPTIONS);
        }
      });
    return () => {
      live = false;
    };
  }, [catalog]);
  return models;
}

/**
 * 学習データ利用（claude.ai の「Help improve our AI models」）の判定結果を描画 state へ。
 *
 * 取得は合成ルート（`index.tsx`）が render 前に始める。キャッシュに当たれば即答だが、
 * 非公開エンドポイントへ問い合わせるときは数百 ms かかるため、**起動はブロックしない**
 * （解決したらバナーに注意行が増える）。`fetchTrainingOptIn` は throw しないが、
 * 万一の rejection でも警告を出さない側（'unknown'）へ倒す。
 */
export function useTrainingOptIn(probe?: Promise<TrainingOptIn>): TrainingOptIn {
  const [optIn, setOptIn] = useState<TrainingOptIn>('unknown');
  useEffect(() => {
    if (!probe) {
      return;
    }
    let live = true;
    probe
      .then((value) => {
        if (live) {
          setOptIn(value);
        }
      })
      .catch(() => {
        // 判定できないだけ。警告は出さない。
      });
    return () => {
      live = false;
    };
  }, [probe]);
  return optIn;
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

export interface CommandRunner {
  /**
   * Dispatch the submitted text. Returns whether it was consumed as a command;
   * `false` means the caller should treat it as a normal instruction.
   */
  run: (text: string) => boolean;
  /**
   * The same resolution without side effects, for the palette: the normalized
   * command input (`/name ...`) or null when the text is a normal instruction.
   * Sharing it with `run` keeps the preview honest — whatever the palette shows
   * is exactly what Enter will do.
   */
  preview: (value: string) => string | null;
}

/**
 * Resolve a command typed in a composer and dispatch its effect. Known actions
 * run the matching handler (a view supplies only the ones it implements — e.g.
 * `/diff` is detail-only); an unknown name surfaces via `onError`. Clears the
 * error on any recognized command. Shared by the list and detail composers.
 *
 * Slash-prefixed text is always a command (an unknown name becomes an error, not
 * a prompt). A bare command name (`exit`) counts as one too, but only when this
 * view implements it — otherwise typing `clear` in the detail view would vanish
 * with no feedback at all instead of reaching the session as an instruction.
 */
export function useCommandRunner(
  handlers: Partial<Record<CommandAction, () => void>>,
  onError: (message: string | undefined) => void,
  unknownLabel: (name: string) => string,
): CommandRunner {
  /** Command input this view would act on, or null → normal instruction. */
  const resolve = (text: string): string | null => {
    const command = toCommandInput(text);
    if (command === null || isCommandInput(text)) {
      return command;
    }
    const result = runCommand(command);
    // Bare names only resolve to commands this view implements.
    return result.kind === 'run' && handlers[result.command.action] ? command : null;
  };
  return {
    preview: resolve,
    run: (text: string) => {
      const command = resolve(text);
      if (command === null) {
        return false;
      }
      const result = runCommand(command);
      if (result.kind === 'unknown') {
        onError(unknownLabel(result.name));
        return true;
      }
      onError(undefined);
      handlers[result.command.action]?.();
      return true;
    },
  };
}

export interface DragSelection {
  /** The current highlighted range, or undefined when nothing is selected. */
  selection: SelectionRange | undefined;
  /** True between a press and its release (a drag is in progress). */
  dragging: () => boolean;
  /** Mouse press inside the selectable text: set the anchor and drop any old selection. */
  begin: (index: number) => void;
  /** Mouse drag: move the focus end to `index`, updating the highlight live. */
  extend: (index: number) => void;
  /** Mouse release: copy the selected text (if any) to the clipboard. */
  end: (value: string) => void;
  /** Drop the selection (e.g. the user typed or moved the caret with a key). */
  clear: () => void;
}

/**
 * Mouse-drag text selection over a block of text, shared by the composers of both
 * views and the list header (so the repo path can be copied out of the banner). A
 * press sets an anchor caret index, drags extend the focus (live highlight), and
 * release copies the selected substring via the injected `onCopy` (OSC 52). Copy
 * fires once on release — never per drag event — so a burst of motion reports
 * doesn't spam the clipboard (a bug seen in other TUIs). The selection stays
 * highlighted after release until a key clears it. Anchor/focus live in refs so
 * `end` reads the final range even if the last `extend`'s state update hasn't
 * flushed.
 *
 * One instance per selectable region: the caret indices are relative to whichever
 * text that region's `end(value)` is called with.
 */
export function useDragSelection(onCopy?: (text: string) => void): DragSelection {
  const [selection, setSelection] = useState<SelectionRange | undefined>(undefined);
  const anchorRef = useRef<number | undefined>(undefined);
  const focusRef = useRef<number | undefined>(undefined);
  const selectionRef = useRef<SelectionRange | undefined>(undefined);

  const set = (next: SelectionRange | undefined) => {
    selectionRef.current = next;
    setSelection(next);
  };

  const begin = (index: number) => {
    anchorRef.current = index;
    focusRef.current = index;
    set(undefined);
  };
  const extend = (index: number) => {
    if (anchorRef.current === undefined) {
      return;
    }
    focusRef.current = index;
    set(normalizeSelection(anchorRef.current, index));
  };
  const end = (value: string) => {
    const anchor = anchorRef.current;
    const focus = focusRef.current;
    anchorRef.current = undefined;
    if (anchor === undefined || focus === undefined) {
      return;
    }
    const range = normalizeSelection(anchor, focus);
    if (range) {
      onCopy?.(selectionText(value, range));
    }
  };
  const clear = () => {
    anchorRef.current = undefined;
    focusRef.current = undefined;
    if (selectionRef.current) {
      set(undefined);
    }
  };
  const dragging = () => anchorRef.current !== undefined;
  return { selection, dragging, begin, extend, end, clear };
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
