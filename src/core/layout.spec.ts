import { describe, expect, it } from 'vitest';
import { isFullscreenViewport, MIN_FULLSCREEN_ROWS, tailMessages } from './layout';
import type { LogEntry } from './types';

function entries(n: number): LogEntry[] {
  return Array.from({ length: n }, (_, i) => ({
    seq: i,
    kind: 'assistant_text',
    text: `line ${i}`,
  }));
}

describe('isFullscreenViewport', () => {
  it.each([
    [MIN_FULLSCREEN_ROWS - 1, false],
    [MIN_FULLSCREEN_ROWS, true],
    [8, false],
    [24, true],
    [0, false],
  ])('rows=%d → %s', (rows, expected) => {
    expect(isFullscreenViewport(rows)).toBe(expected);
  });
});

describe('tailMessages', () => {
  it('returns everything when messages fit within rows', () => {
    const all = entries(3);
    expect(tailMessages(all, 10)).toEqual(all);
  });

  it('keeps only the newest rows entries when overflowing', () => {
    const tail = tailMessages(entries(30), 5);
    expect(tail).toHaveLength(5);
    expect(tail[0]?.seq).toBe(25);
    expect(tail[4]?.seq).toBe(29);
  });

  it('returns the newest entry even when rows is 0 or negative', () => {
    expect(tailMessages(entries(4), 0).map((e) => e.seq)).toEqual([3]);
    expect(tailMessages(entries(4), -2).map((e) => e.seq)).toEqual([3]);
  });

  it('returns an empty array for an empty log', () => {
    expect(tailMessages([], 10)).toEqual([]);
  });
});
