import { clamp } from './math';
import type { DisplayLine, LogWindow } from './scroll';
import { caretIndexForColumn, charIndexAtColumn } from './text-buffer';
import type { RowSelection } from './text-selection';
import { linkAt } from './url';

/**
 * 詳細ビューのログ内の 1 点。**文書全体の表示行 index**（`row`）と、その行のテキスト内の
 * 文字オフセット（`col`）で表す。コンポーザの選択（`core/text-selection.ts`）が平坦な
 * caret index なのに対してこちらが「行 + 桁」なのは:
 *
 * 1. **スクロールで意味が変わらない**。行 index は文書に対する位置なので、ビューポート
 *    （`logWindow`）が動いても選択は同じ文字を指し続ける。これが「画面の上から下まで
 *    ドラッグしていくと自動スクロールしながら選択が伸びる」の土台。末尾への追記でも
 *    既存行の index はズレない。
 * 2. **描画コストが線形に収まる**。ログは数千行あり得るので、全行を 1 本の文字列に
 *    連結してから index を数えると 1 行の逆算ごとに O(全体) = 全体で O(n^2) になる。
 */
export interface LogPoint {
  readonly row: number;
  readonly col: number;
}

/**
 * 正規化済み（start ≤ end）のログ選択範囲。空選択（クリックだけ）は表さない
 * — `normalizeLogSelection` が undefined を返す。
 */
export interface LogRange {
  readonly start: LogPoint;
  readonly end: LogPoint;
}

/** 文書順の比較（負 = a が前、0 = 同じ、正 = a が後）。 */
export function compareLogPoints(a: LogPoint, b: LogPoint): number {
  return a.row !== b.row ? a.row - b.row : a.col - b.col;
}

/**
 * アンカー（ドラッグ開始点）と現在の終点から正規化した範囲を作る。同じ点なら undefined
 * （= 何も選択していない）を返すので、呼び出し側は「選択なし」を 1 ケースで扱える。
 */
export function normalizeLogSelection(anchor: LogPoint, focus: LogPoint): LogRange | undefined {
  const order = compareLogPoints(anchor, focus);
  if (order === 0) {
    return undefined;
  }
  return order < 0 ? { start: anchor, end: focus } : { start: focus, end: anchor };
}

/**
 * ログを描いている可視域の幾何。すべて詳細ビューが**実測した値**から組む（`useAbsolutePosition`
 * ＋ `useBoxHeight` ＋ 実際に描いた `logWindow` の結果）。当たり判定と描画で同じ値を通すのが
 * 要点で、片方だけ見積りに差し替えるとクリックが別の行に当たる。
 */
export interface LogViewport {
  /** 可視域の上端（Ink 出力原点からの絶対行）。 */
  readonly top: number;
  /** 可視域の左端（絶対列）。ログ行のテキストはここから始まる。 */
  readonly left: number;
  /** 可視域の高さ（行）。 */
  readonly height: number;
  /** 描いているウィンドウの先頭行の文書 index（`LogWindow.hiddenAbove`）。 */
  readonly firstRow: number;
  /**
   * 描いているログ行数。ストリーミングのプレビュー行・スクロール案内は**この可視域の
   * 外**（`core/scroll.ts` の `LogStatusRow`。ログ枠の下に常に 1 行）なので含まれない。
   */
  readonly rows: number;
}

/**
 * 実際に 1 行目が描かれる絶対行。ビューポートは `justifyContent="flex-end"` の末尾寄せ
 * なので、行数が高さに足りないぶんの隙間は**上**に空く（下端ではなく上端がズレる）。
 */
function contentTop(view: LogViewport): number {
  return view.top + Math.max(0, view.height - view.rows);
}

/** 画面上の `y` に描かれているログ行の文書 index（ログ行の外なら undefined）。 */
export function logRowAt(view: LogViewport, y: number): number | undefined {
  const offset = y - contentTop(view);
  if (offset < 0 || offset >= view.rows) {
    return undefined;
  }
  return view.firstRow + offset;
}

/**
 * マウス位置（絶対座標）に対応するログ内の 1 点。ログ行の上でなければ undefined。
 *
 * 桁は表示幅で逆算する（`caretIndexForColumn`。CJK / 絵文字は 2 セル）。行末より右は
 * 行末に丸める — ログ領域には他の当たり判定が無いので、短い行の右の余白から
 * ドラッグを始める普通の操作を「選択の開始」として受ける。
 */
export function logCaretAt(
  lines: readonly DisplayLine[],
  view: LogViewport,
  x: number,
  y: number,
): LogPoint | undefined {
  const row = logRowAt(view, y);
  if (row === undefined) {
    return undefined;
  }
  return { row, col: caretIndexForColumn(lines[row]?.text ?? '', x - view.left) };
}

