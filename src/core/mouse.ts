/**
 * SGR mouse-report parsing (pure). With `\x1b[?1000h` + `\x1b[?1006h` enabled,
 * the terminal reports button events as `ESC [ < b ; x ; y (M|m)`. Ink strips at
 * most one leading ESC before handing the sequence to `useInput`, so the input
 * seen by views is usually `[<0;12;5M` — we accept both with and without ESC.
 */
export type MouseEvent =
  | { kind: 'press'; x: number; y: number }
  | { kind: 'release'; x: number; y: number }
  | { kind: 'wheel'; dir: 'up' | 'down'; x: number; y: number };

const SGR_MOUSE = /^\[<(\d+);(\d+);(\d+)([Mm])$/;

/**
 * Parse an SGR mouse report out of a `useInput` string. Returns undefined for
 * anything that isn't one (ordinary keys pass through untouched). Coordinates
 * are converted to 0-based terminal cells.
 */
export function parseSgrMouse(input: string): MouseEvent | undefined {
  const s = input.charCodeAt(0) === 27 ? input.slice(1) : input;
  const m = SGR_MOUSE.exec(s);
  if (!m) {
    return undefined;
  }
  const button = Number(m[1]);
  const x = Number(m[2]) - 1;
  const y = Number(m[3]) - 1;
  if (button & 32) {
    // Motion reports (not requested in button-event mode) — ignore defensively.
    return undefined;
  }
  if (button & 64) {
    return { kind: 'wheel', dir: (button & 1) === 0 ? 'up' : 'down', x, y };
  }
  return { kind: m[4] === 'M' ? 'press' : 'release', x, y };
}
