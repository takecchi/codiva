import { describe, expect, it } from 'vitest';
import { formatDuration } from './format';

describe('formatDuration', () => {
  it.each([
    [0, '0s'],
    [5_000, '5s'],
    [59_000, '59s'],
    [60_000, '1m00s'],
    [65_000, '1m05s'],
    [3_723_000, '62m03s'],
    // sub-second remainders floor to whole seconds
    [900, '0s'],
    [1_900, '1s'],
  ])('formatDuration(%i) = %s', (ms, expected) => {
    expect(formatDuration(ms)).toBe(expected);
  });

  it('never returns a negative duration', () => {
    expect(formatDuration(-5_000)).toBe('0s');
  });
});
