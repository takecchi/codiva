import { describe, expect, it } from 'vitest';
import { isFullscreenViewport, MIN_FULLSCREEN_ROWS } from './layout';

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
