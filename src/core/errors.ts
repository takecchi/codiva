/** A display string for an unknown catch value — the Error message, else String(). */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The stack trace of an unknown catch value, following the `cause` chain so a
 * wrapped error still shows where it actually came from (crash reports are the
 * only record of a crash we get — see `core/crash.ts`). Non-Errors have no
 * stack; a stackless Error falls back to `name: message` so the report is never
 * empty. The chain is capped to keep a self-referential cause from looping.
 */
export function errorStack(err: unknown): string | undefined {
  if (!(err instanceof Error)) {
    return undefined;
  }
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = err;
  while (current instanceof Error && !seen.has(current) && parts.length < 5) {
    seen.add(current);
    parts.push(current.stack ?? `${current.name}: ${current.message}`);
    current = current.cause;
  }
  return parts.join('\ncaused by: ');
}
