import { describe, expect, it } from 'vitest';
import {
  backspace,
  bufferLines,
  bufferOf,
  cursorRowCol,
  emptyBuffer,
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
