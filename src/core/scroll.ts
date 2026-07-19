import type { LogEntry } from './types';

/**
 * Where the detail-view log viewport is anchored.
 * - `'bottom'`: follow the newest line (tail). New entries auto-scroll into view.
 * - a number: an absolute *exclusive* end index, frozen so that appended entries
 *   don't shift a scrolled-up view (top-anchored scrollback).
 *
 * The terminal's own scrollback is disabled under the alt screen (see
 * `utils/alt-screen.ts`), so this is the only way to revisit older log lines.
 */
export type ScrollAnchor = 'bottom' | number;

export interface LogWindow {
  /** The entries to render (bottom-aligned in the viewport). */
  entries: LogEntry[];
  /** Entries older than the window (>0 ⇒ there is scrollback above). */
  hiddenAbove: number;
  /** Entries newer than the window (>0 ⇒ not following the tail). */
  hiddenBelow: number;
  /** True when anchored to the newest entry (tail-follow). */
  atBottom: boolean;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/** How many entries a PageUp/PageDown moves — a comfortable half-viewport chunk. */
export function pageStep(rows: number): number {
  return Math.max(1, Math.floor(Math.max(1, rows) / 2));
}

/**
 * The `rows` value passed to {@link scrollUp}/{@link scrollDown} for a single
 * mouse-wheel tick. `pageStep` halves it, so this yields ~3 lines per tick — a
 * fine-grained step (terminals emit several wheel reports per physical scroll),
 * distinct from PageUp/PageDown's half-viewport jump.
 */
export const WHEEL_SCROLL_ROWS = 6;

/**
 * Resolve an anchor into a concrete window over `messages`. At most ~`rows`
 * entries are rendered (Ink would otherwise render the whole, possibly huge, log);
 * the flex-end viewport clips any that don't fit. `end` is driven precisely by the
 * anchor while `start` is just "enough to fill", so a scrolled-up view is stable as
 * new entries append.
 */
export function logWindow(messages: LogEntry[], rows: number, anchor: ScrollAnchor): LogWindow {
  const n = messages.length;
  const cap = Math.max(1, rows);
  const end = anchor === 'bottom' ? n : clamp(anchor, Math.min(1, n), n);
  const start = Math.max(0, end - cap);
  return {
    entries: messages.slice(start, end),
    hiddenAbove: start,
    hiddenBelow: n - end,
    atBottom: end >= n,
  };
}

/** New anchor after PageUp (toward older entries). Never lands back on the tail. */
export function scrollUp(anchor: ScrollAnchor, total: number, rows: number): ScrollAnchor {
  if (total <= 1) {
    return 'bottom';
  }
  const end = anchor === 'bottom' ? total : Math.min(anchor, total);
  const next = Math.max(1, end - pageStep(rows));
  return next >= total ? 'bottom' : next;
}

/** New anchor after PageDown (toward newer entries); snaps to `'bottom'` at the end. */
export function scrollDown(anchor: ScrollAnchor, total: number, rows: number): ScrollAnchor {
  if (anchor === 'bottom') {
    return 'bottom';
  }
  const next = anchor + pageStep(rows);
  return next >= total ? 'bottom' : next;
}
