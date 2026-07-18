import { execFile } from 'node:child_process';
import { platform as osPlatform } from 'node:os';
import type { NotificationSpec } from '@/core';

/**
 * Build the OS command that shows a desktop notification, or undefined if the
 * platform is unsupported. Kept pure (platform passed in) so it can be unit-tested.
 * Title/body are always passed as argv — never interpolated into a shell/script
 * string — so a session title can't inject anything.
 */
export function notifyCommand(
  spec: NotificationSpec,
  platform: NodeJS.Platform,
): { file: string; args: string[] } | undefined {
  switch (platform) {
    case 'darwin':
      // Read title/body from `argv` inside the AppleScript instead of splicing
      // them into the script text (osascript -e), which would be injectable.
      return {
        file: 'osascript',
        args: [
          '-e',
          'on run argv',
          '-e',
          'display notification (item 1 of argv) with title (item 2 of argv)',
          '-e',
          'end run',
          spec.body,
          spec.title,
        ],
      };
    case 'linux':
      return { file: 'notify-send', args: [spec.title, spec.body] };
    default:
      // Windows toast requires extra modules / injection-prone PowerShell; skip
      // it for now rather than ship untested code. Notifications are best-effort.
      return undefined;
  }
}

/**
 * Best-effort desktop notification. Fire-and-forget: any failure (missing binary,
 * headless session, no display server) is swallowed so notifications never disrupt
 * the TUI or crash the app.
 */
export function notify(spec: NotificationSpec): void {
  const cmd = notifyCommand(spec, osPlatform());
  if (!cmd) {
    return;
  }
  try {
    execFile(cmd.file, cmd.args, () => {
      // Ignore all errors and output — notifications must never be load-bearing.
    });
  } catch {
    // execFile can throw synchronously on some argument errors; stay silent.
  }
}
