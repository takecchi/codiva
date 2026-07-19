import { describe, expect, it } from 'vitest';
import {
  backspace,
  bufferLines,
  bufferOf,
  caretIndexAtClick,
  caretIndexForColumn,
  cursorRowCol,
  emptyBuffer,
  indexAtRowCol,
  insert,
  isEmptyBuffer,
  moveDown,
  moveLeft,
  moveRight,
  moveUp,
  newline,
  visibleLineRange,
} from './text-buffer';

describe('text-buffer editing', () => {
  it('starts empty', () => {
    const b = emptyBuffer();
    expect(b.value).toBe('');
    expect(b.cursor).toBe(0);
    expect(isEmptyBuffer(b)).toBe(true);
  });

  it('inserts at the caret and advances', () => {
    let b = emptyBuffer();
    b = insert(b, 'ab');
    b = moveLeft(b); // caret between a and b
    b = insert(b, 'X');
    expect(b.value).toBe('aXb');
    expect(b.cursor).toBe(2);
  });

  it('insert of empty string is a no-op (same reference)', () => {
    const b = bufferOf('hi');
    expect(insert(b, '')).toBe(b);
  });

  it('backspace deletes the char before the caret', () => {
    let b = bufferOf('abc', 2); // between b and c
    b = backspace(b);
    expect(b.value).toBe('ac');
    expect(b.cursor).toBe(1);
  });

  it('backspace at start is a no-op (same reference)', () => {
    const b = bufferOf('abc', 0);
    expect(backspace(b)).toBe(b);
  });

  it('newline inserts a line break at the caret', () => {
    let b = bufferOf('ab', 1);
    b = newline(b);
    expect(b.value).toBe('a\nb');
    expect(cursorRowCol(b)).toEqual({ row: 1, col: 0 });
  });

  it('bufferOf clamps the caret into range', () => {
    expect(bufferOf('abc', 99).cursor).toBe(3);
    expect(bufferOf('abc', -5).cursor).toBe(0);
  });
});

describe('text-buffer caret movement', () => {
  it('moveLeft/moveRight clamp at the ends (same reference)', () => {
    const start = bufferOf('ab', 0);
    expect(moveLeft(start)).toBe(start);
    const end = bufferOf('ab', 2);
    expect(moveRight(end)).toBe(end);
    expect(moveRight(start).cursor).toBe(1);
    expect(moveLeft(end).cursor).toBe(1);
  });

  it('computes row/col across newlines', () => {
    // 'ab\ncde\nf' indices: a0 b1 \n2 c3 d4 e5 \n6 f7 (length 8)
    expect(cursorRowCol(bufferOf('ab\ncde\nf', 5))).toEqual({ row: 1, col: 2 }); // 'cd'|e
    expect(cursorRowCol(bufferOf('ab\ncde\nf', 7))).toEqual({ row: 2, col: 0 }); // |f
    expect(cursorRowCol(bufferOf('ab\ncde\nf', 8))).toEqual({ row: 2, col: 1 }); // f|
  });

  it('moveUp keeps the column, first line jumps to start', () => {
    const b = bufferOf('abcd\nefgh', 7); // row1 col2 (e f|g h)
    const up = moveUp(b);
    expect(cursorRowCol(up)).toEqual({ row: 0, col: 2 });
    const top = moveUp(up); // row0 → jumps to buffer start
    expect(top.cursor).toBe(0);
  });

  it('moveDown keeps the column, last line jumps to end', () => {
    const b = bufferOf('abcd\nef', 2); // row0 col2
    const down = moveDown(b);
    expect(cursorRowCol(down)).toEqual({ row: 1, col: 2 }); // clamped to line length (2)
    const bottom = moveDown(down); // last row → jumps to end
    expect(bottom.cursor).toBe('abcd\nef'.length);
  });

  it('moveDown clamps the column to a shorter target line', () => {
    const b = bufferOf('abcdef\ngh', 5); // row0 col5
    const down = moveDown(b);
    expect(cursorRowCol(down)).toEqual({ row: 1, col: 2 }); // 'gh' has length 2
  });
});

