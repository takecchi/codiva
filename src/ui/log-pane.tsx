import { Box, type DOMElement, type Key, Text, useWindowSize } from 'ink';
import { type FC, type RefObject, useEffect, useMemo, useRef, useState } from 'react';
import {
  type AgentId,
  ARROW_SCROLL_LINES,
  type DisplayLine,
  isFullscreenViewport,
  LOG_EDGE_SCROLL_MS,
  type LogCollapse,
  type LogEdge,
  type LogEntry,
  type LogKind,
  type LogPoint,
  type LogRange,
  type LogStatusRow,
  type LogViewport,
  type LogWindow,
  logCaretAt,
  logEdgeAt,
  logEdgePoint,
  logGroupAt,
  logLines,
  logLinkAt,
  logRowSelection,
  logStatusRow,
  logWindow,
  type MouseEvent,
  type ScrollAnchor,
  scrollDown,
  scrollUp,
  streamLines,
  WHEEL_SCROLL_LINES,
} from '@/core';
import { useAbsolutePosition, useBoxHeight, useLogDragSelection } from './hooks';
import { BLANK_ROW, LOG_PREFIX, LogLine } from './log-line';
import { theme } from './theme';

/**
 * 既定の行 prefix。**モジュールレベルの固定参照**にしてあるのが要点 — `logLines` の
 * メモ化の依存に入るので、描画ごとに新しい関数を渡すと全エントリが毎フレーム
 * 再展開される（`core/scroll.ts` の LRU も毎回埋まる）。
 */
const DEFAULT_PREFIX = (kind: LogKind): string => LOG_PREFIX[kind];

export interface LogPaneOptions {
  /** 描くログ。undefined（セッションが無い等）は空として扱う。 */
  entries: readonly LogEntry[] | undefined;
  /**
   * ストリーミング中の本文。**ログの末尾の行として**下へ伸びる（追従／固定は
   * アンカーがそのまま担うので、追従の判定を UI に書かない）。渡さない画面
   * （サブエージェントのログ）では退化して 0 行になるだけ。
   */
  streamingText?: string;
  /** 行の折返し幅（呼び側が横パディングを引いて渡す）。 */
  width: number;
  /** 実測が入るまでの 1 フレームだけ使う見積り行数（画面ごとに chrome が違う）。 */
  fallbackRows: (rows: number) => number;
  /** 行 prefix の差し替え。**渡すなら参照を固定する**（useCallback / モジュール定数）。 */
  prefixFor?: (kind: LogKind) => string;
  /** エージェント切替の区切り行。同じく参照を固定して渡す。 */
  divider?: (agent: AgentId) => string;
  /**
   * 連続したツール実行を 1 行に畳む設定（`core/log-collapse.ts`）。undefined なら畳まない。
   * **開閉の state は view が持つ**（config 由来の一括切替 + 個別に開いてあるまとまり）ので、
   * ここは「今どう畳むか」を渡すだけ。同じく参照を固定して渡す（`logLines` のメモ化の依存）。
   */
  collapse?: LogCollapse;
  /**
   * まとめ行がクリックされた（`ToolRun.key`）。**press では呼ばれず release で呼ばれる**
   * （drag が来たら取り消す）ので、範囲選択のつもりの操作でログが組み変わらない。
   * 呼ばれる直前に {@link LogPane.beforeToggle} 相当の下ごしらえは済んでいる。
   */
  onToggleGroup?: (key: number) => void;
  onCopy?: (text: string) => void;
  /**
   * ログ内の URL をブラウザで開く。**press では開かず release で開く**（ドラッグに
   * なったら取り消す）ので、範囲選択のつもりの操作でブラウザが立ち上がらない。
   */
  onOpenUrl?: (url: string) => void;
}

