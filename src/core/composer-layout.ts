import stringWidth from 'string-width';
import { clamp } from './math';
import { bufferLines, caretIndexForColumn, type TextBuffer, visibleLineRange } from './text-buffer';
import type { SelectionRange } from './text-selection';

/**
 * Display geometry of the composer: how a buffer's text is laid out as *display
 * rows* once it is soft-wrapped at the input's width.
 *
 * The composer used to draw one row per logical line and truncate the overflow, so
 * typing past the right edge hid the text (and the caret) behind a `…`. Wrapping is
 * the fix, but it means "row" is no longer "line": every caret/click/selection
 * calculation has to go through the same wrap. Keeping that in one pure module lets
 * the renderer (`ui/prompt-input.tsx`), mouse hit-testing and vertical caret
 * movement share exactly one geometry — if they disagreed, clicks would land on the
 * wrong character.
 *
 * Rows partition the buffer exactly: concatenating every row's `text` with a '\n'
 * between logical lines reproduces `value`, so every position is an index into
 * `value` (the same unit as `TextBuffer.cursor` and `SelectionRange`).
 */
export interface ComposerRow {
  /** The row's text (a slice of the buffer value; never contains '\n'). */
  readonly text: string;
  /** Index in the buffer value where this row's text starts. */
  readonly start: number;
  /** Index in the buffer value just past this row's text (exclusive). */
  readonly end: number;
  /** True when this row continues a soft-wrapped logical line. */
  readonly continuation: boolean;
}

/**
 * Display width (cells) of the `❯ ` / `  ` prefix `PromptInput` draws before every
 * composer row. Callers that map a mouse x to a text column subtract it, and the
 * wrap width is the box width minus it.
 */
export const COMPOSER_PREFIX_CELLS = 2;

/**
 * An unusable width (undefined before the box is measured, non-finite, or < 1)
 * means "don't wrap" — one row per logical line, exactly the pre-wrap behavior.
 */
function normalizeWidth(width?: number): number | undefined {
  return width === undefined || !Number.isFinite(width)
    ? undefined
    : Math.max(1, Math.floor(width));
}

/** The whole code point at `i` (astral chars are surrogate pairs, never split). */
function charAt(text: string, i: number): string {
  const cp = text.codePointAt(i);
  return cp === undefined ? '' : String.fromCodePoint(cp);
}

/**
 * Break one logical line into half-open `[from, to)` index pairs, each fitting in
 * `cap` display cells. Greedy, and prefers the last space over cutting mid-word;
 * the space stays at the end of its row so the segments still partition the line
 * (all caret math is index-based). A single char wider than `cap` still gets its own
 * row — progress is guaranteed so this can't loop forever.
 */
function wrapLine(line: string, cap: number): { from: number; to: number }[] {
  const segments: { from: number; to: number }[] = [];
  let from = 0;
  for (;;) {
    let cells = 0;
    let i = from;
    let lastSpace = -1; // index just past the last space that fit on this row
    while (i < line.length) {
      const ch = charAt(line, i);
      const w = stringWidth(ch);
      if (cells + w > cap) {
        break;
      }
      cells += w;
      i += ch.length;
      if (ch === ' ') {
        lastSpace = i;
      }
    }
    if (i >= line.length) {
      segments.push({ from, to: line.length });
      return segments;
    }
    let to = lastSpace > from && charAt(line, i) !== ' ' ? lastSpace : i;
    if (to <= from) {
      to = from + charAt(line, from).length;
    }
    segments.push({ from, to });
    from = to;
    if (from >= line.length) {
      return segments;
    }
  }
}

/**
 * Soft-wrap a buffer value into display rows at `width` cells. Omit `width` (or
 * pass a non-finite one) to keep one row per logical line. Always returns ≥ 1 row
 * (an empty value is one empty row).
 */
export function wrapComposerRows(value: string, width?: number): ComposerRow[] {
  const cap = normalizeWidth(width);
  const rows: ComposerRow[] = [];
  let offset = 0;
  for (const line of bufferLines(value)) {
    if (cap === undefined) {
      rows.push({ text: line, start: offset, end: offset + line.length, continuation: false });
    } else {
      for (const seg of wrapLine(line, cap)) {
        rows.push({
          text: line.slice(seg.from, seg.to),
          start: offset + seg.from,
          end: offset + seg.to,
          continuation: seg.from > 0,
        });
      }
    }
    offset += line.length + 1; // the '\n' that ended this line
  }
  return rows;
}

/** How many display rows a buffer value occupies at `width` cells. */
export function composerRowCount(value: string, width?: number): number {
  return wrapComposerRows(value, width).length;
}

export interface ComposerLayout {
  readonly rows: readonly ComposerRow[];
  /** The caret's display row and its char offset within that row's `text`. */
  readonly caret: { readonly row: number; readonly col: number };
}

/**
 * Wrap the buffer and locate the caret in the resulting rows.
 *
 * At a wrap boundary the caret index belongs to two rows (the end of one, the start
 * of the next); it is placed on the *later* one, which is where the next character
 * will actually appear. When a row is completely full and nothing continues it (end
 * of the buffer, or of a logical line), a synthetic empty row is opened for the
 * caret — the way a terminal wraps its cursor — instead of drawing it one cell
 * outside the visible width.
 */