/**
 * マウス位置にあるクリック可能な URL（無ければ undefined）。
 *
 * `logCaretAt` と違い**行末より右は当たりにしない**。選択のアンカーは「短い行の右の
 * 余白からドラッグを始める」ために行末へ丸めてよいが、リンクを丸めると URL で終わる
 * 行の右の余白をクリックしただけでブラウザが開いてしまう（意図しない副作用）。
 *
 * 桁の逆算は描画と同じ**グラフェム単位の表示幅**（`charIndexAtColumn`）で行い、得られた
 * index の文字が範囲に入っているかを見る。判定（行末か）と逆算を 1 回の走査でまとめて
 * やるのが要点 — 別々に測ると単位が食い違い、絵文字を含む行で端が 1 セルずれる
 * （`core/graphemes.ts`）。折り返しで URL が割れていても各行が URL 全体を指しているので、
 * どちらの行でも同じ先が返る。
 */
export function logLinkAt(
  lines: readonly DisplayLine[],
  view: LogViewport,
  x: number,
  y: number,
): string | undefined {
  const row = logRowAt(view, y);
  if (row === undefined) {
    return undefined;
  }
  const line = lines[row];
  if (!line?.links || line.links.length === 0) {
    return undefined;
  }
  // 行末より右・行の左外は当たりにしない（`charIndexAtColumn` が undefined を返す）。
  const index = charIndexAtColumn(line.text, x - view.left);
  return index === undefined ? undefined : linkAt(line.links, index);
}

/** ドラッグが可視域の外へ出た向き（自動スクロールの向き）。 */
export type LogEdge = 'up' | 'down';

/**
 * ドラッグ位置が可視域のどちら側へ出たか。ログ行の上なら undefined（通常の選択延長）。
 * 状態行（プレビュー / スクロール案内）・コンポーザ側（下端より下）はまとめて `'down'` に倒す。
 */
export function logEdgeAt(view: LogViewport, y: number): LogEdge | undefined {
  const top = contentTop(view);
  if (y < top) {
    return 'up';
  }
  return y >= top + view.rows ? 'down' : undefined;
}

/**
 * 自動スクロール中に選択の終点を置く場所 — 上へなら可視域の先頭行の行頭、下へなら
 * 末尾行の行末。スクロール後のウィンドウを渡すので、1 行スクロールするごとに
 * 「新しく現れた行まで選択済み」になる。
 */
export function logEdgePoint(win: LogWindow<DisplayLine>, edge: LogEdge): LogPoint {
  if (edge === 'up') {
    return { row: win.hiddenAbove, col: 0 };
  }
  const last = Math.max(0, win.entries.length - 1);
  return { row: win.hiddenAbove + last, col: win.entries[last]?.text.length ?? 0 };
}

/** 行 `row`（長さ `length`）のうち範囲に入る文字オフセット。行外・空なら空扱い。 */
function rowSlice(range: LogRange, row: number, length: number): RowSelection {
  const from = row === range.start.row ? clamp(range.start.col, 0, length) : 0;
  const to = row === range.end.row ? clamp(range.end.col, 0, length) : length;
  return { from, to };
}

/**
 * ハイライトを描くための、行 `row` 内の選択オフセット `[from, to)`。選択された文字が
 * 無い行（範囲外、または範囲に含まれる空行）は undefined。`length` はその行のテキスト長。
 */
export function logRowSelection(
  range: LogRange,
  row: number,
  length: number,
): RowSelection | undefined {
  if (row < range.start.row || row > range.end.row) {
    return undefined;
  }
  const slice = rowSlice(range, row, length);
  return slice.to > slice.from ? slice : undefined;
}

/**
 * 選択されたテキスト。行は `'\n'` で繋ぐので、**画面で見えているとおり**（折り返し位置が
 * 改行、継続行の字下げも含む）がクリップボードへ入る。
 */
export function logSelectionText(lines: readonly DisplayLine[], range: LogRange): string {
  const out: string[] = [];
  const last = Math.min(range.end.row, lines.length - 1);
  for (let row = Math.max(0, range.start.row); row <= last; row += 1) {
    const text = lines[row]?.text ?? '';
    const slice = rowSlice(range, row, text.length);
    out.push(text.slice(slice.from, slice.to));
  }
  return out.join('\n');
}

/**
 * 端でのドラッグ自動スクロールの間隔（ms）。1 tick = 1 行なので ≒20 行/秒。
 * 端末はボタン押下中の移動を「セルが変わったときだけ」報告する（?1002）ので、
 * 端で止めたままでもスクロールを続けるにはタイマーが必要になる。
 */
export const LOG_EDGE_SCROLL_MS = 50;