export interface LogPane {
  /** 可視域の計測 Box（`<LogPane>` が付ける）。当たり判定の原点。 */
  ref: RefObject<DOMElement | null>;
  /** 展開済みの全表示行（確定ぶん + ストリーミングぶん）。 */
  lines: readonly DisplayLine[];
  /** 実際に描くウィンドウ。当たり判定と描画で**同じもの**を使う。 */
  win: LogWindow<DisplayLine>;
  /** ログ直下に**常に 1 行**描く状態行の中身。 */
  status: LogStatusRow;
  /** 描ける行数 = スクロール1回の移動量の基準 = アンカーの下限。 */
  cap: number;
  /** 可視域の幾何。実測前・インライン描画時は undefined =「当たり判定をやめる」。 */
  view: LogViewport | undefined;
  anchor: ScrollAnchor;
  setAnchor: (next: ScrollAnchor) => void;
  /** 末尾へ戻す（送信直後・中断直後など、結果が出る場所へ視界を移す）。 */
  toBottom: () => void;
  selection: LogRange | undefined;
  /**
   * マウスレポートを処理する（扱ったら true）。**裁定順は view が持つ** — 詳細ビューは
   * コンポーザを先に試し、扱われなかったぶんだけここへ落とす（`useComposer.handleMouse`
   * と同じ契約）。
   */
  handleMouse: (mouse: MouseEvent) => boolean;
  /** ↑↓ / PgUp / PgDn を処理する（扱ったら true）。どのキーを渡すかは view が決める。 */
  handleScrollKey: (key: Key) => boolean;
  /** 選択を捨てる（端の自動スクロールも止める）。 */
  clearSelection: () => void;
  /** URL / まとめ行の開閉の保留を取り消す（コンポーザが press を取ったとき等）。 */
  clearPendingLink: () => void;
  /**
   * ログが組み変わる操作（まとめ行の一括開閉 = `Ctrl+O` / `/tools`）の前に呼ぶ。
   * 末尾追従のままだと展開して増えたぶんが下に伸びて**押した見出しが画面の上へ流れる**
   * ので、今の窓の終端でアンカーを固定する。選択は行 index が基準なので捨てる。
   */
  beforeToggle: () => void;
}

/**
 * 会話ログのビューポート 1 面ぶんの機械（実測・スクロール・範囲選択・URL クリック・端の
 * 自動スクロール）。セッション詳細とサブエージェント詳細の**両方**がこれを使うので、
 * 「触っていない行がコピーされる」「行が虫食いで落ちる」といった過去の不具合が
 * 片方の画面だけで再発しない。
 *
 * `useInput` は**持たない**（1 画面 1 `useInput` は view のまま）。view の単一ハンドラから
 * {@link LogPane.handleMouse} / {@link LogPane.handleScrollKey} を呼ぶ。
 */
