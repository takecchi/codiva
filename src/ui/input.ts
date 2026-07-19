import type { Key } from 'ink';
import stringWidth from 'string-width';
import {
  backspace,
  insert,
  moveDown,
  moveLeft,
  moveRight,
  moveUp,
  newline,
  type TextBuffer,
} from '@/core';
import { glyph } from './theme';

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
 * Column (0-based, in terminal cells) of the caret within a PromptInput row:
 * the 2-cell `❯ `／`  ` prefix plus the text before the caret on that line.
 * CJK/絵文字は2セル幅なので string-width で数える（.length だと日本語入力で
 * カーソルと IME preedit の位置がズレる）。
 */
export function promptCaretColumn(textBeforeCaret: string): number {
  return stringWidth(`${glyph.caret} ${textBeforeCaret}`);
}

/**
 * Inverse of the caret-column math: the caret index (UTF-16 units) for a click at
 * `column` display cells from the start of `text`. A click anywhere on a wide
 * (2-cell) character places the caret before it; past the end goes to the end.
 */
export function caretIndexForColumn(text: string, column: number): number {
  if (column <= 0) {
    return 0;
  }
  let cells = 0;
  let index = 0;
  for (const ch of text) {
    const w = stringWidth(ch);
    if (cells + w > column) {
      return index;
    }
    cells += w;
    index += ch.length;
  }
  return text.length;
}

/** Format elapsed time between startedAt and end (finishedAt or now). */
export function formatElapsed(startedAt: number, end: number): string {
  const secs = Math.max(0, Math.floor((end - startedAt) / 1000));
  const mins = Math.floor(secs / 60);
  if (mins === 0) {
    return `${secs}s`;
  }
  return `${mins}m${String(secs % 60).padStart(2, '0')}s`;
}
