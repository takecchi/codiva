import { clamp } from './math';
import { bufferLines } from './text-buffer';

/**
 * A normalized text selection over a buffer's `value`: a half-open range of
 * caret indices (UTF-16 units, the same unit as `TextBuffer.cursor`). `start` is
 * always ≤ `end`, so the anchor/focus order the user dragged in is irrelevant.
 * An empty range (start === end) is not represented — see `normalizeSelection`.
 */
export interface SelectionRange {
  readonly start: number;
  readonly end: number;
}

/**
 * Build a normalized selection from an anchor (where a drag began) and a focus
 * (where it is now / ended). Returns undefined when nothing is actually selected
 * (a plain click, or a drag that never left the anchor cell) so callers can treat
 * "no selection" as one case.
 */
export function normalizeSelection(anchor: number, focus: number): SelectionRange | undefined {
  const start = Math.min(anchor, focus);
  const end = Math.max(anchor, focus);
  return end > start ? { start, end } : undefined;
}

/** The selected substring of `value`. */
export function selectionText(value: string, range: SelectionRange): string {
  return value.slice(range.start, range.end);
}

/**
 * The char offsets `[from, to)` within line `row` (0-based, split on '\n') that
 * fall inside `range`, for painting a per-line highlight. Returns undefined when
 * the line has no selected characters (including a fully-selected empty line — a
 * blank line spanned by a multi-line selection has nothing visible to highlight).
 * Offsets are into that line's string, so the UI can `slice` it directly.
 */
export function lineSelection(
  value: string,
  range: SelectionRange,
  row: number,
): { from: number; to: number } | undefined {
  const lines = bufferLines(value);
  if (row < 0 || row >= lines.length) {
    return undefined;
  }
  // Absolute index of this line's first char in `value` (+1 per preceding '\n').
  let lineStart = 0;
  for (let i = 0; i < row; i += 1) {
    lineStart += (lines[i] ?? '').length + 1;
  }
  const lineLen = (lines[row] ?? '').length;
  const from = Math.max(0, Math.min(lineLen, range.start - lineStart));
  const to = Math.max(0, Math.min(lineLen, range.end - lineStart));
  return to > from ? { from, to } : undefined;
}

/** 選択ハイライトを描くために切り出した 1 片（元セグメントの一部）。 */
export interface SelectionSlice {
  /** 元セグメントの位置。呼び出し側がそこからスタイル（色・太字…）を引く。 */
  readonly index: number;
  /** そのセグメント内での開始オフセット。`index` と対で一意なので React キーに使える。 */
  readonly offset: number;
  readonly text: string;
  /** 選択範囲に入っている = 反転表示する片。 */
  readonly inverse: boolean;
}

/**
 * 横並びのセグメント列（ヘッダ 1 行の `BannerSegment`、ログ 1 行の `RichSpan` …）を、
 * 選択範囲の境界で切り分ける。ハイライトが**セグメントを跨いで**続く場合（ワードマーク行の
 * 「太字の名前 + dim のバージョン」など）でも 1 続きの反転として描けるようにするため。
 *
 * `sel` のオフセットはセグメントを連結した文字列に対する `[from, to)`（= `lineSelection` /
 * `logRowSelection` が返す値）。空文字になる片は落とすので、返る片はすべて非空。
 */
export function selectionSlices(
  segments: readonly string[],
  sel?: { from: number; to: number },
): SelectionSlice[] {
  const out: SelectionSlice[] = [];
  let start = 0;
  for (const [index, text] of segments.entries()) {
    const from = sel ? clamp(sel.from - start, 0, text.length) : 0;
    const to = sel ? clamp(sel.to - start, 0, text.length) : 0;
    const cuts: readonly [number, number, boolean][] =
      to > from
        ? [
            [0, from, false],
            [from, to, true],
            [to, text.length, false],
          ]
        : [[0, text.length, false]];
    for (const [a, b, inverse] of cuts) {
      if (b > a) {
        out.push({ index, offset: a, text: text.slice(a, b), inverse });
      }
    }
    start += text.length;
  }
  return out;
}