describe('text-buffer surrogate-pair safety', () => {
  const emoji = '😀'; // U+1F600 — two UTF-16 code units

  it('moveRight / moveLeft step over a whole surrogate pair', () => {
    let b = bufferOf(`a${emoji}b`, 1); // caret right after 'a', before the emoji
    b = moveRight(b);
    expect(b.cursor).toBe(3); // skipped both code units of the emoji
    b = moveLeft(b);
    expect(b.cursor).toBe(1);
  });

  it('backspace deletes a whole emoji, not a lone surrogate', () => {
    const b = backspace(bufferOf(`a${emoji}`)); // caret at end
    expect(b.value).toBe('a');
    expect(b.cursor).toBe(1);
  });
});

describe('indexAtRowCol', () => {
  it.each([
    // [desc, value, row, col, expected]
    ['first line start', 'ab\ncd', 0, 0, 0],
    ['second line middle', 'ab\ncd', 1, 1, 4],
    ['clamps col to the line length', 'ab\ncd', 0, 99, 2],
    ['clamps row to the last line', 'ab\ncd', 99, 0, 3],
  ])('%s', (_desc, value, row, col, expected) => {
    expect(indexAtRowCol(value, row, col)).toBe(expected);
  });
});

describe('bufferLines', () => {
  it('splits on newlines, always ≥ 1 element', () => {
    expect(bufferLines('')).toEqual(['']);
    expect(bufferLines('a\nb\nc')).toEqual(['a', 'b', 'c']);
  });
});

describe('visibleLineRange', () => {
  it('shows everything when it fits', () => {
    expect(visibleLineRange(3, 0, 8)).toEqual({ start: 0, end: 3 });
    expect(visibleLineRange(8, 7, 8)).toEqual({ start: 0, end: 8 });
  });

  it('anchors the caret near the bottom once it overflows', () => {
    // 12 lines, window 8, caret on the last line → show 4..12
    expect(visibleLineRange(12, 11, 8)).toEqual({ start: 4, end: 12 });
  });

  it('keeps the caret visible when scrolled up to the top', () => {
    expect(visibleLineRange(12, 0, 8)).toEqual({ start: 0, end: 8 });
  });

  it('keeps the caret visible for a mid buffer', () => {
    const { start, end } = visibleLineRange(20, 10, 8);
    expect(10).toBeGreaterThanOrEqual(start);
    expect(10).toBeLessThan(end);
  });
});

describe('caretIndexForColumn', () => {
  it.each([
    // [desc, text, column(cells), expected index(code units)]
    ['start', 'abc', 0, 0],
    ['middle of ascii', 'abc', 2, 2],
    ['past the end clamps to length', 'abc', 10, 3],
    ['left cell of a wide char lands before it', 'あい', 0, 0],
    ['second cell of a wide char still lands before it', 'あい', 1, 0],
    ['boundary between wide chars', 'あい', 2, 1],
    ['mixed ascii + cjk', 'fix バグ', 6, 5], // 'fix ' (4 cells) + バ (2 cells) -> before グ
    ['emoji is a 2-cell surrogate pair', '🍣x', 2, 2],
  ])('%s', (_desc, text, column, expected) => {
    expect(caretIndexForColumn(text, column)).toBe(expected);
  });
});

describe('caretIndexAtClick', () => {
  it('maps a click on a single-line buffer to the caret index', () => {
    const buf = bufferOf('hello', 0);
    // click on row 0, column 2 -> caret index 2
    expect(caretIndexAtClick(buf, 0, 2, 8)).toBe(2);
  });

  it('returns undefined for a click above the visible content', () => {
    expect(caretIndexAtClick(bufferOf('hi'), -1, 0, 8)).toBeUndefined();
  });

  it('returns undefined for a click below the visible content', () => {
    // one physical line, but clicked two rows down
    expect(caretIndexAtClick(bufferOf('hi'), 2, 0, 8)).toBeUndefined();
  });

  it('resolves a click on a later line to that line index', () => {
    const buf = bufferOf('ab\ncd\nef'); // 3 lines, caret at end (row 2)
    // row offset 1 within the visible window (all 3 lines fit in maxRows 8), col 1
    expect(caretIndexAtClick(buf, 1, 1, 8)).toBe(4); // 'ab\n' = 3, + col 1 = index 4
  });
});
