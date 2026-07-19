import { execFile } from 'node:child_process';
import { platform as osPlatform } from 'node:os';

/**
 * Build the OS command that opens `url` in the default browser, or undefined on
 * an unsupported platform. Kept pure (platform passed in) so it can be
 * unit-tested. The URL is always passed as argv — never spliced into a shell
 * string — so it can't be interpreted.
 */
export function openUrlCommand(
  url: string,
  platform: NodeJS.Platform,
): { file: string; args: string[] } | undefined {
  switch (platform) {
    case 'darwin':
      return { file: 'open', args: [url] };
    case 'win32':
      // The empty "" is start's window-title argument; the URL follows as argv.
      return { file: 'cmd', args: ['/c', 'start', '', url] };
    case 'linux':
      return { file: 'xdg-open', args: [url] };
    default:
      return undefined;
  }
}

/**
 * Best-effort: open `url` in the default browser. Fire-and-forget — any failure
 * (missing opener binary, headless session) is swallowed so opening a PR never
 * disrupts the TUI or crashes the app.
 */
export function openUrl(url: string): void {
  const cmd = openUrlCommand(url, osPlatform());
  if (!cmd) {
    return;
  }
  try {
    execFile(cmd.file, cmd.args, () => {
      // Ignore all errors and output — opening a browser is never load-bearing.
    });
  } catch {
    // execFile can throw synchronously on some argument errors; stay silent.
  }
}
