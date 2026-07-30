import { describe, expect, it } from 'vitest';
import { gaugeCells } from './gauge';

describe('gaugeCells', () => {
  it.each([
    [0, 8, 0, 8],
    [100, 8, 8, 0],
    [50, 8, 4, 4],
    [12.5, 8, 1, 7],
    // Rounds to zero, but "used something" must never render as an empty bar.
    [0.4, 8, 1, 7],
    [99.9, 8, 8, 0],
    // Out-of-range values are clamped rather than overflowing the bar.
    [140, 8, 8, 0],
    [-5, 8, 0, 8],
    [Number.NaN, 8, 0, 8],
    // Degenerate widths.
    [50, 0, 0, 0],
    [50, -3, 0, 0],
    [50, 1, 1, 0],
  ])('%s%% of %s cells → %s filled / %s empty', (percent, width, filled, empty) => {
    expect(gaugeCells(percent, width)).toEqual({ filled, empty });
  });

  it('never exceeds the requested width', () => {
    for (let pct = 0; pct <= 100; pct += 0.5) {
      const { filled, empty } = gaugeCells(pct, 10);
      expect(filled + empty).toBe(10);
    }
  });
});
