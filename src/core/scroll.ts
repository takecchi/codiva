import stringWidth from 'string-width';
import { GRAPHEMES } from './graphemes';
import { type RichLine, type RichSpan, renderMarkdown } from './markdown';
import { clamp } from './math';
import type { LogEntry, LogKind } from './types';
import { detectUrls, type LinkRange, linksInSlice, mergeLinks, spanLinks } from './url';

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
  /**
   * この行の中のクリックできる URL の範囲（`text` に対する文字オフセット。prefix /
   * 字下げを含む位置）。undefined = リンク無し（大多数の行）。
   *
   * 出所は 2 つで、Markdown の `[label](url)` は `RichSpan.link`（表示テキストから
   * 復元できないため）、それ以外の裸の URL は `detectUrls`。**折り返しで URL が
   * 割れても各行が URL 全体を指す**ので、どちらの行をクリックしても同じ先へ飛べる。
   */
  links?: readonly LinkRange[];
}

/** LogKinds whose text is Markdown from the assistant and gets rich rendering. */
const MARKDOWN_KINDS: Partial<Record<LogKind, boolean>> = { assistant_text: true };

/**
 * Wrap `text` to physical lines of at most `width` display cells, splitting on
 * embedded newlines first. Widths are display-based (`string-width`): CJK and
 * emoji count as 2 cells, so Japanese text wraps where the terminal actually
 * breaks — `.length` would drift by up to 2×. Wrapping is per grapheme (no
 * word-boundary logic), which matches how a terminal hard-wraps.
 */
export function wrapDisplayLines(text: string, width: number): string[] {
  const out: string[] = [];
  for (const logical of text.split(LINE_BREAK)) {
    for (const row of wrapLogical(logical, width)) {
      out.push(row);
    }
  }
  return out;
}

/** 改行の並び。`wrapDisplayLines` と `entryLines` が同じ分割を使うため定数にしてある。 */
const LINE_BREAK = /\r\n|[\r\n\v\f]/;

/**
 * 改行を含まない 1 論理行を物理行へ折り返す。{@link wrapDisplayLines} の中身で、
 * 別関数にしてあるのは `entryLines` が**論理行単位で**回す必要があるため — URL の
 * 検出は論理行に対して行い（折り返しで割れた半分は URL として解析できない）、
 * その範囲を各物理行の座標へ移す。
 */
function wrapLogical(logical: string, width: number): string[] {
  if (width <= 0 || stringWidth(logical) <= width) {
    return [logical];
  }
  const out: string[] = [];
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
  return out;
}

