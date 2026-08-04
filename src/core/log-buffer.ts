import type { LogEntry } from './types';

/**
 * Bounds for the in-memory conversation log.
 *
 * Why this exists: `SessionState.messages` used to grow for the whole life of a
 * session with nothing ever trimming it, and every append copied the entire
 * array (`[...messages, entry]`), so a long session paid O(n²) allocations *and*
 * kept every byte it had ever logged. Combined with the detail view re-expanding
 * the full log on each append, that is how codiva reached V8's heap limit and
 * died with `FATAL ERROR: … JavaScript heap out of memory` (the process is
 * `abort()`ed, so not even the exit hooks run — see docs/TECH_NOTES.md).
 *
 * The log is a *view* of the conversation, not its record: the authoritative
 * history is the CLI transcript on disk (`core/transcript.ts`), so dropping the
 * oldest lines costs nothing that can't be read back from there.
 */

/**
 * How many log entries a session keeps. Older ones are dropped from the head.
 * Far more than the detail view can show (a viewport is a few dozen rows), so
 * scrollback still feels unlimited in practice.
 */
export const MAX_LOG_ENTRIES = 2000;

/**
 * Cap on a single entry's text. Sized so ordinary content is never touched
 * (~5k tokens of assistant prose) and only pathological entries are clipped:
 * a pasted file as a follow-up instruction, a `Bash` heredoc carrying a whole
 * file body, a stack trace dumped into an error result. One such entry can be
 * megabytes, and the detail view re-wraps (and Markdown-parses) whatever it
 * holds.
 */
export const MAX_LOG_ENTRY_CHARS = 20_000;

/**
 * Cap on the streamed "typing" preview. Only its last non-empty line is ever
 * rendered (`streamTail`), but the buffer used to hold a whole assistant message
 * and got re-split on every frame — so keep just the tail.
 */
export const MAX_STREAM_PREVIEW_CHARS = 4_000;

/** Marker appended to a clipped text so the log doesn't look silently complete. */
const CLIPPED_SUFFIX = ' …';

/**
 * Cut index for `text.slice(0, at)` that never splits a surrogate pair. Cutting
 * between the halves of an emoji (or any astral character) leaves a lone
 * surrogate, which the terminal draws as `�`.
 */
function safeCut(text: string, at: number): number {
  const code = text.charCodeAt(at - 1);
  // 0xD800–0xDBFF is a high surrogate: it belongs with the character after it.
  return code >= 0xd800 && code <= 0xdbff ? at - 1 : at;
}

/** Clip an entry's text to {@link MAX_LOG_ENTRY_CHARS}, marking it when cut. */
export function clipLogText(text: string): string {
  return text.length <= MAX_LOG_ENTRY_CHARS
    ? text
    : text.slice(0, safeCut(text, MAX_LOG_ENTRY_CHARS)) + CLIPPED_SUFFIX;
}

/** Keep only the tail of a streaming preview (see {@link MAX_STREAM_PREVIEW_CHARS}). */
export function clipStreamText(text: string): string {
  if (text.length <= MAX_STREAM_PREVIEW_CHARS) {
    return text;
  }
  const from = text.length - MAX_STREAM_PREVIEW_CHARS;
  // Drop a leading low surrogate (0xDC00–0xDFFF) whose partner was cut off.
  const code = text.charCodeAt(from);
  return text.slice(code >= 0xdc00 && code <= 0xdfff ? from + 1 : from);
}

/**
 * Append `entry` to a session's log, clipping its text and dropping the oldest
 * entries once {@link MAX_LOG_ENTRIES} is reached. The result is always a new
 * array (the state is immutable), but a bounded one — so the copy per append is
 * bounded too. `seq` numbering is untouched: it keeps counting up and stays the
 * render key / scroll identity of a line.
 */
export function pushLogEntry(messages: readonly LogEntry[], entry: LogEntry): LogEntry[] {
  const clipped =
    entry.text.length > MAX_LOG_ENTRY_CHARS ? { ...entry, text: clipLogText(entry.text) } : entry;
  const start = Math.max(0, messages.length + 1 - MAX_LOG_ENTRIES);
  return start === 0 ? [...messages, clipped] : [...messages.slice(start), clipped];
}

/**
 * Trim a rebuilt history (transcript restore) to the newest {@link MAX_LOG_ENTRIES}
 * entries, clipping oversized texts. Restoring a months-old transcript must not
 * put tens of MB back into the heap at launch.
 */
export function capLogEntries(entries: readonly LogEntry[]): LogEntry[] {
  const kept =
    entries.length > MAX_LOG_ENTRIES ? entries.slice(entries.length - MAX_LOG_ENTRIES) : entries;
  return kept.map((e) =>
    e.text.length > MAX_LOG_ENTRY_CHARS ? { ...e, text: clipLogText(e.text) } : e,
  );
}
