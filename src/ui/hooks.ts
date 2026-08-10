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
  type ActionResult,
  type AgentAvailability,
  type AgentId,
  COMPOSER_PREFIX_CELLS,
  type CommandAction,
  type DisplayLine,
  emptyBuffer,
  emptyInputHistory,
  errorMessage,
  FALLBACK_MODEL_OPTIONS,
  type InputHistory,
  isCommandInput,
  type LogPoint,
  type LogRange,
  logSelectionText,
  type Messages,
  type ModelOption,
  normalizeLogSelection,
  normalizeSelection,
  type RateLimitWindow,
  type RecoveryKind,
  type RunMode,
  recallNext,
  recallPrev,
  recordInput,
  recoveryNotice,
  resetHistoryBrowse,
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
      let timer: ReturnType<typeof setTimeout> | undefined;
      const unsubscribe = manager.subscribe(() => {
        if (timer !== undefined) {
          return;
        }
        timer = setTimeout(() => {
          timer = undefined;
          onChange();
        }, 100);
      });
      // 保留中の tick も止める（アンマウント後に onChange が発火しないように）。
      return () => {
        if (timer !== undefined) {
          clearTimeout(timer);
          timer = undefined;
        }
        unsubscribe();
      };
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

/**
 * Wrap width (cells) available to composer *text* inside a measured box: its
 * computed width minus the `❯ `／`  ` row prefix. Undefined until the first
 * measurement, which every consumer reads as "don't wrap yet" — a long line is
 * truncated for that single frame and wraps as soon as the width lands.
 *
 * Both `PromptInput` (which renders the wrap) and the views that own a composer
 * (which hit-test clicks and move the caret by display row) must derive the width
 * this way: they measure boxes of equal width, so the geometry agrees. Deriving it
 * from `columns` instead would break inside dialogs (borders/padding).
 */
export function useComposerWidth(ref: RefObject<DOMElement | null>): number | undefined {
  const width = useBoxWidth(ref);
  return width === undefined ? undefined : Math.max(1, width - COMPOSER_PREFIX_CELLS);
}

/**
 * Computed content width (terminal cells) of an Ink box, measured after every
 * render (the horizontal twin of {@link useBoxHeight}). Undefined until first
 * measured; re-renders only when the width actually changes.
 */
export function useBoxWidth(ref: RefObject<DOMElement | null>): number | undefined {
  const [width, setWidth] = useState<number | undefined>(undefined);
  useEffect(() => {
    const layout = ref.current?.yogaNode?.getComputedLayout();
    const next = layout?.width;
    setWidth((prev) => (prev === next ? prev : next));
  });
  return width;
}

/**
 * 現在ブランチの読み直し間隔。ブランチは codiva の外（別ターミナルの `git switch`）でも
 * 変わるので購読できる相手がおらず、定期的に読み直すしかない。1 回の問い合わせは
 * `git symbolic-ref` 1 本（数 ms、ネットワークなし）なので秒単位で回して差し支えないが、
 * 「切り替えたのに古いまま」の窓が数秒あっても実害はない程度の間隔にしてある。
 */
export const BRANCH_POLL_INTERVAL_MS = 5_000;

/**
 * 対象リポジトリが今チェックアウトしているブランチ（ヘッダに出す）。取得は合成ルートが
 * 注入する（`utils/worktree-manager.ts` の `currentBranch()`）。未注入・detached HEAD・
 * git の失敗はすべて undefined で、そのときヘッダはブランチを表示しない。
 *
 * 呼ぶのは**ビュー切替でアンマウントされない場所**（`app.tsx`）にする。一覧の中で呼ぶと
 * 詳細ビューへ行って戻るたびにタイマーが張り替わり、戻った直後の 1 フレームだけ
 * ブランチが消える。
 *
 * **`load` を undefined にするとポーリングだけ止まり、値は保たれる**。ヘッダを描いていない
 * 間（詳細ビュー）に git を呼び続けないための入口で、一覧へ戻ると即座に 1 回読み直す。
 * state はこのフック（= `app.tsx`）に残るので、戻った瞬間から前の値が出る。
 *
 * 取得関数は ref 経由で読み、effect の依存には**注入されているか**だけを載せる。
 * インラインの arrow を渡されても（描画ごとに identity が変わる）タイマーを張り替えず、
 * git を呼び続けないため。
 */
