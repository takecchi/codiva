import { describe, expect, it } from 'vitest';
import { formatElapsed } from './format';

describe('formatElapsed', () => {
  it.each([
    [0, 0, '0s'],
    [0, 5_000, '5s'],
    [0, 59_000, '59s'],
    [0, 60_000, '1m00s'],
    [0, 65_000, '1m05s'],
    [0, 3_723_000, '62m03s'],
    // sub-second differences floor to whole seconds
    [1000, 1900, '0s'],
  ])('formatElapsed(%i, %i) = %s', (start, end, expected) => {
    expect(formatElapsed(start, end)).toBe(expected);
  });

  it('never returns a negative duration when end precedes start', () => {
    expect(formatElapsed(5_000, 0)).toBe('0s');
  });
});
