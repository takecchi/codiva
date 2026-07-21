import { bufferLines } from './text-buffer';

/**
 * A normalized text selection over a buffer's `value`: a half-open range of
 * caret indices (UTF-16 units, the same unit as `TextBuffer.cursor`). `start` is
 * always ≤ `end`, so the anchor/focus order the user dragged in is irrelevant.
 * An empty range (start === end) is not represented — see `normalizeSelection`.
 */
export interface SelectionRange {
  readonly start: number;
  readonly end: number;
}

/**
 * Build a normalized selection from an anchor (where a drag began) and a focus
 * (where it is now / ended). Returns undefined when nothing is actually selected
 * (a plain click, or a drag that never left the anchor cell) so callers can treat
 * "no selection" as one case.
 */
export function normalizeSelection(anchor: number, focus: number): SelectionRange | undefined {
  const start = Math.min(anchor, focus);
  const end = Math.max(anchor, focus);
  return end > start ? { start, end } : undefined;
}

/** The selected substring of `value`. */
export function selectionText(value: string, range: SelectionRange): string {
  return value.slice(range.start, range.end);
}

/**
 * The char offsets `[from, to)` within line `row` (0-based, split on '\n') that
 * fall inside `range`, for painting a per-line highlight. Returns undefined when
 * the line has no selected characters (including a fully-selected empty line — a
 * blank line spanned by a multi-line selection has nothing visible to highlight).
 * Offsets are into that line's string, so the UI can `slice` it directly.
 */
export function lineSelection(
  value: string,
  range: SelectionRange,
  row: number,
): { from: number; to: number } | undefined {
  const lines = bufferLines(value);
  if (row < 0 || row >= lines.length) {
    return undefined;
  }
  // Absolute index of this line's first char in `value` (+1 per preceding '\n').
  let lineStart = 0;
  for (let i = 0; i < row; i += 1) {
    lineStart += (lines[i] ?? '').length + 1;
  }
  const lineLen = (lines[row] ?? '').length;
  const from = Math.max(0, Math.min(lineLen, range.start - lineStart));
  const to = Math.max(0, Math.min(lineLen, range.end - lineStart));
  return to > from ? { from, to } : undefined;
}
