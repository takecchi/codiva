import type { Key } from 'ink';
import { describe, expect, it } from 'vitest';
import { bufferOf, emptyBuffer } from '@/core';
import { editText, normalizeChord } from './input';

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

// まとめ読み・ペーストのチャンクはキー名なしの生テキストで届くため、制御文字が
// バッファへ混入しないことを editText の挿入経路で保証する。
describe('editText input sanitization', () => {
  it.each([
    ['tabs become spaces', 'a\tb', 'a b'],
    ['CRLF normalizes to LF (multi-line paste keeps newlines)', 'one\r\ntwo', 'one\ntwo'],
    ['lone CR normalizes to LF', 'one\rtwo', 'one\ntwo'],
    [
      'other control chars are dropped',
      `a${String.fromCharCode(27)}${String.fromCharCode(7)}b`,
      'ab',
    ],
    ['DEL is dropped', `a${String.fromCharCode(127)}b`, 'ab'],
  ])('%s', (_desc, input, expected) => {
    const edit = editText(emptyBuffer(), input, key());
    expect(edit.buffer.value).toBe(expected);
  });
});

// 修飾キーエスケープ（modifyOtherKeys / CSI-u）を実キーへ復号する共通処理。
// 一覧・詳細の両コンポーザが同じ Enter/改行挙動になることを保証する。
describe('normalizeChord', () => {
  it('decodes Shift+Enter (modifyOtherKeys) into a return chord with shift', () => {
    const { input, key: out } = normalizeChord('[27;2;13~', key());
    expect(out.return).toBe(true);
    expect(out.shift).toBe(true);
    expect(input).toBe('');
  });

  it('decodes Shift+Enter (CSI-u) into a return chord with shift', () => {
    const { input, key: out } = normalizeChord('[13;2u', key());
    expect(out.return).toBe(true);
    expect(out.shift).toBe(true);
    expect(input).toBe('');
  });

  it('decodes a leading-ESC escape (Ink strips at most one ESC)', () => {
    const { key: out } = normalizeChord(`${String.fromCharCode(27)}[27;2;13~`, key());
    expect(out.return).toBe(true);
    expect(out.shift).toBe(true);
  });

  it('surfaces a modified printable code point as text', () => {
    const { input, key: out } = normalizeChord('[97;2u', key()); // Shift+a
    expect(input).toBe('a');
    expect(out.shift).toBe(true);
    expect(out.return).toBe(false);
  });

  it('passes ordinary text through untouched', () => {
    const original = key();
    const { input, key: out } = normalizeChord('あ', original);
    expect(input).toBe('あ');
    expect(out).toBe(original);
  });

  it('passes a plain return key through untouched', () => {
    const original = key({ return: true });
    const { input, key: out } = normalizeChord('', original);
    expect(input).toBe('');
    expect(out).toBe(original);
    expect(out.return).toBe(true);
  });
});
