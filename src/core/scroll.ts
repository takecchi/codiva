import stringWidth from 'string-width';
import { type RichLine, type RichSpan, renderMarkdown } from './markdown';
import { clamp } from './math';
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

/**
 * The live-typing preview line: the last non-empty line of the streamed text so
 * far. The detail view shows just this one line while a turn streams in.
 */
export function streamTail(text: string): string {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (line && line.length > 0) {
      return line;
    }
  }
  return '';
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
  /**
   * Styled segments for this row, present only when the entry was rendered from
   * Markdown (see {@link logLines}). When set, the UI paints these spans (bold /
   * code / heading color …) instead of the flat single-color `text`.
   */
  spans?: RichSpan[];
}

/** LogKinds whose text is Markdown from the assistant and gets rich rendering. */
const MARKDOWN_KINDS: Partial<Record<LogKind, boolean>> = { assistant_text: true };

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

function sameRichStyle(a: RichSpan, b: RichSpan): boolean {
  return (
    a.bold === b.bold &&
    a.italic === b.italic &&
    a.dim === b.dim &&
    a.underline === b.underline &&
    a.strikethrough === b.strikethrough &&
    a.tone === b.tone
  );
}

/**
 * Wrap one styled logical line to physical rows of at most `width` display cells,
 * preserving each grapheme's styling. The styled analogue of
 * {@link wrapDisplayLines}: same CJK-aware, per-grapheme measuring, but it packs
 * {@link RichSpan}s instead of a plain string. Adjacent graphemes with identical
 * styling are coalesced back into one span. An empty input yields one empty row.
 */
export function wrapRichLine(spans: readonly RichSpan[], width: number): RichSpan[][] {
  const rows: RichSpan[][] = [];
  let row: RichSpan[] = [];
  let w = 0;
  const flush = (): void => {
    rows.push(row);
    row = [];
    w = 0;
  };
  const push = (segment: string, style: RichSpan): void => {
    const last = row[row.length - 1];
    if (last && sameRichStyle(last, style)) {
      last.text += segment;
    } else {
      row.push({ ...style, text: segment });
    }
  };
  for (const span of spans) {
    const style: RichSpan = { ...span, text: '' };
    for (const { segment } of GRAPHEMES.segment(span.text)) {
      const cw = stringWidth(segment);
      if (width > 0 && w + cw > width && w > 0) {
        flush();
      }
      push(segment, style);
      w += cw;
    }
  }
  flush();
  return rows;
}

/** Parse Markdown into logical lines, falling back to `undefined` on any error. */
function safeRenderMarkdown(text: string): RichLine[] | undefined {
  try {
    const lines = renderMarkdown(text);
    return lines.length > 0 ? lines : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Expand log entries into the physical rows the detail view renders. The
 * per-kind prefix comes from the UI (it owns glyphs/colors); continuation rows
 * are indented by the prefix's display width so wrapped text stays aligned.
 *
 * Assistant text arrives as Markdown, so those entries ({@link MARKDOWN_KINDS})
 * are rendered to styled spans (bold/code/headings/lists) and each row carries
 * `spans`; every other kind keeps the flat single-color path. `text` is always
 * set (the concatenated plain text) so scroll math and the plain renderer work
 * unchanged.
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
    const content = Math.max(1, width - stringWidth(prefix));

    const rich = MARKDOWN_KINDS[entry.kind] ? safeRenderMarkdown(entry.text) : undefined;
    if (rich) {
      let i = 0;
      for (const line of rich) {
        for (const rowSpans of wrapRichLine(line, content)) {
          const lead = i === 0 ? prefix : indent;
          const spans = lead ? [{ text: lead } as RichSpan, ...rowSpans] : rowSpans;
          out.push({
            key: `${entry.seq}:${i}`,
            kind: entry.kind,
            text: spans.map((s) => s.text).join(''),
            spans,
          });
          i += 1;
        }
      }
      continue;
    }

    const rows = wrapDisplayLines(entry.text, content);
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
 * Lines moved per mouse-wheel notch. Fine-grained on purpose: terminals emit
 * several wheel reports for one physical scroll, so this stays distinct from
 * PageUp/PageDown's half-viewport jump.
 */
export const WHEEL_SCROLL_LINES = 3;

/**
 * Lines moved per ↑/↓ press. Under the alt screen with mouse capture released,
 * terminals translate the wheel into arrow keys (alternate scroll mode), so this
 * doubles as the wheel step in the detail view — one row at a time.
 */
export const ARROW_SCROLL_LINES = 1;

/**
 * Resolve an anchor into a concrete window over `lines` (physical display rows —
 * see {@link logLines}). `rows` is the viewport height: **never render more rows
 * than fit**. Yoga shrinks overflowing children rather than clipping them, so an
 * oversized window silently drops rows out of the middle of the log instead of
 * scrolling it (that is what made the detail log unreadable when scrolled up).
 *
 * `end` is driven precisely by the anchor, so a scrolled-up view is stable as new
 * lines append. It is floored at one full viewport: scrolling to the very top
 * shows a full page of the oldest lines instead of collapsing to a couple of rows
 * pinned to the bottom of an empty screen.
 */
export function logWindow<T>(
  lines: readonly T[],
  rows: number,
  anchor: ScrollAnchor,
): LogWindow<T> {
  const n = lines.length;
  const cap = Math.max(1, rows);
  const end = anchor === 'bottom' ? n : clamp(anchor, Math.min(cap, n), n);
  const start = Math.max(0, end - cap);
  return {
    entries: lines.slice(start, end),
    hiddenAbove: start,
    hiddenBelow: n - end,
    atBottom: end >= n,
  };
}

/**
 * New anchor after scrolling toward older lines. `rows` is the viewport height —
 * it bounds how far up the anchor may go (a full page always stays on screen,
 * matching {@link logWindow}) and supplies the default half-page `step`. Pass an
 * explicit `step` for finer gestures (wheel notch, ↑ key).
 */
export function scrollUp(
  anchor: ScrollAnchor,
  total: number,
  rows: number,
  step: number = pageStep(rows),
): ScrollAnchor {
  const cap = Math.max(1, rows);
  if (total <= cap) {
    return 'bottom'; // everything already fits — nothing to scroll back to
  }
  const end = anchor === 'bottom' ? total : Math.min(anchor, total);
  const next = Math.max(cap, end - Math.max(1, step));
  return next >= total ? 'bottom' : next;
}

/**
 * New anchor after scrolling toward newer lines; snaps to `'bottom'` at the end.
 * `rows`/`step` mirror {@link scrollUp}.
 */
export function scrollDown(
  anchor: ScrollAnchor,
  total: number,
  rows: number,
  step: number = pageStep(rows),
): ScrollAnchor {
  if (anchor === 'bottom') {
    return 'bottom';
  }
  const cap = Math.max(1, rows);
  const next = Math.max(cap, Math.min(anchor, total) + Math.max(1, step));
  return next >= total ? 'bottom' : next;
}
