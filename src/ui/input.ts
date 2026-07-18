import type { Key } from 'ink';
import stringWidth from 'string-width';
import { glyph } from './theme';

/**
 * Apply a keypress to a single-line text buffer. Returns the (possibly) updated
 * value and whether it changed. Non-text keys (arrows, enter, esc, modifiers)
 * are left for the view to handle and report `changed: false`.
 */
export function editBuffer(
  value: string,
  input: string,
  key: Key,
): { value: string; changed: boolean } {
  if (key.backspace || key.delete) {
    if (value.length === 0) {
      return { value, changed: false };
    }
    // コードポイント単位で1文字消す。code unit の slice(0, -1) だと
    // サロゲートペア（絵文字等）が半分だけ残って壊れる。
    const chars = [...value];
    return { value: chars.slice(0, -1).join(''), changed: true };
  }
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
    return { value, changed: false };
  }
  if (input.length > 0) {
    return { value: value + input, changed: true };
  }
  return { value, changed: false };
}

/**
 * Column (0-based, in terminal cells) of the caret inside PromptInput's content
 * line: the `❯ ` prefix plus the buffer. CJK/絵文字は2セル幅なので string-width
 * で数える（.length だと日本語入力でカーソルがズレる）。
 */
export function promptCaretColumn(value: string): number {
  return stringWidth(`${glyph.caret} ${value}`);
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
