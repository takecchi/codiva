/**
 * Decode xterm "modifyOtherKeys" / CSI-u key escapes (pure).
 *
 * Modern terminals (Kitty, Ghostty, xterm with modifyOtherKeys) encode modified
 * keys such as Shift+Enter as an escape sequence instead of a bare control byte:
 *
 *   - modifyOtherKeys:  ESC [ 27 ; <mod> ; <code> ~   (e.g. `[27;2;13~`)
 *   - CSI-u:            ESC [ <code> ; <mod> u        (e.g. `[13;2u`)
 *
 * Ink's key parser doesn't understand these, so they arrive at `useInput` as
 * literal text (the ESC is stripped) — `[27;2;13~` — and would otherwise be
 * inserted verbatim into the composer. We decode them to a normalized key so the
 * view can treat Shift+Enter as a real Enter chord (→ newline).
 *
 * `<code>` is the unicode code point of the base key (13 = CR/Enter, 9 = Tab,
 * 27 = Esc, 8/127 = Backspace, otherwise a printable char). `<mod>` is
 * `1 + bitmask` where bit 0 = Shift, bit 1 = Alt, bit 2 = Ctrl.
 */
export interface DecodedKey {
  kind: 'return' | 'tab' | 'escape' | 'backspace' | 'text';
  /** The printable character for `kind: 'text'`; '' for the special keys. */
  text: string;
  shift: boolean;
  ctrl: boolean;
  meta: boolean;
}

// modifyOtherKeys: CSI 27 ; mod ; code ~   |   CSI-u: CSI code ; mod u (mod optional)
const MODIFY_OTHER_KEYS = /^\[27;(\d+);(\d+)~$/;
const CSI_U = /^\[(\d+)(?:;(\d+))?u$/;

function fromCode(code: number, modifier: number): DecodedKey {
  const mask = Math.max(0, modifier - 1);
  const base = {
    shift: (mask & 1) !== 0,
    meta: (mask & 2) !== 0,
    ctrl: (mask & 4) !== 0,
  };
  if (code === 13 || code === 10) {
    return { kind: 'return', text: '', ...base };
  }
  if (code === 9) {
    return { kind: 'tab', text: '', ...base };
  }
  if (code === 27) {
    return { kind: 'escape', text: '', ...base };
  }
  if (code === 8 || code === 127) {
    return { kind: 'backspace', text: '', ...base };
  }
  // Printable code point. Control-modified letters (Ctrl+C) are handled by Ink's
  // own parser, so only surface real text here.
  const text = code >= 32 ? String.fromCodePoint(code) : '';
  return { kind: 'text', text, ...base };
}

/**
 * Parse a modified-key escape out of a `useInput` string. Returns undefined for
 * anything that isn't one (ordinary keys and text pass through untouched). Ink
 * strips at most one leading ESC, so we accept both with and without it.
 */
export function decodeKeySequence(input: string): DecodedKey | undefined {
  const s = input.charCodeAt(0) === 27 ? input.slice(1) : input;
  const other = MODIFY_OTHER_KEYS.exec(s);
  if (other) {
    return fromCode(Number(other[2]), Number(other[1]));
  }
  const csiU = CSI_U.exec(s);
  if (csiU) {
    return fromCode(Number(csiU[1]), csiU[2] === undefined ? 1 : Number(csiU[2]));
  }
  return undefined;
}
