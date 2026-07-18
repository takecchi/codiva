import type { Key } from 'ink';
import { describe, expect, it } from 'vitest';
import { bufferOf, emptyBuffer } from '@/core';
import { editText, promptCaretColumn } from './input';

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

// 日本語（IME）入力の UI マッピング。バッファ操作そのものの網羅は
// core/text-buffer.spec.ts が持つので、ここでは日本語特有の経路に絞る。
describe('editText (Japanese input)', () => {
  it.each([
    // [desc, value, input, expected]
    ['appends a single hiragana char', 'fix ', 'あ', 'fix あ'],
    ['appends an IME-committed multi-char string at once', '', 'こんにちは世界', 'こんにちは世界'],
    ['appends full-width symbols', 'a', '「テスト」', 'a「テスト」'],
  ])('%s', (_desc, value, input, expected) => {
    const edit = editText(bufferOf(value), input, key());
    expect(edit.changed).toBe(true);
    expect(edit.buffer.value).toBe(expected);
  });

  it('inserts an IME-committed string at a mid-string caret', () => {
    const buf = bufferOf('日本です', 2); // 日本|です
    const edit = editText(buf, '語', key());
    expect(edit.buffer.value).toBe('日本語です');
    expect(edit.buffer.cursor).toBe(3);
  });

  it('backspace removes a whole Japanese character', () => {
    const edit = editText(bufferOf('たこ焼き'), '', key({ backspace: true }));
    expect(edit.buffer.value).toBe('たこ焼');
  });

  it('backspace removes a whole surrogate-pair character (emoji)', () => {
    const edit = editText(bufferOf('a🍣'), '', key({ backspace: true }));
    expect(edit.buffer.value).toBe('a');
  });

  it('empty input on an empty buffer reports no change', () => {
    const edit = editText(emptyBuffer(), '', key());
    expect(edit.changed).toBe(false);
  });
});

describe('promptCaretColumn', () => {
  it.each([
    // ❯ + space = 2 columns of prefix
    ['empty line', '', 2],
    ['ascii', 'abc', 5],
    // CJK chars are 2 columns wide each
    ['hiragana', 'こんにちは', 12],
    ['mixed ascii + japanese', 'fix バグ', 2 + 4 + 4],
  ])('%s', (_desc, textBeforeCaret, expected) => {
    expect(promptCaretColumn(textBeforeCaret)).toBe(expected);
  });
});
