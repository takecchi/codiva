import { describe, expect, it } from 'vitest';
import {
  DETAIL_CHROME_ROWS,
  isFullscreenViewport,
  logViewportRows,
  MIN_FULLSCREEN_ROWS,
} from './layout';

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

describe('logViewportRows', () => {
  it('subtracts the fixed chrome from the terminal height', () => {
    expect(logViewportRows(30)).toBe(30 - DETAIL_CHROME_ROWS);
  });

  it('never returns less than 1, even on tiny terminals', () => {
    expect(logViewportRows(DETAIL_CHROME_ROWS)).toBe(1);
    expect(logViewportRows(0)).toBe(1);
  });
});