export function useBranch(
  load?: () => Promise<string | undefined>,
  intervalMs = BRANCH_POLL_INTERVAL_MS,
): string | undefined {
  const [branch, setBranch] = useState<string | undefined>(undefined);
  const loadRef = useRef(load);
  // ref の更新は描画中ではなく effect で行う（React は描画中の ref 書き込みを禁じている。
  // タイマーが読むのは commit 後なので、これで最新の関数が渡る）。
  useEffect(() => {
    loadRef.current = load;
  });
  const enabled = load !== undefined;
  useEffect(() => {
    if (!enabled) {
      return;
    }
    let alive = true;
    const read = () => {
      try {
        // 表示のためだけの問い合わせなので、失敗しても直前の表示を保って黙る。
        // 同期 throw も拾う（`void p.then(…)` だけでは呼び出し自体の例外が漏れ、
        // 5 秒ごとの uncaughtException で TUI が落ちる）。
        void loadRef.current?.().then(
          (next) => {
            if (alive) {
              setBranch((prev) => (prev === next ? prev : next));
            }
          },
          () => undefined,
        );
      } catch {
        // 同上（次の tick で読み直す）。
      }
    };
    // ref を更新する effect は**この effect より先に宣言**してあるので、ここに来た時点で
    // `loadRef.current` は最新（React は effect を宣言順に流す）。
    read();
    const timer = setInterval(read, intervalMs);
    timer.unref?.();
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [enabled, intervalMs]);
  return branch;
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
 * The check is kicked off in the composition root (`main.tsx`) *before* render
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
 * The fetch is kicked off once in the composition root (`main.tsx`) *before*
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
  fallback: readonly ModelOption[] = FALLBACK_MODEL_OPTIONS,
): readonly ModelOption[] | undefined {
  const [models, setModels] = useState<readonly ModelOption[] | undefined>(
    // No fetch injected (tests, and any host that opts out) → use the fallback
    // immediately instead of parking on a loading line forever.
    catalog ? undefined : fallback,
  );
  useEffect(() => {
    if (!catalog) {
      setModels(fallback);
      return;
    }
    let live = true;
    catalog
      .then((options) => {
        if (live) {
          setModels(options.length > 0 ? options : fallback);
        }
      })
      .catch(() => {
        if (live) {
          setModels(fallback);
        }
      });
    return () => {
      live = false;
    };
  }, [catalog, fallback]);
  return models;
}

/**
 * 登録エージェントの導入・ログイン状態を購読する。
 *
 * `manager.getAgentAvailability()` は検出済みの Map（未検出は空）で、検出は
 * `manager.checkAgents()` が非同期に埋めて `store.notify()` する。`enabled` が true に
 * なった最初のフレームで検出を起動する（`/agent` を開いたときだけ叩く用）。起動時にも
 * `main.tsx` が 1 回叩くので、多くの場合は開いた時点で解決済み。
 */
export function useAgentAvailability(
  manager: SessionManager,
  enabled: boolean,
): ReadonlyMap<AgentId, AgentAvailability> {
  const availability = useSyncExternalStore(
    (onChange) => manager.subscribe(onChange),
    () => manager.getAgentAvailability(),
    () => manager.getAgentAvailability(),
  );
  useEffect(() => {
    if (enabled) {
      void manager.checkAgents().catch(() => undefined);
    }
  }, [enabled, manager]);
  return availability;
}

/**
 * 学習データ利用（claude.ai の「Help improve our AI models」）の判定結果を描画 state へ。
 *
 * 取得は合成ルート（`main.tsx`）が render 前に始める。キャッシュに当たれば即答だが、
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

export interface InputHistoryControl {
  /** 現在の履歴。親へ報告して再マウント後も引き継ぐために公開する。 */
  history: InputHistory;
  /** 送信したテキストを積む（呼び出し位置もリセットされる）。 */
  record: (text: string) => void;
  /**
   * ↑/↓ の履歴呼び出し。呼び出せたテキストを返し、呼び出せないとき（履歴が空・最古に
   * 到達・辿っていないのに ↓）は undefined を返す。undefined のときは呼び出し側が
   * 通常のキャレット移動へ委ねる。
   */
  recall: (dir: 'prev' | 'next', current: string) => string | undefined;
}

