/** Format a duration in ms as `1m05s` / `42s`. Negative inputs clamp to `0s`. */
export function formatDuration(ms: number): string {
  const secs = Math.max(0, Math.floor(ms / 1000));
  const mins = Math.floor(secs / 60);
  if (mins === 0) {
    return `${secs}s`;
  }
  return `${mins}m${String(secs % 60).padStart(2, '0')}s`;
}
