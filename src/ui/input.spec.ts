import type { Key } from 'ink';
import { describe, expect, it } from 'vitest';
import { editBuffer, promptCaretColumn } from './input';

const key = (overrides: Partial<Key> = {}): Key =>
  ({
    upArrow: false,
    downArrow: false,
    leftArrow: false,
    rightArrow: false,
    pageDown: false,
    pageUp: false,
    home: false,
    end: false,
    return: false,
    escape: false,
    ctrl: false,
    shift: false,
    tab: false,
    backspace: false,
    delete: false,
    meta: false,
    super: false,
    hyper: false,
    capsLock: false,
    numLock: false,
    eventType: 'press',
    ...overrides,
  }) as Key;

describe('editBuffer', () => {
  it.each([
    // [desc, value, input, expected]
    ['appends ascii', 'ab', 'c', 'abc'],
    ['appends a single hiragana char', 'fix ', 'あ', 'fix あ'],
    ['appends an IME-committed multi-char string at once', '', 'こんにちは世界', 'こんにちは世界'],
    ['appends full-width symbols', 'a', '「テスト」', 'a「テスト」'],
  ])('%s', (_desc, value, input, expected) => {
    const edit = editBuffer(value, input, key());
    expect(edit).toEqual({ value: expected, changed: true });
  });

  it('backspace removes a whole Japanese character, not a code unit', () => {
    const edit = editBuffer('たこ焼き', '', key({ backspace: true }));
    expect(edit).toEqual({ value: 'たこ焼', changed: true });
  });

  it('backspace removes a whole surrogate-pair character (emoji)', () => {
    const edit = editBuffer('a🍣', '', key({ backspace: true }));
    expect(edit).toEqual({ value: 'a', changed: true });
  });
});

describe('promptCaretColumn', () => {
  it.each([
    // ❯ + space = 2 columns of prefix
    ['empty buffer', '', 2],
    ['ascii', 'abc', 5],
    // CJK chars are 2 columns wide each
    ['hiragana', 'こんにちは', 12],
    ['mixed ascii + japanese', 'fix バグ', 2 + 4 + 4],
  ])('%s', (_desc, value, expected) => {
    expect(promptCaretColumn(value)).toBe(expected);
  });
});
