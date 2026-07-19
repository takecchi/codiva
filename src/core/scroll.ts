import stringWidth from 'string-width';
import type { LogEntry, LogKind } from './types';

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

export interface LogWindow<T = LogEntry> {
  /** The lines to render (bottom-aligned in the viewport). */
  entries: T[];
  /** Lines older than the window (>0 ⇒ there is scrollback above). */
  hiddenAbove: number;
  /** Lines newer than the window (>0 ⇒ not following the tail). */
  hiddenBelow: number;
  /** True when anchored to the newest line (tail-follow). */
  atBottom: boolean;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/**
 * One physical terminal row of the detail-view log. Entries are expanded into
 * these by {@link logLines} — the scroll model works in physical rows, not log
 * entries, so multi-line messages neither fill the viewport with a single entry
 * nor break the PgUp/wheel step math. `text` already includes the kind's prefix
 * (first row) or its matching indent (continuation rows); `kind` drives color.
 */
export interface DisplayLine {
  /** Stable render key: `<entry seq>:<row index within the entry>`. */
  key: string;
  kind: LogKind;
  text: string;
}

const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/**
 * Wrap `text` to physical lines of at most `width` display cells, splitting on
 * embedded newlines first. Widths are display-based (`string-width`): CJK and
 * emoji count as 2 cells, so Japanese text wraps where the terminal actually
 * breaks — `.length` would drift by up to 2×. Wrapping is per grapheme (no
 * word-boundary logic), which matches how a terminal hard-wraps.
 */
export function wrapDisplayLines(text: string, width: number): string[] {
  const out: string[] = [];
  for (const logical of text.split(/\r\n|[\r\n\v\f]/)) {
    if (width <= 0 || stringWidth(logical) <= width) {
      out.push(logical);
      continue;
    }
    let line = '';
    let w = 0;
    for (const { segment } of GRAPHEMES.segment(logical)) {
      const cw = stringWidth(segment);
      if (w + cw > width && line.length > 0) {
        out.push(line);
        line = segment;
        w = cw;
      } else {
        line += segment;
        w += cw;
      }
    }
    out.push(line);
  }
  return out;
}

/**
 * Expand log entries into the physical rows the detail view renders. The
 * per-kind prefix comes from the UI (it owns glyphs/colors); continuation rows
 * are indented by the prefix's display width so wrapped text stays aligned.
 */
export function logLines(
  messages: LogEntry[],
  width: number,
  prefixFor: (kind: LogKind) => string,
): DisplayLine[] {
  const out: DisplayLine[] = [];
  for (const entry of messages) {
    const prefix = prefixFor(entry.kind);
    const indent = ' '.repeat(stringWidth(prefix));
    const rows = wrapDisplayLines(entry.text, Math.max(1, width - stringWidth(prefix)));
    for (let i = 0; i < rows.length; i += 1) {
      out.push({
        key: `${entry.seq}:${i}`,
        kind: entry.kind,
        text: (i === 0 ? prefix : indent) + rows[i],
      });
    }
  }
  return out;
}

/** How many lines a PageUp/PageDown moves — a comfortable half-viewport chunk. */
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
 * Resolve an anchor into a concrete window over `lines` (physical display rows —
 * see {@link logLines}). At most ~`rows` lines are rendered (Ink would otherwise
 * render the whole, possibly huge, log); the flex-end viewport clips any that
 * don't fit. `end` is driven precisely by the anchor while `start` is just
 * "enough to fill", so a scrolled-up view is stable as new lines append.
 */
export function logWindow<T>(
  lines: readonly T[],
  rows: number,
  anchor: ScrollAnchor,
): LogWindow<T> {
  const n = lines.length;
  const cap = Math.max(1, rows);
  const end = anchor === 'bottom' ? n : clamp(anchor, Math.min(1, n), n);
  const start = Math.max(0, end - cap);
  return {
    entries: lines.slice(start, end),
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