function sameRichStyle(a: RichSpan, b: RichSpan): boolean {
  return (
    a.bold === b.bold &&
    a.italic === b.italic &&
    a.dim === b.dim &&
    a.underline === b.underline &&
    a.strikethrough === b.strikethrough &&
    a.tone === b.tone &&
    // link も比較する: 隣り合う別リンク（`[a](x)[b](y)`）を 1 スパンに畳むと
    // どちらの URL で開くのか決まらなくなる。
    a.link === b.link
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
 * 折り返し後の 1 行のリンク範囲。`bare` は**論理行**に対して検出した範囲で、
 * `[consumed, consumed + rowLen)` の部分を行内の座標（先頭に `leadLen` 文字の
 * prefix / 字下げが付く）へ移す。`spans` 由来（Markdown の href）を優先し、
 * 重なる裸 URL は捨てる。
 */
function rowLinks(
  spans: readonly RichSpan[] | undefined,
  bare: readonly LinkRange[],
  consumed: number,
  rowLen: number,
  leadLen: number,
): readonly LinkRange[] | undefined {
  const fromBare = bare.length > 0 ? linksInSlice(bare, consumed, consumed + rowLen, leadLen) : [];
  // spans のオフセットは lead を含んだ行テキスト基準なので、そのまま使える。
  const fromSpans = spans ? spanLinks(spans) : [];
  const links = fromSpans.length > 0 ? mergeLinks(fromSpans, fromBare) : fromBare;
  return links.length > 0 ? links : undefined;
}

/** Expand one entry into its physical rows (see {@link logLines}). */
function entryLines(entry: LogEntry, width: number, prefix: string): DisplayLine[] {
  const out: DisplayLine[] = [];
  const indent = ' '.repeat(stringWidth(prefix));
  const content = Math.max(1, width - stringWidth(prefix));

  const rich = MARKDOWN_KINDS[entry.kind] ? safeRenderMarkdown(entry.text) : undefined;
  if (rich) {
    let i = 0;
    for (const line of rich) {
      // 裸 URL の検出は論理行に対して行う（折り返しで割れた半分は URL にならない）。
      // Markdown の autolink はここでは href 付きスパンになっているので、これは
      // コードブロック等で href が付かない URL の受け皿。
      const bare = detectUrls(line.map((s) => s.text).join(''));
      let consumed = 0;
      for (const rowSpans of wrapRichLine(line, content)) {
        const lead = i === 0 ? prefix : indent;
        const spans = lead ? [{ text: lead } as RichSpan, ...rowSpans] : rowSpans;
        const rowLen = rowSpans.reduce((n, s) => n + s.text.length, 0);
        out.push({
          key: `${entry.seq}:${i}`,
          kind: entry.kind,
          text: spans.map((s) => s.text).join(''),
          spans,
          links: rowLinks(spans, bare, consumed, rowLen, lead.length),
        });
        consumed += rowLen;
        i += 1;
      }
    }
    return out;
  }

  let i = 0;
  for (const logical of entry.text.split(LINE_BREAK)) {
    const bare = detectUrls(logical);
    let consumed = 0;
    for (const row of wrapLogical(logical, content)) {
      const lead = i === 0 ? prefix : indent;
      out.push({
        key: `${entry.seq}:${i}`,
        kind: entry.kind,
        text: lead + row,
        links: rowLinks(undefined, bare, consumed, row.length, lead.length),
      });
      consumed += row.length;
      i += 1;
    }
  }
  return out;
}

interface CachedRows {
  width: number;
  prefix: string;
  rows: DisplayLine[];
  /** Which {@link logLines} call last used these rows (LRU + no-thrash marker). */
  pass: number;
}

/**
 * Rows the memo cache may keep across calls. Rendered rows are **far** heavier
 * than the text they came from (a row holds its plain text *and* its styled
 * spans), so an unbounded cache would just move the leak: every entry ever
 * rendered would keep its rows for the session's whole life, across every
 * session whose detail view was opened.
 *
 * This is a soft budget — rows used by the call in progress are never evicted
 * (see {@link logLines}), otherwise a log that is itself larger than the budget
 * would evict rows it is about to need and re-expand everything on every frame.
 * So the true bound is "one rendered log (bounded by `MAX_LOG_CHARS`) + this".
 */
export const MAX_CACHED_ROWS = 8_000;

/**
 * Per-entry row cache. Log entries are immutable (the reducer replaces the object
 * on any change), so the rows an entry expanded to last time are still correct as
 * long as the wrap width and its prefix are the same.
 *
 * Why this is worth a cache: the detail view re-derives its rows whenever
 * `messages` changes — i.e. on *every* appended line — and without memoization
 * each append re-wrapped (and re-parsed the Markdown of) the whole log. That is
 * O(n²) work and, more importantly, O(n) fresh objects per line: a long session
 * allocated the entire rendered log dozens of times a second, which is how codiva
 * hit V8's heap limit.
 *
 * A `Map` (not a `WeakMap`) because eviction needs insertion order = recency.
 * It therefore keeps its keys alive, which is exactly why the budget above
 * exists: entries dropped by the log cap are released on eviction.
 */
const ENTRY_ROWS = new Map<LogEntry, CachedRows>();
let cachedRowCount = 0;
let currentPass = 0;

/** Rows for one entry, from the cache when they are still valid. */
function cachedEntryLines(entry: LogEntry, width: number, prefix: string): DisplayLine[] {
  const hit = ENTRY_ROWS.get(entry);
  if (hit && hit.width === width && hit.prefix === prefix) {
    hit.pass = currentPass;
    // Re-insert so Map iteration order stays least-recently-used first.
    ENTRY_ROWS.delete(entry);
    ENTRY_ROWS.set(entry, hit);
    return hit.rows;
  }
  const rows = entryLines(entry, width, prefix);
  if (hit) {
    cachedRowCount -= hit.rows.length;
    ENTRY_ROWS.delete(entry);
  }
  ENTRY_ROWS.set(entry, { width, prefix, rows, pass: currentPass });
  cachedRowCount += rows.length;
  for (const [key, value] of ENTRY_ROWS) {
    if (cachedRowCount <= MAX_CACHED_ROWS) {
      break;
    }
    if (value.pass === currentPass) {
      continue; // in use by the render in progress — evicting it would thrash
    }
    ENTRY_ROWS.delete(key);
    cachedRowCount -= value.rows.length;
  }
  return rows;
}

/** Drop every memoized row. Exported for tests (the cache is process-global). */
export function clearLogLinesCache(): void {
  ENTRY_ROWS.clear();
  cachedRowCount = 0;
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
 *
 * Memoized per entry (see {@link ENTRY_ROWS}) — the output is the same value the
 * unmemoized version produced, but appending a line only costs that one line.
 * Rows must therefore be treated as read-only by callers.
 */
export function logLines(
  messages: readonly LogEntry[],
  width: number,
  prefixFor: (kind: LogKind) => string,
): DisplayLine[] {
  currentPass += 1;
  const out: DisplayLine[] = [];
  for (const entry of messages) {
    // Appended one at a time on purpose: `push(...rows)` passes every row as an
    // argument, which overflows the stack for an entry that wrapped into tens of
    // thousands of rows (a narrow terminal + a pasted file).
    for (const row of cachedEntryLines(entry, width, prefixFor(entry.kind))) {
      out.push(row);
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
 * Lines moved per ↑/↓ press — also the step of the detail view's drag auto-scroll
 * (one row per tick). Where mouse reporting is off (`"mouse": false`, non-TTY) the
 * terminal translates the wheel into arrow keys under the alt screen (alternate
 * scroll mode), so this doubles as the wheel step there.
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