export function useLogPane(o: LogPaneOptions): LogPane {
  const { entries, streamingText, width, fallbackRows, divider, collapse, onCopy, onOpenUrl } = o;
  const { onToggleGroup } = o;
  const prefixFor = o.prefixFor ?? DEFAULT_PREFIX;
  const { rows, columns } = useWindowSize();
  // ログの範囲選択。コンポーザとは別インスタンス（位置の基準が「文書の行 + 桁」で違う）。
  const logSel = useLogDragSelection(onCopy);
  // ドラッグが可視域の外へ出ている向き。ここにあるあいだ自動スクロールし続ける。
  const [edge, setEdge] = useState<LogEdge | undefined>(undefined);
  /**
   * press した位置にあった URL。**離すまで開かない**ための保留で、途中で drag が
   * 来たら取り消す。state ではなく ref なのは、同一 tick に複数のマウスレポートが
   * まとまって届いても順に読めるようにするため。
   */
  const pendingLinkRef = useRef<string | undefined>(undefined);
  /**
   * press した位置にあったツール実行まとめ行の key。URL とまったく同じ理由で
   * **離すまで開閉しない**（範囲選択のつもりのドラッグでログが組み変わらないように）。
   * まとめ行に URL は載らないので、この 2 つが同時に立つことはない。
   */
  const pendingGroupRef = useRef<number | undefined>(undefined);
  // ログ表示域の実測高さ。ここに描く行数の上限であり、スクロール1回の移動量の基準
  // でもある。見積りより実測を優先するのは、可視域より多く描くと Yoga が溢れた行を
  // 「上でクリップ」せず「縮小」してしまい、途中の行が虫食いで欠落するため。
  const ref = useRef<DOMElement>(null);
  const measuredRows = useBoxHeight(ref);
  // 可視域の絶対位置（マウス当たり判定の原点）。
  const box = useAbsolutePosition(ref);
  const [anchor, setAnchorState] = useState<ScrollAnchor>('bottom');
  // スクロール位置は ref にも持つ。理由は**同期的に読む必要がある**こと: 自動スクロールの
  // 1 tick は「次のアンカー」から選択の終点（`logEdgePoint`）を組み、さらに「動かなかったか」で
  // タイマーを止める判定をするので、setState の関数形（次の描画まで値が見えない）では書けない。
  const anchorRef = useRef<ScrollAnchor>('bottom');
  const setAnchor = (next: ScrollAnchor) => {
    anchorRef.current = next;
    setAnchorState(next);
  };

  const fullscreen = isFullscreenViewport(rows);
  // 全画面時は実測した可視高さに収める（実測が入るまでの1フレームだけ見積りで代用）。
  // インライン描画時はクリップされず端末スクロールに任せるため実測は使わず、
  // 再描画コストの上限として端末 rows を使う。
  // **スクロール位置にもストリーミングにも依存しない**のが要点: ここを可変にすると
  // 見えているログ全体が 1 行跳ねる（= ガクガクする）。
  const cap = fullscreen
    ? Math.max(1, Math.floor(measuredRows ?? fallbackRows(rows)))
    : Math.max(1, rows);

  const entryRows = useMemo<DisplayLine[]>(
    () => (entries ? logLines(entries, width, prefixFor, divider, collapse) : []),
    [entries, width, prefixFor, divider, collapse],
  );
  // ストリーミング中の本文は Markdown 整形とリンク検出をしない（途中テキストを整形すると
  // 毎デルタで全行の折り返しが変わり Ink のキャッシュが膨れる。`streamLines` の注記）。
  const streamRows = useMemo<DisplayLine[]>(
    () => (streamingText ? streamLines(streamingText, width, LOG_PREFIX.assistant_text, cap) : []),
    [streamingText, width, cap],
  );
  const lines = useMemo<DisplayLine[]>(
    () => (streamRows.length === 0 ? entryRows : [...entryRows, ...streamRows]),
    [entryRows, streamRows],
  );
  const total = lines.length;
  const win = logWindow(lines, cap, anchor);
  const status = logStatusRow(win);
  /**
   * ログ可視域の幾何。すべて描画に使った実測値・同じウィンドウから組むので、クリック位置の
   * 逆算が別の行に当たらない。実測前とインライン描画時（低い端末＝マウス捕捉もしない）は
   * undefined にして、当たり判定そのものをやめる（黙って別の行を選ぶより選べないほうがよい）。
   */
  const view: LogViewport | undefined =
    box && measuredRows !== undefined && fullscreen
      ? {
          top: box.top,
          left: box.left,
          height: Math.max(1, Math.floor(measuredRows)),
          firstRow: win.hiddenAbove,
          rows: win.entries.length,
        }
      : undefined;

  /** ログの選択を捨てる（端の自動スクロールも止める）。 */
  const clearSelection = () => {
    logSel.clear();
    setEdge(undefined);
  };

  /**
   * まとめ行を開閉する前に、見えている場所を動かさないための下ごしらえ。
   *
   * 末尾追従（`'bottom'`）のままだと、展開して増えたぶんが下に伸びて**押した見出しが
   * 画面の上へ流れていく**（何を開いたのか見失う）。今の窓の終端で固定すれば、
   * 見出しより前の行数は開閉で変わらないので見出しは同じ位置に留まる。
   * 選択は行 index が基準なので、組み変わる前に捨てる。
   */
  const beforeToggle = () => {
    if (anchorRef.current === 'bottom') {
      setAnchor(win.hiddenAbove + cap);
    }
    clearSelection();
  };

  /**
   * 端でのドラッグ 1 tick: 1 行スクロールし、選択の終点を**スクロール後の**端の行へ伸ばす。
   * これで新しく現れた行がそのまま選択に入り、「画面の上端／下端までドラッグすると、
   * そのままスクロールしながら選択が続く」になる。
   */
  const edgeStep = (dir: LogEdge) => {
    const current = anchorRef.current;
    const next =
      dir === 'up'
        ? scrollUp(current, total, cap, ARROW_SCROLL_LINES)
        : scrollDown(current, total, cap, ARROW_SCROLL_LINES);
    setAnchor(next);
    // 終点は**次に描かれる**ウィンドウの端の行。行数（`cap`）はスクロール位置に
    // 依存しないので、そのまま次のアンカーで数え直せばよい。
    logSel.extend(logEdgePoint(logWindow(lines, cap, next), dir));
    if (next === current) {
      // 文書の端まで来た（もう動かない）: タイマーを止める。release のレポートを取り逃した
      // ときに永久にスクロールし続けないための保険にもなっている。
      setEdge(undefined);
    }
  };

  // 端で押さえたまま静止していてもスクロールを続けるためのタイマー。SGR ?1002 は
  // **セルが変わったときだけ**移動を報告するので、レポート駆動だけでは端で止まってしまう。
  // 最新の edgeStep は ref 経由で渡し、タイマーは向きが変わったときだけ張り替える
  // （ログの追記や再描画ごとにタイマーを作り直すと 1 tick も進まないことがある）。
  const edgeStepRef = useRef(edgeStep);
  useEffect(() => {
    edgeStepRef.current = edgeStep;
  });
  useEffect(() => {
    if (!edge) {
      return undefined;
    }
    const timer = setInterval(() => edgeStepRef.current(edge), LOG_EDGE_SCROLL_MS);
    return () => clearInterval(timer);
  }, [edge]);

  // 端末幅が変わるとログを再折り返すため、行 index の指す文字が変わる。ズレた位置を
  // 光らせ続けない（deps を付けられないのは logSel の参照が毎描画で変わるため）。
  // ログが上限に達して**古いエントリが落ちた**ときも同じ理由で捨てる（選択は文書先頭
  // からの表示行 index なので、先頭が消えると別の行を指す = 触っていない行がコピーされる）。
  const widthRef = useRef(columns);
  const firstSeqRef = useRef(entries?.[0]?.seq);
  // ストリーミング中の行（= 確定行より後ろ）に掛かった選択の番人。行 index は文書に対する
  // 位置なので、ライブ領域の行が入れ替わると同じ index が別の文字を指す（触っていない行が
  // コピーされる）。3 つの手掛かりで検知する — 詳細は下の effect のコメント。
  const live = {
    entries: entryRows.length,
    rows: streamRows.length,
    head: streamRows[0]?.key,
  };
  const liveRef = useRef(live);
  useEffect(() => {
    const firstSeq = entries?.[0]?.seq;
    if (widthRef.current !== columns || firstSeqRef.current !== firstSeq) {
      widthRef.current = columns;
      firstSeqRef.current = firstSeq;
      liveRef.current = live;
      clearSelection();
      return;
    }
    const prev = liveRef.current;
    // 末尾に**足されただけ**（行数が増えただけ）なら既存行の index はズレないので何もしない
    // — ここで捨てると、流れている本文をドラッグしている最中に毎デルタ選択が消える。
    // 崩れるのは 3 つ: 確定行が増えた（ライブ領域全体が下へずれる）/ 先頭行が変わった
    // （cap で画面外へ押し出された）/ 行数が減った（`clipStreamText` が頭を落とした）。
    const shifted =
      prev.entries !== live.entries || prev.head !== live.head || live.rows < prev.rows;
    if (!shifted) {
      liveRef.current = live;
      return;
    }
    // ライブ領域は「これまでの確定行数」から下。そこに掛かっている選択だけ捨てる。
    // **まだ範囲になっていないドラッグ（アンカーだけ）も見る** — press した時点では
    // 選択がまだ無いので、見ないとドラッグ中に確定したときアンカーだけが古い行を指したまま
    // 残り、離した瞬間に触っていない行がコピーされる。
    const reach = Math.max(logSel.anchor()?.row ?? -1, logSel.selection?.end.row ?? -1);
    const touchesLive = reach >= prev.entries;
    liveRef.current = live;
    if (touchesLive) {
      clearSelection();
    }
  });

  /**
   * 選択のアンカー（press）。行の上ならその文字、**行より上の余白**（ログが可視域に
   * 満たないときの末尾寄せの隙間・上パディング）なら先頭行の行頭にする — 「画面のいちばん
   * 上から下へ」というドラッグを受けたいので、ここでクリックを捨てない。行より下
   * （状態行・操作パネル側）は当たりにしない（ログ以外の要素があるので黙って食わない）。
   */
  const anchorAt = (x: number, y: number): LogPoint | undefined => {
    if (!view) {
      return undefined;
    }
    const point = logCaretAt(lines, view, x, y);
    if (point) {
      return point;
    }
    return logEdgeAt(view, y) === 'up' ? logEdgePoint(win, 'up') : undefined;
  };

  /**
   * ログ上のドラッグ。可視域の外へ出たらその向きへ自動スクロールしながら選択を伸ばし
   * （`edgeStep` + タイマー）、内側なら指している文字まで終点を動かす。
   */
  const handleDrag = (x: number, y: number) => {
    if (!view) {
      return;
    }
    const dir = logEdgeAt(view, y);
    if (dir) {
      setEdge(dir);
      edgeStep(dir); // レポートが来た時点で 1 行進めておく（タイマーを待たない）
      return;
    }
    setEdge(undefined);
    const point = logCaretAt(lines, view, x, y);
    if (point) {
      logSel.extend(point);
    }
  };

  const handleMouse = (mouse: MouseEvent): boolean => {
    if (mouse.kind === 'wheel') {
      setAnchor(
        mouse.dir === 'up'
          ? scrollUp(anchorRef.current, total, cap, WHEEL_SCROLL_LINES)
          : scrollDown(anchorRef.current, total, cap, WHEEL_SCROLL_LINES),
      );
      return true;
    }
    if (mouse.kind === 'press') {
      setEdge(undefined);
      // URL の上で押したら「離すまでドラッグしなければ開く」候補として覚える。
      // 押した時点では開かない — ドラッグで範囲選択を始めた場合に開いてしまう。
      // **左ボタンだけ**: 右クリック（端末のコンテキストメニューを期待した操作）や
      // 中クリック（貼り付け）でブラウザを開くのは意図しない副作用になる。
      pendingLinkRef.current =
        view && mouse.button === 'left' ? logLinkAt(lines, view, mouse.x, mouse.y) : undefined;
      // ツール実行のまとめ行も同じ扱い（押した時点では開閉しない）。
      pendingGroupRef.current =
        view && mouse.button === 'left' ? logGroupAt(lines, view, mouse.y) : undefined;
      const point = anchorAt(mouse.x, mouse.y);
      if (point) {
        logSel.begin(point);
      } else {
        logSel.clear();
      }
      return true;
    }
    if (mouse.kind === 'drag') {
      // ドラッグになった = 範囲選択なので、リンクを開く / 開閉する候補は取り消す。
      pendingLinkRef.current = undefined;
      pendingGroupRef.current = undefined;
      if (logSel.dragging()) {
        handleDrag(mouse.x, mouse.y);
      }
      return true;
    }
    // 離した時点で 1 回だけコピー（ドラッグごとに送らない）。ハイライトは残す。
    logSel.end(lines);
    setEdge(undefined);
    // ドラッグにならずに URL の上で離した = 単なるクリック → ブラウザで開く。
    const url = pendingLinkRef.current;
    pendingLinkRef.current = undefined;
    if (url !== undefined && onOpenUrl) {
      onOpenUrl(url);
    }
    // 同じくまとめ行の上で離した = 単なるクリック → 開閉する。
    const group = pendingGroupRef.current;
    pendingGroupRef.current = undefined;
    if (group !== undefined && onToggleGroup) {
      beforeToggle();
      onToggleGroup(group);
    }
    return true;
  };

  const handleScrollKey = (key: Key): boolean => {
    // The step is derived from the *visible* log height, not the full terminal,
    // so a page never jumps past unseen lines.
    if (key.pageUp) {
      setAnchor(scrollUp(anchorRef.current, total, cap));
      return true;
    }
    if (key.pageDown) {
      setAnchor(scrollDown(anchorRef.current, total, cap));
      return true;
    }
    if (key.upArrow || key.downArrow) {
      setAnchor(
        key.upArrow
          ? scrollUp(anchorRef.current, total, cap, ARROW_SCROLL_LINES)
          : scrollDown(anchorRef.current, total, cap, ARROW_SCROLL_LINES),
      );
      return true;
    }
    return false;
  };

  return {
    ref,
    lines,
    win,
    status,
    cap,
    view,
    anchor,
    setAnchor,
    toBottom: () => setAnchor('bottom'),
    selection: logSel.selection,
    handleMouse,
    handleScrollKey,
    clearSelection,
    clearPendingLink: () => {
      pendingLinkRef.current = undefined;
      pendingGroupRef.current = undefined;
    },
    beforeToggle,
  };
}

