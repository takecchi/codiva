import { describe, expect, it } from 'vitest';
import {
  caretIndexAtClick,
  composerLayout,
  composerRowCount,
  moveRowDown,
  moveRowUp,
  rowSelection,
  wrapComposerRows,
} from './composer-layout';
import { bufferOf } from './text-buffer';

/** Compact view of a wrap result: the row texts plus their continuation flags. */
const shape = (value: string, width?: number) =>
  wrapComposerRows(value, width).map((r) => (r.continuation ? `+${r.text}` : r.text));

describe('wrapComposerRows', () => {
  const cases: { name: string; value: string; width?: number; rows: string[] }[] = [
    { name: 'empty value is one empty row', value: '', width: 10, rows: [''] },
    { name: 'short text stays one row', value: 'hello', width: 10, rows: ['hello'] },
    {
      name: 'no width means no wrapping (one row per logical line)',
      value: 'a'.repeat(30),
      rows: ['a'.repeat(30)],
    },
    {
      name: 'non-finite width means no wrapping',
      value: 'a'.repeat(30),
      width: Number.NaN,
      rows: ['a'.repeat(30)],
    },
    {
      name: 'a long word is hard-broken at the width',
      value: 'abcdefghij',
      width: 4,
      rows: ['abcd', '+efgh', '+ij'],
    },
    {
      name: 'breaks at the last space instead of mid-word',
      value: 'hello world',
      width: 8,
      rows: ['hello ', '+world'],
    },
    {
      name: 'a space exactly at the edge is not moved down',
      value: 'ab cd',
      width: 3,
      rows: ['ab ', '+cd'],
    },
    {
      name: 'CJK counts as two cells per char',
      value: 'あいうえお',
      width: 4,
      rows: ['あい', '+うえ', '+お'],
    },
    {
      name: 'a char wider than the width still gets its own row',
      value: 'あい',
      width: 1,
      rows: ['あ', '+い'],
    },
    {
      name: 'each logical line wraps independently',
      value: 'abcd\nef',
      width: 2,
      rows: ['ab', '+cd', 'ef'],
    },
    {
      name: 'blank logical lines survive as empty rows',
      value: 'ab\n\ncd',
      width: 4,
      rows: ['ab', '', 'cd'],
    },
    {
      name: 'a line that exactly fills the width does not add a blank row',
      value: 'abcd\nef',
      width: 4,
      rows: ['abcd', 'ef'],
    },
  ];
  it.each(cases)('$name', ({ value, width, rows }) => {
    expect(shape(value, width)).toEqual(rows);
  });

  it('rows partition the value exactly (indices map back to the text)', () => {
    const value = 'hello world\nこんにちは everyone';
    for (const row of wrapComposerRows(value, 6)) {
      expect(value.slice(row.start, row.end)).toBe(row.text);
    }
  });

  it('counts display rows', () => {
    expect(composerRowCount('abcdefghij', 4)).toBe(3);
    expect(composerRowCount('abcdefghij')).toBe(1);
  });
});

describe('composerLayout caret placement', () => {
  const cases: {
    name: string;
    value: string;
    cursor: number;
    width?: number;
    row: number;
    col: number;
  }[] = [
    { name: 'start of an empty buffer', value: '', cursor: 0, width: 4, row: 0, col: 0 },
    { name: 'within the first row', value: 'abcdef', cursor: 2, width: 4, row: 0, col: 2 },
    {
      name: 'a wrap boundary belongs to the continuing row',
      value: 'abcdef',
      cursor: 4,
      width: 4,
      row: 1,
      col: 0,
    },
    { name: 'inside a continuation row', value: 'abcdef', cursor: 5, width: 4, row: 1, col: 1 },
    {
      name: 'end of a newline-terminated line stays on that row',
      value: 'ab\ncd',
      cursor: 2,
      width: 4,
      row: 0,
      col: 2,
    },
    {
      name: 'after the newline is the next row',
      value: 'ab\ncd',
      cursor: 3,
      width: 4,
      row: 1,
      col: 0,
    },
    {
      name: 'without a width the caret stays on its logical line',
      value: 'abcdef',
      cursor: 5,
      row: 0,
      col: 5,
    },
  ];
  it.each(cases)('$name', ({ value, cursor, width, row, col }) => {
    expect(composerLayout(bufferOf(value, cursor), width).caret).toEqual({ row, col });
  });

  it('opens a fresh row when the caret is past a completely full row', () => {
    // 'abcd' fills width 4 and nothing continues it → the caret wraps to a new row
    // (drawing it at column 4 would be one cell outside the input).
    const layout = composerLayout(bufferOf('abcd'), 4);
    expect(layout.rows.map((r) => r.text)).toEqual(['abcd', '']);
    expect(layout.caret).toEqual({ row: 1, col: 0 });
  });

  it('does not open a fresh row when the full row is followed by more text', () => {
    const layout = composerLayout(bufferOf('abcdef', 4), 4);
    expect(layout.rows.map((r) => r.text)).toEqual(['abcd', 'ef']);
    expect(layout.caret).toEqual({ row: 1, col: 0 });
  });

  it('clamps an out-of-range cursor', () => {
    expect(composerLayout({ value: 'ab', cursor: 99 }, 4).caret).toEqual({ row: 0, col: 2 });
  });
});

