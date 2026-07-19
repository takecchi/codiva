import type { Key } from 'ink';
import {
  backspace,
  decodeKeySequence,
  insert,
  moveDown,
  moveLeft,
  moveRight,
  moveUp,
  newline,
  type TextBuffer,
} from '@/core';

export interface EditResult {
  buffer: TextBuffer;
  changed: boolean;
}

function result(prev: TextBuffer, next: TextBuffer): EditResult {
  return { buffer: next, changed: next !== prev };
}

/**
 * 端末からの複数文字チャンク（ペースト、まとめ読み）はキー名が付かず生テキスト
 * として届くため、制御文字が混ざり得る。改行は LF に正規化、タブはスペースに
 * 変換し、それ以外の制御文字（C0 / DEL）はバッファへ入れない。
 */
function sanitizeInsertText(text: string): string {
  const normalized = text.replace(/\r\n?/g, '\n').replace(/\t/g, ' ');
  let out = '';
  for (const ch of normalized) {
    const code = ch.codePointAt(0) ?? 0;
    if (ch === '\n' || (code >= 32 && code !== 127)) {
      out += ch;
    }
  }
  return out;
}

/**
 * Apply a keypress to a multi-line text buffer. `opts.arrows` enables horizontal
 * caret movement (←/→); `opts.vertical` also enables ↑/↓. The list view leaves
 * arrows off so they stay free for row navigation; the detail composer turns both
 * on. Keys the owning view handles itself (Enter, Tab, Esc, modifiers, PageUp/Down)
 * report `changed: false` and are left untouched.
 */
export function editText(
  buffer: TextBuffer,
  input: string,
  key: Key,
  opts: { arrows?: boolean; vertical?: boolean } = {},
): EditResult {
  const { arrows = false, vertical = false } = opts;

  // macOS reports Backspace as `delete`; treat both as delete-before-caret.
  if (key.backspace || key.delete) {
    return result(buffer, backspace(buffer));
  }
  if (arrows && key.leftArrow) {
    return result(buffer, moveLeft(buffer));
  }
  if (arrows && key.rightArrow) {
    return result(buffer, moveRight(buffer));
  }
  if (vertical && key.upArrow) {
    return result(buffer, moveUp(buffer));
  }
  if (vertical && key.downArrow) {
    return result(buffer, moveDown(buffer));
  }
  // Non-text keys the view owns (or that we don't map): no change.
  if (
    key.return ||
    key.escape ||
    key.tab ||
    key.upArrow ||
    key.downArrow ||
    key.leftArrow ||
    key.rightArrow ||
    key.ctrl ||
    key.meta ||
    key.pageUp ||
    key.pageDown
  ) {
    return { buffer, changed: false };
  }
  if (input.length > 0) {
    return result(buffer, insert(buffer, sanitizeInsertText(input)));
  }
  return { buffer, changed: false };
}

/**
 * Decide what Enter does for a composer:
 * - Shift/Meta held → insert a newline (terminals that distinguish the chord).
 * - a backslash immediately before the caret → replace it with a newline
 *   (a robust fallback for terminals that send plain `\r` for Shift+Enter).
 * - otherwise → submit the trimmed text.
 */
export type EnterAction =
  | { kind: 'newline'; buffer: TextBuffer }
  | { kind: 'submit'; text: string };

export function resolveEnter(buffer: TextBuffer, key: Key): EnterAction {
  if (key.shift || key.meta) {
    return { kind: 'newline', buffer: newline(buffer) };
  }
  if (buffer.cursor > 0 && buffer.value[buffer.cursor - 1] === '\\') {
    return { kind: 'newline', buffer: newline(backspace(buffer)) };
  }
  return { kind: 'submit', text: buffer.value.trim() };
}

/**
 * Normalize a raw `useInput` `(input, key)` pair for a composer view.
 *
 * Modern terminals encode modified keys such as Shift+Enter as an xterm
 * modifyOtherKeys / CSI-u escape (`[27;2;13~`). Ink can't parse these, so they
 * arrive as literal text with `key.return`/`key.shift` unset — which is why an
 * un-normalized composer treats Shift+Enter as pasted text instead of a newline.
 * Decoding here rebuilds the real chord so every composer (list + detail) shares
 * one Enter/newline/Tab/Esc behavior. Non-escape input passes through untouched.
 */
export function normalizeChord(input: string, key: Key): { input: string; key: Key } {
  const chord = decodeKeySequence(input);
  if (!chord) {
    return { input, key };
  }
  return {
    input: chord.kind === 'text' ? chord.text : '',
    key: {
      ...key,
      shift: chord.shift,
      ctrl: chord.ctrl,
      meta: chord.meta,
      return: chord.kind === 'return',
      tab: chord.kind === 'tab',
      escape: chord.kind === 'escape',
      backspace: chord.kind === 'backspace',
    },
  };
}
