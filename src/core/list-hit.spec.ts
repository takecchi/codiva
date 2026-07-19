import { describe, expect, it } from 'vitest';
import { isPrCellHit, rowLineAtPoint } from './list-hit';

describe('rowLineAtPoint', () => {
  it('maps a click to its window-relative row offset (no indicator)', () => {
    expect(rowLineAtPoint(5, 3, false, 4)).toBe(2);
  });

  it('shifts by one when the "more above" indicator occupies the first line', () => {
    expect(rowLineAtPoint(5, 3, true, 4)).toBe(1);
  });

  it('returns undefined above the first row', () => {
    expect(rowLineAtPoint(2, 3, false, 4)).toBeUndefined();
    // the indicator line itself is not a session row
    expect(rowLineAtPoint(3, 3, true, 4)).toBeUndefined();
  });

  it('returns undefined at or past the last visible row', () => {
    expect(rowLineAtPoint(7, 3, false, 4)).toBeUndefined();
  });
});

describe('isPrCellHit', () => {
  // columns=80, rowsLeft=1 (padding), cellWidth=10 → cell spans [69, 79)
  it('is true inside the right-anchored cell', () => {
    expect(isPrCellHit(69, 80, 1, 10)).toBe(true);
    expect(isPrCellHit(78, 80, 1, 10)).toBe(true);
  });

  it('is false left of the cell', () => {
    expect(isPrCellHit(68, 80, 1, 10)).toBe(false);
  });

  it('is false at or past the cell right edge', () => {
    expect(isPrCellHit(79, 80, 1, 10)).toBe(false);
  });
});
