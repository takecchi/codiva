import { describe, expect, it } from 'vitest';
import { parseSgrMouse } from './mouse';

const ESC = String.fromCharCode(27);

describe('parseSgrMouse', () => {
  it.each([
    // [desc, input, expected]
    ['left press (ESC stripped by ink)', '[<0;13;5M', { kind: 'press', x: 12, y: 4 }],
    ['left release', '[<0;13;5m', { kind: 'release', x: 12, y: 4 }],
    ['press with raw ESC prefix', `${ESC}[<0;1;1M`, { kind: 'press', x: 0, y: 0 }],
    ['wheel up', '[<64;10;3M', { kind: 'wheel', dir: 'up', x: 9, y: 2 }],
    ['wheel down', '[<65;10;3M', { kind: 'wheel', dir: 'down', x: 9, y: 2 }],
    ['right button press still reports position', '[<2;4;2M', { kind: 'press', x: 3, y: 1 }],
  ])('%s', (_desc, input, expected) => {
    expect(parseSgrMouse(input)).toEqual(expected);
  });

  it.each([
    ['ordinary text', 'こんにちは'],
    ['ascii', 'abc'],
    ['arrow-like csi', '[A'],
    ['motion report (bit 32)', '[<35;4;2M'],
    ['truncated report', '[<0;13M'],
  ])('returns undefined for %s', (_desc, input) => {
    expect(parseSgrMouse(input)).toBeUndefined();
  });
});
