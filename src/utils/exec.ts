import { execFile } from 'node:child_process';

/**
 * Run a command fire-and-forget: ignore all output and never throw. Used for
 * best-effort side effects (desktop notifications, opening a URL) that must never
 * disrupt the TUI. execFile can also throw synchronously on some argument errors,
 * so the call is wrapped in try/catch.
 */
export function fireAndForget(file: string, args: string[]): void {
  try {
    execFile(file, args, () => {
      // Ignore all errors and output — this call is never load-bearing.
    });
  } catch {
    // execFile can throw synchronously on some argument errors; stay silent.
  }
}
