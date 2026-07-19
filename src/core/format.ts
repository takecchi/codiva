/** Format elapsed time between `startedAt` and `end` (finishedAt or now) as `1m05s` / `42s`. */
export function formatElapsed(startedAt: number, end: number): string {
  const secs = Math.max(0, Math.floor((end - startedAt) / 1000));
  const mins = Math.floor(secs / 60);
  if (mins === 0) {
    return `${secs}s`;
  }
  return `${mins}m${String(secs % 60).padStart(2, '0')}s`;
}
