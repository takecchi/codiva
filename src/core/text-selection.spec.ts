import { describe, expect, it } from 'vitest';
import {
  lineSelection,
  normalizeSelection,
  selectionSlices,
  selectionText,
} from './text-selection';

describe('normalizeSelection', () => {
  it('orders anchor/focus into start ≤ end', () => {
    expect(normalizeSelection(2, 7)).toEqual({ start: 2, end: 7 });
    expect(normalizeSelection(7, 2)).toEqual({ start: 2, end: 7 });
  });

  it('returns undefined for an empty selection (plain click)', () => {
    expect(normalizeSelection(4, 4)).toBeUndefined();
  });
});

describe('selectionText', () => {
  it('slices the selected substring', () => {
    expect(selectionText('hello world', { start: 6, end: 11 })).toBe('world');
  });

  it('spans newlines', () => {
    expect(selectionText('ab\ncd\nef', { start: 1, end: 7 })).toBe('b\ncd\ne');
  });
});

describe('lineSelection', () => {
  const value = 'ab\ncd\nef';
  // indices:    0=a 1=b 2=\n 3=c 4=d 5=\n 6=e 7=f

  it('maps a single-line selection to line-local offsets', () => {
    // select 'b' (index 1..2) on row 0
    expect(lineSelection(value, { start: 1, end: 2 }, 0)).toEqual({ from: 1, to: 2 });
  });

  it('highlights to end of the first line of a multi-line selection', () => {
    // select 'b\ncd\ne' (1..7)
    expect(lineSelection(value, { start: 1, end: 7 }, 0)).toEqual({ from: 1, to: 2 });
    expect(lineSelection(value, { start: 1, end: 7 }, 1)).toEqual({ from: 0, to: 2 });
    expect(lineSelection(value, { start: 1, end: 7 }, 2)).toEqual({ from: 0, to: 1 });
  });

  it('returns undefined for lines outside the selection', () => {
    expect(lineSelection(value, { start: 6, end: 8 }, 0)).toBeUndefined();
    expect(lineSelection(value, { start: 6, end: 8 }, 1)).toBeUndefined();
  });

  it('returns undefined for out-of-range rows', () => {
    expect(lineSelection(value, { start: 0, end: 2 }, -1)).toBeUndefined();
    expect(lineSelection(value, { start: 0, end: 2 }, 3)).toBeUndefined();
  });

  it('returns undefined for a blank line spanned by the selection', () => {
    // 'a\n\nb': indices 0=a 1=\n 2=\n(blank line 1 is empty) 3=b
    const v = 'a\n\nb';
    expect(lineSelection(v, { start: 0, end: 4 }, 1)).toBeUndefined();
  });
});

describe('selectionSlices', () => {
  /** 検証しやすい形（テキストと反転の対）へ落とす。 */
  const pairs = (segments: readonly string[], sel?: { from: number; to: number }) =>
    selectionSlices(segments, sel).map((s) => [s.text, s.inverse]);

  it('選択が無ければセグメントそのまま（空セグメントは落ちる）', () => {
    expect(pairs(['ab', '', 'cd'])).toEqual([
      ['ab', false],
      ['cd', false],
    ]);
  });

  it('1 セグメントの中を 3 片に切る', () => {
    expect(pairs(['abcdef'], { from: 2, to: 4 })).toEqual([
      ['ab', false],
      ['cd', true],
      ['ef', false],
    ]);
  });

  it('セグメントを跨ぐ選択は各セグメントで切られる（1 続きの反転になる）', () => {
    expect(pairs(['abc', 'def', 'ghi'], { from: 2, to: 7 })).toEqual([
      ['ab', false],
      ['c', true],
      ['def', true],
      ['g', true],
      ['hi', false],
    ]);
  });

  it('全体選択は反転のみ', () => {
    expect(pairs(['ab', 'cd'], { from: 0, to: 4 })).toEqual([
      ['ab', true],
      ['cd', true],
    ]);
  });

  it('index / offset はスタイル参照とキーのために保たれる', () => {
    expect(selectionSlices(['abc', 'def'], { from: 1, to: 5 })).toEqual([
      { index: 0, offset: 0, text: 'a', inverse: false },
      { index: 0, offset: 1, text: 'bc', inverse: true },
      { index: 1, offset: 0, text: 'de', inverse: true },
      { index: 1, offset: 2, text: 'f', inverse: false },
    ]);
  });

  it('範囲外のオフセットは各セグメントに丸められる', () => {
    expect(pairs(['abc'], { from: -5, to: 99 })).toEqual([['abc', true]]);
    expect(pairs(['abc'], { from: 5, to: 9 })).toEqual([['abc', false]]);
  });
});
