import stringWidth from 'string-width';
import { clamp } from './math';

/**
 * A pure multi-line text buffer (value + caret index). All editing/movement is
 * expressed as pure functions here so the UI layer only maps keypresses to these
 * ops and renders the result — no editing logic lives in the components. Ops
 * return the *same* reference when nothing changes so callers can skip re-renders.
 */
export interface TextBuffer {
  readonly value: string;
  /** Caret index into `value`, in [0, value.length]. */
  readonly cursor: number;
}

/**
 * How many text rows the input may grow to before it scrolls internally
 * (Claude-Code-style: the composer grows upward, then keeps the caret in view).
 */
export const INPUT_MAX_ROWS = 8;

export function emptyBuffer(): TextBuffer {
  return { value: '', cursor: 0 };
}

/** Build a buffer from a string; the caret defaults to the end. */
export function bufferOf(value: string, cursor: number = value.length): TextBuffer {
  return { value, cursor: clamp(cursor, 0, value.length) };
}

export function isEmptyBuffer(buf: TextBuffer): boolean {
  return buf.value.length === 0;
}

/** Insert `str` at the caret and advance past it. */
export function insert(buf: TextBuffer, str: string): TextBuffer {
  if (str.length === 0) {
    return buf;
  }
  const value = buf.value.slice(0, buf.cursor) + str + buf.value.slice(buf.cursor);
  return { value, cursor: buf.cursor + str.length };
}

/** Insert a line break at the caret (Shift+Enter). */
export function newline(buf: TextBuffer): TextBuffer {
  return insert(buf, '\n');
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}
function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * How many UTF-16 units the caret should step over one *character*. Astral-plane
 * code points (emoji, U+10000+) are surrogate pairs of length 2; stepping by 1
 * would land the caret between the halves and corrupt the string on the next edit.
 * (charCodeAt out of range → NaN → comparisons false → step 1, safe at the ends.)
 */
function stepBack(value: string, i: number): number {
  return isLowSurrogate(value.charCodeAt(i - 1)) && isHighSurrogate(value.charCodeAt(i - 2))
    ? 2
    : 1;
}
function stepForward(value: string, i: number): number {
  return isHighSurrogate(value.charCodeAt(i)) && isLowSurrogate(value.charCodeAt(i + 1)) ? 2 : 1;
}

/** Delete the character before the caret (Backspace) — a whole surrogate pair. */
export function backspace(buf: TextBuffer): TextBuffer {
  if (buf.cursor === 0) {
    return buf;
  }
  const n = stepBack(buf.value, buf.cursor);
  const value = buf.value.slice(0, buf.cursor - n) + buf.value.slice(buf.cursor);
  return { value, cursor: buf.cursor - n };
}

export function moveLeft(buf: TextBuffer): TextBuffer {
  return buf.cursor === 0
    ? buf
    : { value: buf.value, cursor: buf.cursor - stepBack(buf.value, buf.cursor) };
}

export function moveRight(buf: TextBuffer): TextBuffer {
  return buf.cursor >= buf.value.length
    ? buf
    : { value: buf.value, cursor: buf.cursor + stepForward(buf.value, buf.cursor) };
}

/** Split a buffer value into its display lines (always ≥ 1 element). */
export function bufferLines(value: string): string[] {
  return value.split('\n');
}

/** The caret's (row, col) within the wrapped-at-newlines line grid. */
export function cursorRowCol(buf: TextBuffer): { row: number; col: number } {
  const before = buf.value.slice(0, buf.cursor).split('\n');
  const last = before[before.length - 1] ?? '';
  return { row: before.length - 1, col: last.length };
}

/** Caret index for a (row, col) position in the line grid; both are clamped. */
export function indexAtRowCol(value: string, row: number, col: number): number {
  const lines = value.split('\n');
  const r = clamp(row, 0, lines.length - 1);
  const c = clamp(col, 0, (lines[r] ?? '').length);
  let idx = 0;
  for (let i = 0; i < r; i += 1) {
    idx += (lines[i] ?? '').length + 1; // +1 for the '\n'
  }
  return idx + c;
}

/** Move the caret up one line, keeping the column; the first line goes to start. */
export function moveUp(buf: TextBuffer): TextBuffer {
  const { row, col } = cursorRowCol(buf);
  if (row === 0) {
    return buf.cursor === 0 ? buf : { value: buf.value, cursor: 0 };
  }
  return { value: buf.value, cursor: indexAtRowCol(buf.value, row - 1, col) };
}

/** Move the caret down one line, keeping the column; the last line goes to end. */
export function moveDown(buf: TextBuffer): TextBuffer {
  const { row, col } = cursorRowCol(buf);
  const last = buf.value.split('\n').length - 1;
  if (row === last) {
    return buf.cursor === buf.value.length ? buf : { value: buf.value, cursor: buf.value.length };
  }
  return { value: buf.value, cursor: indexAtRowCol(buf.value, row + 1, col) };
}

/**
 * Inverse of the caret-column math: the caret index (UTF-16 units) for a click at
 * `column` display cells from the start of `text`. A click anywhere on a wide
 * (2-cell) character places the caret before it; past the end goes to the end.
 * Display-width based (`string-width`) so CJK/emoji map correctly.
 */
export function caretIndexForColumn(text: string, column: number): number {
  if (column <= 0) {
    return 0;
  }
  let cells = 0;
  let index = 0;
  for (const ch of text) {
    const w = stringWidth(ch);
    if (cells + w > column) {
      return index;
    }
    cells += w;
    index += ch.length;
  }
  return text.length;
}

/**
 * Which line range to render so the caret stays visible within `maxRows` lines.
 * Anchors the caret near the bottom of the window (a growing composer), but never
 * scrolls a short buffer. Returns a half-open range [start, end).
 */
export function visibleLineRange(
  totalLines: number,
  cursorRow: number,
  maxRows: number,
): { start: number; end: number } {
  const cap = Math.max(1, maxRows);
  if (totalLines <= cap) {
    return { start: 0, end: totalLines };
  }
  const start = clamp(cursorRow - cap + 1, 0, totalLines - cap);
  return { start, end: start + cap };
}

/**
 * Caret index for a mouse click inside the (internally-scrolled) composer.
 * `contentRow` is the click's 0-based row within the visible window (i.e.
 * `y - contentTop`) and `cells` its display column within that line (`x` minus the
 * left edge and the caret-prefix width). Returns undefined when the click lands
 * outside the visible lines. Pure inverse of the composer's caret geometry — the
 * UI supplies only the pixel→cell offsets.
 */
export function caretIndexAtClick(
  buffer: TextBuffer,
  contentRow: number,
  cells: number,
  maxRows: number,
): number | undefined {
  const lines = bufferLines(buffer.value);
  const caret = cursorRowCol(buffer);
  const { start, end } = visibleLineRange(lines.length, caret.row, maxRows);
  const row = start + contentRow;
  if (contentRow < 0 || row >= end) {
    return undefined;
  }
  const line = lines[row] ?? '';
  return indexAtRowCol(buffer.value, row, caretIndexForColumn(line, cells));
}
