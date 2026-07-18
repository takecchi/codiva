import type { Key } from 'ink';

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
    return value.length > 0
      ? { value: value.slice(0, -1), changed: true }
      : { value, changed: false };
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

/** Format elapsed time between startedAt and end (finishedAt or now). */
export function formatElapsed(startedAt: number, end: number): string {
  const secs = Math.max(0, Math.floor((end - startedAt) / 1000));
  const mins = Math.floor(secs / 60);
  if (mins === 0) {
    return `${secs}s`;
  }
  return `${mins}m${String(secs % 60).padStart(2, '0')}s`;
}