export function composerLayout(buffer: TextBuffer, width?: number): ComposerLayout {
  const cap = normalizeWidth(width);
  const rows = wrapComposerRows(buffer.value, width);
  const cursor = clamp(buffer.cursor, 0, buffer.value.length);
  let row = 0;
  for (let i = 0; i < rows.length; i += 1) {
    const r = rows[i];
    if (r && cursor >= r.start && cursor <= r.end) {
      row = i; // last match wins — see the boundary rule above
    }
  }
  const current = rows[row];
  if (
    cap !== undefined &&
    current &&
    cursor === current.end &&
    stringWidth(current.text) >= cap &&
    rows[row + 1]?.continuation !== true
  ) {
    rows.splice(row + 1, 0, { text: '', start: cursor, end: cursor, continuation: true });
    return { rows, caret: { row: row + 1, col: 0 } };
  }
  return { rows, caret: { row, col: cursor - (current?.start ?? 0) } };
}

/**
 * Caret index for a mouse click inside the (internally-scrolled) composer.
 * `contentRow` is the click's 0-based display row within the visible window (i.e.
 * `y - contentTop`) and `cells` its display column within that row (`x` minus the
 * left edge and {@link COMPOSER_PREFIX_CELLS}). Returns undefined when the click
 * lands outside the visible rows. Pure inverse of the composer's geometry — the UI
 * supplies only the pixel→cell offsets and the wrap width it rendered with.
 */
export function caretIndexAtClick(
  buffer: TextBuffer,
  contentRow: number,
  cells: number,
  maxRows: number,
  width?: number,
): number | undefined {
  const { rows, caret } = composerLayout(buffer, width);
  const { start, end } = visibleLineRange(rows.length, caret.row, maxRows);
  const index = start + contentRow;
  if (contentRow < 0 || index >= end) {
    return undefined;
  }
  const row = rows[index];
  return row ? row.start + caretIndexForColumn(row.text, cells) : undefined;
}

/**
 * The char offsets `[from, to)` within one display row that fall inside `range`,
 * for painting a per-row highlight. Undefined when the row has nothing selected.
 */
export function rowSelection(
  range: SelectionRange,
  row: ComposerRow,
): { from: number; to: number } | undefined {
  const len = row.text.length;
  const from = clamp(range.start - row.start, 0, len);
  const to = clamp(range.end - row.start, 0, len);
  return to > from ? { from, to } : undefined;
}

/** Display cells before the caret on its own row (CJK/emoji count as 2). */
function caretCells(layout: ComposerLayout): number {
  const row = layout.rows[layout.caret.row];
  return stringWidth((row?.text ?? '').slice(0, layout.caret.col));
}

/**
 * Move the caret one *display* row up, keeping its column (in cells, so CJK lines
 * up). Above the first row the caret goes to the start of the buffer — the same
 * end-stop as the logical `moveUp`. Wrapping makes this the movement the user sees:
 * a long line is several rows, and a logical `moveUp` would jump over all of them.
 * Returns the same reference when nothing changes.
 */
export function moveRowUp(buffer: TextBuffer, width?: number): TextBuffer {
  const layout = composerLayout(buffer, width);
  const target = layout.rows[layout.caret.row - 1];
  if (!target) {
    return buffer.cursor === 0 ? buffer : { value: buffer.value, cursor: 0 };
  }
  const cursor = target.start + caretIndexForColumn(target.text, caretCells(layout));
  return cursor === buffer.cursor ? buffer : { value: buffer.value, cursor };
}

/**
 * キャレットが最上段の表示行にあるか。↑ を「キャレット移動」ではなく「入力履歴の
 * 呼び出し」に使ってよい位置か、の判定に使う（shell と同じで、行の途中では移動を
 * 優先し、端でさらに押したときだけ履歴へ回す）。行は折り返し後の**表示行**で数える
 * ので、長い1行の途中で履歴に化けることはない。
 */
export function atFirstComposerRow(buffer: TextBuffer, width?: number): boolean {
  return composerLayout(buffer, width).caret.row === 0;
}

/** 同じく最下段の表示行にあるか（↓ = 新しい履歴へ / 書きかけへ復帰）。 */
export function atLastComposerRow(buffer: TextBuffer, width?: number): boolean {
  const layout = composerLayout(buffer, width);
  return layout.caret.row === layout.rows.length - 1;
}

/** Move the caret one display row down; past the last row it goes to the end. */
export function moveRowDown(buffer: TextBuffer, width?: number): TextBuffer {
  const layout = composerLayout(buffer, width);
  const target = layout.rows[layout.caret.row + 1];
  if (!target) {
    return buffer.cursor === buffer.value.length
      ? buffer
      : { value: buffer.value, cursor: buffer.value.length };
  }
  const cursor = target.start + caretIndexForColumn(target.text, caretCells(layout));
  return cursor === buffer.cursor ? buffer : { value: buffer.value, cursor };
}
