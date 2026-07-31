import { stripLeadingEscape } from './ansi';

/**
 * SGR mouse-report parsing (pure). With `\x1b[?1002h` + `\x1b[?1006h` enabled,
 * the terminal reports button events as `ESC [ < b ; x ; y (M|m)`. Ink strips at
 * most one leading ESC before handing the sequence to `useInput`, so the input
 * seen by views is usually `[<0;12;5M` — we accept both with and without ESC.
 *
 * `?1002` (button-event tracking) additionally reports pointer *motion while a
 * button is held* (a drag) — the button code has bit 32 set. We surface those as
 * `drag` so a view can extend a text selection between press and release. (Under
 * `?1000` these never occur; recognizing them still matters so a stray motion
 * report is swallowed by the view rather than leaking in as literal text.)
 */
export type MouseEvent =
  | { kind: 'press'; x: number; y: number }
  | { kind: 'release'; x: number; y: number }
  | { kind: 'drag'; x: number; y: number }
  | { kind: 'wheel'; dir: 'up' | 'down'; x: number; y: number };

const SGR_MOUSE = /^\[<(\d+);(\d+);(\d+)([Mm])$/;

/**
 * Parse an SGR mouse report out of a `useInput` string. Returns undefined for
 * anything that isn't one (ordinary keys pass through untouched). Coordinates
 * are converted to 0-based terminal cells.
 */
export function parseSgrMouse(input: string): MouseEvent | undefined {
  const s = stripLeadingEscape(input);
  const m = SGR_MOUSE.exec(s);
  if (!m) {
    return undefined;
  }
  const button = Number(m[1]);
  const x = Number(m[2]) - 1;
  const y = Number(m[3]) - 1;
  // Wheel notches (bit 64) can also carry the motion bit on some terminals, so
  // test wheel first — a scroll must never be mistaken for a drag.
  if (button & 64) {
    return { kind: 'wheel', dir: (button & 1) === 0 ? 'up' : 'down', x, y };
  }
  if (button & 32) {
    // Button-held motion (a drag) under ?1002 — used to extend a selection.
    return { kind: 'drag', x, y };
  }
  return { kind: m[4] === 'M' ? 'press' : 'release', x, y };
}

/**
 * ランタイムでマウスレポートを有効/無効に切り替えるためのハンドル（実装は I/O を
 * 伴うため `utils/mouse.ts` の `createMouseControl`）。core にはインターフェースだけ
 * 置き、UI は `@/core` の型として受け取る（ui → utils の逆流を避ける）。
 *
 * 用途: 起動時に有効化し、終了時（+ クラッシュ時の保険）に無効化して端末を元へ戻す。
 * **画面ごとに切り替えることはしない** — 一覧も詳細も捕捉したままアプリ側で選択を扱い、
 * 切替えの境界で端末が送り残したレポート断片が入力欄へ流れ込むのを避ける。
 */
export interface MouseControl {
  /** マウスレポートを有効化（冪等）。 */
  enable(): void;
  /** マウスレポートを無効化（冪等）。端末のドラッグ選択が可能になる。 */
  disable(): void;
}