/**
 * 会話ログの描画（末尾ビューポート + ログ直下の状態行）。`<Static>` は使わない
 * （スクロールバック側に書くため全画面レイアウトでは画面外へ消える）。
 *
 * 状態行を**この中に含める**のが要点: あれは「ログの高さを状態で変えない」ための
 * 常時 1 行なので、ログ本体と離すと片方の画面で条件付きに戻されうる。
 */
export const LogPane: FC<{
  pane: LogPane;
  /** 過去ログを見ているときの案内（`m.detail.scrollHint`）。 */
  statusHint: (hiddenBelow: number) => string;
}> = ({ pane, statusHint }) => (
  <>
    {/*
     * flexGrow で残りを占め、justifyContent="flex-end" + overflowY="hidden" で
     * 「最新行が下端、溢れた古い行は上へクリップ」にする。
     */}
    <Box
      ref={pane.ref}
      flexDirection="column"
      flexGrow={1}
      overflowY="hidden"
      justifyContent="flex-end"
    >
      {/*
       * 行の入れ物は flexShrink={0} が必須。Ink/Yoga は溢れた子を「クリップ」せず
       * 「縮小」するため、これが無いと可視域より1行でも多く描いた瞬間にログの途中の
       * 行が虫食いで落ちる（上へスクロールしても読めなくなる）。縮小させなければ
       * flex-end の溢れは上端で正しくクリップされる。行数自体は logWindow が
       * 実測した可視高さに収めている（二重の保険）。
       */}
      <Box flexDirection="column" flexShrink={0}>
        {/* 選択のハイライトは**文書の行 index**で引く（win.hiddenAbove + 表示位置）。
            スクロールしても同じ文字が光り続けるのがこのビューの選択の要件。 */}
        {pane.win.entries.map((line, i) => (
          <LogLine
            key={line.key}
            line={line}
            sel={
              pane.selection
                ? logRowSelection(pane.selection, pane.win.hiddenAbove + i, line.text.length)
                : undefined
            }
          />
        ))}
      </Box>
    </Box>

    {/*
     * ログ直下の状態行。**常に 1 行**を占める（中身が無いときは空行）。ここを
     * 条件付きで出し入れすると、その上のログビューポートの高さが 1 行変わって
     * 見えているログ全体が跳ねる（= スクロールがガクガクする）。詳細は
     * `core/scroll.ts` の `LogStatusRow`。この行が下のブロックとの余白も兼ねるので、
     * 呼び側は `marginTop` を付けない（付けると空行が 2 行並ぶ）。
     */}
    <Box flexShrink={0}>
      {pane.status.kind === 'scrollback' ? (
        <Text color={theme.warn} dimColor wrap="truncate-end">
          {statusHint(pane.status.hiddenBelow)}
        </Text>
      ) : (
        <Text>{BLANK_ROW}</Text>
      )}
    </Box>
  </>
);