/**
 * 入力欄の履歴（shell の ↑↓）。判定はすべて純粋な `core/input-history.ts` に委譲し、
 * ここは state の保持だけを持つ。`useTextBufferRef` と同じ理由で ref 経由で逐次適用
 * する — 端末はキー連打を1チャンクで届けるので、同一 tick に複数回呼ばれても stale な
 * state から計算しないようにする（↑↑ が1回分に潰れない）。
 *
 * `initial` は再マウント時の引き継ぎ用（一覧はビュー切替でアンマウントされる）。辿り
 * かけの位置は引き継がない — 書きかけ（draft）はバッファごと失われているため、復元
 * すると ↓ で空文字が入る。
 */
export function useInputHistory(initial?: InputHistory): InputHistoryControl {
  const [history, setHistory] = useState<InputHistory>(() =>
    resetHistoryBrowse(initial ?? emptyInputHistory()),
  );
  const ref = useRef<InputHistory>(history);
  const apply = (next: InputHistory) => {
    ref.current = next;
    setHistory(next);
  };
  return {
    history,
    record: (text) => apply(recordInput(ref.current, text)),
    recall: (dir, current) => {
      const step = dir === 'prev' ? recallPrev(ref.current, current) : recallNext(ref.current);
      if (!step) {
        return undefined;
      }
      apply(step.history);
      return step.value;
    },
  };
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
 * press → drag → release で範囲を作る共通機械。位置の型 `P` と正規化 `normalize` だけを
 * 差し替えて、コンポーザ/ヘッダ（平坦な caret index）とログ（行 + 桁の `LogPoint`）の両方に
 * 使う。アンカー・終点は ref に持つ（`finish` が最後の `extend` の state 反映を待たずに
 * 確定した範囲を読めるように。端末は複数のレポートを 1 チャンクで届ける）。
 */
function useRangeSelection<P, R>(
  normalize: (anchor: P, focus: P) => R | undefined,
): {
  selection: R | undefined;
  dragging: () => boolean;
  /** ドラッグ中のアンカー（press した点）。release すると undefined に戻る。 */
  anchor: () => P | undefined;
  begin: (at: P) => void;
  extend: (at: P) => void;
  /** ドラッグを終了し、確定した範囲を返す（何も選択していなければ undefined）。 */
  finish: () => R | undefined;
  clear: () => void;
} {
  const [selection, setSelection] = useState<R | undefined>(undefined);
  const anchorRef = useRef<P | undefined>(undefined);
  const focusRef = useRef<P | undefined>(undefined);
  const selectionRef = useRef<R | undefined>(undefined);

  const set = (next: R | undefined) => {
    selectionRef.current = next;
    setSelection(next);
  };

  const begin = (at: P) => {
    anchorRef.current = at;
    focusRef.current = at;
    set(undefined);
  };
  const extend = (at: P) => {
    const anchor = anchorRef.current;
    if (anchor === undefined) {
      return;
    }
    focusRef.current = at;
    set(normalize(anchor, at));
  };
  const finish = (): R | undefined => {
    const anchor = anchorRef.current;
    const focus = focusRef.current;
    anchorRef.current = undefined;
    if (anchor === undefined || focus === undefined) {
      return undefined;
    }
    return normalize(anchor, focus);
  };
  const clear = () => {
    anchorRef.current = undefined;
    focusRef.current = undefined;
    if (selectionRef.current) {
      set(undefined);
    }
  };
  const dragging = () => anchorRef.current !== undefined;
  const anchor = () => anchorRef.current;
  return { selection, dragging, anchor, begin, extend, finish, clear };
}

/**
 * Mouse-drag text selection over a block of text, shared by the composers of both
 * views and the list header (so the repo path can be copied out of the banner). A
 * press sets an anchor caret index, drags extend the focus (live highlight), and
 * release copies the selected substring via the injected `onCopy` (OSC 52). Copy
 * fires once on release — never per drag event — so a burst of motion reports
 * doesn't spam the clipboard (a bug seen in other TUIs). The selection stays
 * highlighted after release until a key clears it.
 *
 * One instance per selectable region: the caret indices are relative to whichever
 * text that region's `end(value)` is called with.
 */
export function useDragSelection(onCopy?: (text: string) => void): DragSelection {
  const { selection, dragging, begin, extend, finish, clear } =
    useRangeSelection(normalizeSelection);
  const end = (value: string) => {
    const range = finish();
    if (range) {
      onCopy?.(selectionText(value, range));
    }
  };
  return { selection, dragging, begin, extend, end, clear };
}

export interface LogDragSelection {
  /** The current highlighted range (document rows), or undefined when nothing is selected. */
  selection: LogRange | undefined;
  /** True between a press and its release (a drag is in progress). */
  dragging: () => boolean;
  /**
   * ドラッグ中のアンカー（press した行 + 桁）。release で undefined に戻る。
   * 「まだ範囲になっていないドラッグ」がどこから始まったかを知るために要る —
   * ドラッグの最中に行の意味が変わったら（ストリーミング中の本文が確定エントリへ
   * 差し替わる等）アンカーごと捨てないと、離した時点で**触っていない行**がコピーされる。
   */
  anchor: () => LogPoint | undefined;
  /** Mouse press on a log row: set the anchor and drop any old selection. */
  begin: (at: LogPoint) => void;
  /** Mouse drag (or an auto-scroll tick): move the focus end, updating the highlight. */
  extend: (at: LogPoint) => void;
  /** Mouse release: copy the selected rows (if any) to the clipboard. */
  end: (lines: readonly DisplayLine[]) => void;
  /** Drop the selection (a key press, or a re-wrap that invalidated the rows). */
  clear: () => void;
}

/**
 * 詳細ビューのログの範囲選択。`useDragSelection` と同じ press/drag/release だが、位置が
 * **文書内の行 + 桁**（`LogPoint`）なので、ビューポートがスクロールしても選択は同じ文字を
 * 指し続ける（= 画面外へドラッグして自動スクロールしながら選択を伸ばせる）。コピーは
 * release で 1 回だけ、その時点の表示行から作る（`core/log-selection.ts`）。
 */
export function useLogDragSelection(onCopy?: (text: string) => void): LogDragSelection {
  const { selection, dragging, anchor, begin, extend, finish, clear } =
    useRangeSelection(normalizeLogSelection);
  const end = (lines: readonly DisplayLine[]) => {
    const range = finish();
    if (!range) {
      return;
    }
    const text = logSelectionText(lines, range);
    // 空文字ではクリップボードを触らない（行が短くなって両端が同じオフセットに丸まる
    // ケースがあり得る。選択できていないのに貼り付け内容を消してしまうのを防ぐ）。
    if (text.length > 0) {
      onCopy?.(text);
    }
  };
  return { selection, dragging, anchor, begin, extend, end, clear };
}

export interface RecoveryAction {
  /** One-line result of the last recovery (success path); cleared on the next key. */
  notice: string | undefined;
  setNotice: (notice: string | undefined) => void;
  /** True while a git/gh step is in flight (the base merge + push). */
  busy: boolean;
  /** Recover one session. `kind` forces sync/CI; omit to let the PR state decide. */
  run: (id: string, kind?: RecoveryKind) => void;
  /** Recover every session whose PR is stuck, in list order. */
  runAll: () => void;
}

/**
 * The `/sync` · `/fix-ci` · `/recover` flow shared by both views: run the manager's
 * recovery, then report the outcome as a notice (or an error).
 *
 * Kept out of the views because the mapping outcome → wording must not drift
 * between them, and because the "cheap outcomes are silent successes, not errors"
 * distinction is easy to get wrong — merging a base that was already merged is a
 * perfectly good result and must not paint the error row red.
 */
export function useRecovery(
  manager: SessionManager,
  m: Messages,
  onError: (message: string | undefined) => void,
): RecoveryAction {
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const run = (id: string, kind?: RecoveryKind) => {
    setBusy(true);
    manager
      .recover(id, kind)
      .then((outcome) => {
        setBusy(false);
        if (outcome.kind === 'error') {
          setNotice(undefined);
          onError(outcome.error);
          return;
        }
        onError(undefined);
        setNotice(recoveryNotice(outcome, m));
      })
      .catch(() => setBusy(false));
  };
  const runAll = () => {
    const targets = manager.recoverable();
    if (targets.length === 0) {
      setNotice(m.recover.skipped);
      return;
    }
    setBusy(true);
    let done = 0;
    let failure: string | undefined;
    // Sequential on purpose: each `sync` runs `git fetch` + `git merge` + `git push`
    // in a worktree of the same repository, and git takes a repo-wide index/ref lock.
    // Firing them together would make some of them fail on a lock they can't see.
    void targets
      .reduce<Promise<void>>(
        (chain, { state, kind }) =>
          chain.then(() =>
            manager
              .recover(state.id, kind)
              .then((outcome) => {
                // Count only what actually happened, and keep the first failure:
                // reporting "recovered N" when `gh` was unauthenticated and every
                // one of them failed is worse than reporting nothing.
                if (outcome.kind === 'error') {
                  failure ??= outcome.error;
                  return;
                }
                done += 1;
              })
              .catch((err: unknown) => {
                failure ??= errorMessage(err);
              }),
          ),
        Promise.resolve(),
      )
      .then(() => {
        setBusy(false);
        onError(failure);
        setNotice(done > 0 ? m.recover.allDone(done) : undefined);
      });
  };
  return { notice, setNotice, busy, run, runAll };
}

/**
 * Dispatch one lifecycle action to the manager, normalizing `/clear`'s outcome
 * (a count + an optional failure) into the same ActionResult the single-session
 * operations return, so the shared flow below has exactly one shape to handle.
 * `id` is guaranteed present for everything but `clear` (checked by the caller).
 */
function runLifecycle(
  manager: SessionManager,
  id: string | undefined,
  action: LifecycleKind,
): Promise<ActionResult> {
  if (action === 'clear') {
    return manager
      .clear()
      .then((outcome) =>
        outcome.error === undefined ? { ok: true } : { ok: false, error: outcome.error },
      );
  }
  if (id === undefined) {
    return Promise.resolve({ ok: false, error: 'no session selected' });
  }
  if (action === 'merge') {
    return manager.merge(id);
  }
  // 未コミットの変更ごと消す（force）。破棄・削除はどちらも確認ダイアログを通るので、
  // ここで git に拒否されて「y を押したのに何も起きない」状態にしない。
  return action === 'discard'
    ? manager.discard(id, { force: true })
    : manager.remove(id, { force: true });
}

/**
 * The confirmed lifecycle operations. `merge` / `discard` / `remove` act on the
 * selected session; `clear` is the only one that fans out (every finished session)
 * and therefore the only one that ignores `id`.
 */
export type LifecycleKind = 'merge' | 'discard' | 'remove' | 'clear';

export interface LifecycleAction {
  confirm: LifecycleKind | null;
  setConfirm: (confirm: LifecycleKind | null) => void;
  busy: boolean;
  actionError: string | undefined;
  setActionError: (error: string | undefined) => void;
  run: (action: LifecycleKind) => void;
}

/**
 * The merge/discard/remove/clear confirm → busy → run → error flow shared by both
 * views. `run` no-ops when a session-scoped action has no `id` (nothing selected).
 * `onDone(ok, action)` fires after completion so a view can react — the detail view
 * returns to its input panel, and goes back to the list when the session it was
 * showing is the one that was just removed.
 */
export function useLifecycleAction(
  manager: SessionManager,
  id: string | undefined,
  onDone?: (ok: boolean, action: LifecycleKind) => void,
): LifecycleAction {
  const [confirm, setConfirm] = useState<LifecycleKind | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | undefined>(undefined);
  const run = (action: LifecycleKind) => {
    if (id === undefined && action !== 'clear') {
      return;
    }
    setBusy(true);
    const promise = runLifecycle(manager, id, action);
    // 第 2 引数（reject ハンドラ）で受ける。`.catch()` を後段に付けると成功ハンドラ内の
    // 例外まで飲んでしまうため。manager 側は失敗を ActionResult に畳むが、その手前
    // （abort → 通知 → 購読者）で throw されると裸の then が unhandled rejection になる。
    promise.then(
      (result) => {
        setBusy(false);
        setConfirm(null);
        setActionError(result.ok ? undefined : result.error);
        onDone?.(result.ok, action);
      },
      (err: unknown) => {
        setBusy(false);
        setConfirm(null);
        setActionError(errorMessage(err));
      },
    );
  };
  return { confirm, setConfirm, busy, actionError, setActionError, run };
}
