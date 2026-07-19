import { describe, expect, it } from 'vitest';
import { decodeKeySequence } from './key-sequence';

const ESC = String.fromCharCode(27);

describe('decodeKeySequence', () => {
  it.each([
    // [desc, input, expected]
    [
      'Shift+Enter (modifyOtherKeys, the reported bug)',
      '[27;2;13~',
      { kind: 'return', text: '', shift: true, ctrl: false, meta: false },
    ],
    [
      'Shift+Enter with raw ESC prefix',
      `${ESC}[27;2;13~`,
      { kind: 'return', text: '', shift: true, ctrl: false, meta: false },
    ],
    [
      'plain Enter (modifyOtherKeys, no modifier)',
      '[27;1;13~',
      { kind: 'return', text: '', shift: false, ctrl: false, meta: false },
    ],
    [
      'Ctrl+Enter',
      '[27;5;13~',
      { kind: 'return', text: '', shift: false, ctrl: true, meta: false },
    ],
    [
      'Alt+Enter maps to meta',
      '[27;3;13~',
      { kind: 'return', text: '', shift: false, ctrl: false, meta: true },
    ],
    [
      'Shift+Enter (CSI-u form)',
      '[13;2u',
      { kind: 'return', text: '', shift: true, ctrl: false, meta: false },
    ],
    ['Tab code', '[27;2;9~', { kind: 'tab', text: '', shift: true, ctrl: false, meta: false }],
    [
      'Escape code',
      '[27;2;27~',
      { kind: 'escape', text: '', shift: true, ctrl: false, meta: false },
    ],
    [
      'Backspace code (127)',
      '[27;2;127~',
      { kind: 'backspace', text: '', shift: true, ctrl: false, meta: false },
    ],
    [
      'printable char surfaces as text',
      '[27;2;97~',
      { kind: 'text', text: 'a', shift: true, ctrl: false, meta: false },
    ],
  ])('%s', (_desc, input, expected) => {
    expect(decodeKeySequence(input)).toEqual(expected);
  });

  it.each([
    ['ordinary text', 'abc'],
    ['japanese text', 'こんにちは'],
    ['arrow-like csi', '[A'],
    ['sgr mouse report', '[<0;13;5M'],
    ['unterminated', '[27;2;13'],
  ])('returns undefined for %s', (_desc, input) => {
    expect(decodeKeySequence(input)).toBeUndefined();
  });
});
