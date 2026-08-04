import { describe, expect, it } from 'vitest';
import { parseSgrMouse } from './mouse';

const ESC = String.fromCharCode(27);

describe('parseSgrMouse', () => {
  it.each([
    // [desc, input, expected]
    [
      'left press (ESC stripped by ink)',
      '[<0;13;5M',
      { kind: 'press', x: 12, y: 4, button: 'left' },
    ],
    ['left release', '[<0;13;5m', { kind: 'release', x: 12, y: 4, button: 'left' }],
    ['press with raw ESC prefix', `${ESC}[<0;1;1M`, { kind: 'press', x: 0, y: 0, button: 'left' }],
    ['wheel up', '[<64;10;3M', { kind: 'wheel', dir: 'up', x: 9, y: 2 }],
    ['wheel down', '[<65;10;3M', { kind: 'wheel', dir: 'down', x: 9, y: 2 }],
    // ボタンの種別も返す: 副作用のある操作（URL を開く）を左ボタンだけに限るため。
    ['middle button press', '[<1;4;2M', { kind: 'press', x: 3, y: 1, button: 'middle' }],
    [
      'right button press still reports position',
      '[<2;4;2M',
      { kind: 'press', x: 3, y: 1, button: 'right' },
    ],
    ['right button release', '[<2;4;2m', { kind: 'release', x: 3, y: 1, button: 'right' }],
    // ?1002 drag: button 0 + motion bit (32) = 32, reported with a trailing `M`.
    ['left-button drag (motion bit 32)', '[<32;5;2M', { kind: 'drag', x: 4, y: 1, button: 'left' }],
    ['drag report code 35', '[<35;4;2M', { kind: 'drag', x: 3, y: 1, button: 'left' }],
  ])('%s', (_desc, input, expected) => {
    expect(parseSgrMouse(input)).toEqual(expected);
  });

  it.each([
    ['ordinary text', 'こんにちは'],
    ['ascii', 'abc'],
    ['arrow-like csi', '[A'],
    ['truncated report', '[<0;13M'],
  ])('returns undefined for %s', (_desc, input) => {
    expect(parseSgrMouse(input)).toBeUndefined();
  });
});
