import { describe, expect, it } from 'vitest';
import {
  backspace,
  bufferLines,
  bufferOf,
  caretIndexForColumn,
  charIndexAtColumn,
  clearBuffer,
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

  it('clearBuffer drops everything and resets the caret', () => {
    const b = clearBuffer(bufferOf('複数行\nの下書き', 2));
    expect(b.value).toBe('');
    expect(b.cursor).toBe(0);
  });

  it('clearBuffer on an empty buffer is a no-op (same reference)', () => {
    const b = emptyBuffer();
    expect(clearBuffer(b)).toBe(b);
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
    // グラフェム単位で歩く（コードポイント単位だとここから先が 1 セルずれる）。
    // '⚠️' は U+26A0 + U+FE0F の 2 コードポイント = 1 グラフェム = 2 セル。
    ['VS16 emoji occupies 2 cells', '⚠️ab', 0, 0],
    ['click after a VS16 emoji is not shifted', '⚠️ab', 2, 2],
    ['click on the char after a VS16 emoji', '⚠️ab', 3, 3],
  ])('%s', (_desc, text, column, expected) => {
    expect(caretIndexForColumn(text, column)).toBe(expected);
  });

  it('グラフェムの途中に caret を置かない', () => {
    // U+FE0F（index 1）を指してはいけない。
    for (const column of [0, 1]) {
      expect(caretIndexForColumn('⚠️ab', column)).toBe(0);
    }
  });
});

describe('charIndexAtColumn（行末より右は当たりにしない）', () => {
  it.each([
    ['行頭', 'abc', 0, 0],
    ['行内', 'abc', 2, 2],
    ['最終セル', 'abc', 2, 2],
    ['行末のちょうど右 → undefined', 'abc', 3, undefined],
    ['さらに右 → undefined', 'abc', 99, undefined],
    ['負の列 → undefined', 'abc', -1, undefined],
    ['空文字はどの列でも undefined', '', 0, undefined],
    ['全角の 2 セル目は同じ文字', 'あい', 1, 0],
    ['全角の行末の右 → undefined', 'あい', 4, undefined],
  ])('%s', (_desc, text, column, expected) => {
    expect(charIndexAtColumn(text, column)).toBe(expected);
  });

  /**
   * Regression: 判定（全体の `stringWidth` = グラフェム基準）と逆算（コードポイント基準）で
   * 単位が食い違い、VS16 絵文字より後ろの当たり判定が 1 セルずれていた。結果、URL の
   * **手前の空白**をクリックするとブラウザが開き、URL の**最後の文字**は反応しなかった。
   */
  it('VS16 絵文字を含む行でも列と文字が 1 対 1 で対応する', () => {
    const text = '⚠️ check https://x.dev/a for details';
    const urlFrom = text.indexOf('https');
    const urlTo = urlFrom + 'https://x.dev/a'.length;
    const inUrl = (column: number) => {
      const index = charIndexAtColumn(text, column);
      return index !== undefined && index >= urlFrom && index < urlTo;
    };
    expect(inUrl(urlFrom - 1)).toBe(false); // URL 直前の空白では開かない
    expect(inUrl(urlFrom)).toBe(true); // URL の先頭
    expect(inUrl(urlTo - 1)).toBe(true); // URL の末尾の文字も当たる
    expect(inUrl(urlTo)).toBe(false); // URL の直後
  });
});
