import { describe, expect, it } from 'vitest';
import { lineSelection, normalizeSelection, selectionText } from './text-selection';

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