describe('caretIndexAtClick', () => {
  it('maps a click on a single-line buffer to the caret index', () => {
    expect(caretIndexAtClick(bufferOf('hello', 0), 0, 2, 8)).toBe(2);
  });

  it('returns undefined for a click above the visible content', () => {
    expect(caretIndexAtClick(bufferOf('hi'), -1, 0, 8)).toBeUndefined();
  });

  it('returns undefined for a click below the visible content', () => {
    expect(caretIndexAtClick(bufferOf('hi'), 2, 0, 8)).toBeUndefined();
  });

  it('resolves a click on a later line to that line index', () => {
    const buf = bufferOf('ab\ncd\nef'); // 3 lines, caret at end (row 2)
    expect(caretIndexAtClick(buf, 1, 1, 8)).toBe(4); // 'ab\n' = 3, + col 1
  });

  it('resolves a click on a wrapped continuation row', () => {
    const buf = bufferOf('abcdefghij', 0);
    // width 4 → rows 'abcd' / 'efgh' / 'ij'; row 1, column 2 → 'g' at index 6
    expect(caretIndexAtClick(buf, 1, 2, 8, 4)).toBe(6);
  });

  it('clamps a click past the end of a wrapped row to that row', () => {
    const buf = bufferOf('abcdefghij', 0);
    expect(caretIndexAtClick(buf, 1, 99, 8, 4)).toBe(8); // end of 'efgh'
  });

  it('accounts for the wrap when scrolling internally (maxRows)', () => {
    const buf = bufferOf('abcdefghij'); // width 4 → rows 'abcd' / 'efgh' / 'ij', caret on the last
    // maxRows 2 shows only the last two rows, so content row 0 is 'efgh' → 'f' at index 5.
    expect(caretIndexAtClick(buf, 0, 1, 2, 4)).toBe(5);
  });
});

describe('rowSelection', () => {
  const row = { text: 'cdef', start: 2, end: 6, continuation: true } as const;
  const cases: {
    name: string;
    range: [number, number];
    expected?: { from: number; to: number };
  }[] = [
    { name: 'fully inside the row', range: [3, 5], expected: { from: 1, to: 3 } },
    { name: 'clipped to the row start', range: [0, 4], expected: { from: 0, to: 2 } },
    { name: 'clipped to the row end', range: [4, 99], expected: { from: 2, to: 4 } },
    { name: 'spanning the whole row', range: [0, 99], expected: { from: 0, to: 4 } },
    { name: 'entirely before the row', range: [0, 2], expected: undefined },
    { name: 'entirely after the row', range: [6, 8], expected: undefined },
  ];
  it.each(cases)('$name', ({ range, expected }) => {
    expect(rowSelection({ start: range[0], end: range[1] }, row)).toEqual(expected);
  });
});

describe('vertical caret movement by display row', () => {
  it('moves up within a wrapped line instead of jumping to the start', () => {
    // width 4 → 'abcd' / 'efgh' / 'ij'; caret at index 9 (row 2, col 1)
    expect(moveRowUp(bufferOf('abcdefghij', 9), 4).cursor).toBe(5); // row 1, col 1
  });

  it('moves down within a wrapped line', () => {
    expect(moveRowDown(bufferOf('abcdefghij', 1), 4).cursor).toBe(5);
  });

  it('keeps the display column across a CJK row', () => {
    // width 4 → 'あい' / 'うえ' / 'お'; caret after 'う' is 2 cells in
    expect(moveRowUp(bufferOf('あいうえお', 3), 4).cursor).toBe(1); // after 'あ'
  });

  it('goes to the buffer start above the first row', () => {
    expect(moveRowUp(bufferOf('abcd', 2), 10).cursor).toBe(0);
  });

  it('goes to the buffer end below the last row', () => {
    expect(moveRowDown(bufferOf('abcd', 2), 10).cursor).toBe(4);
  });

  it('clamps to the end of a shorter target row', () => {
    // 'abcdefghij' width 4 → last row 'ij'; from row 1 col 3 → end of 'ij'
    expect(moveRowDown(bufferOf('abcdefghij', 7), 4).cursor).toBe(10);
  });

  it('returns the same reference when nothing moves', () => {
    const start = bufferOf('abcd', 0);
    expect(moveRowUp(start, 10)).toBe(start);
    const end = bufferOf('abcd', 4);
    expect(moveRowDown(end, 10)).toBe(end);
  });

  it('falls back to logical lines without a width', () => {
    const buf = bufferOf('ab\ncdef', 6); // row 1, col 3
    expect(moveRowUp(buf).cursor).toBe(2); // end of 'ab'
  });
});
