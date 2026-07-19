import { isFullscreenViewport, type SessionManager } from '@/core';
import { enableMouse, enterAltScreen } from '@/utils';

/**
 * Enter the alt screen (disabling scrollback) and, on a fullscreen TTY, mouse
 * reporting. Returns a teardown that restores the normal buffer. Low/non-TTY
 * terminals fall back to inline rendering, so nothing is entered. Decided once at
 * startup (switching buffers on a mid-run resize would corrupt the screen).
 */
export function setupTerminal(mouseEnabled: boolean): () => void {
  const useAltScreen = process.stdout.isTTY && isFullscreenViewport(process.stdout.rows ?? 0);
  const leaveAltScreen = useAltScreen ? enterAltScreen(process.stdout) : undefined;
  // Mouse coordinates only match the output origin under the alt-screen fullscreen.
  const disableMouse = useAltScreen && mouseEnabled ? enableMouse(process.stdout) : undefined;
  return () => {
    disableMouse?.();
    leaveAltScreen?.();
  };
}

/**
 * Poll each live session's branch for an open PR (once now, then every 20s). The
 * timer is unref'd so it never keeps the process alive. Returns a stop fn.
 */
export function startPrPolling(manager: SessionManager): () => void {
  void manager.refreshPrs();
  const timer = setInterval(() => {
    void manager.refreshPrs();
  }, 20_000);
  timer.unref?.();
  return () => clearInterval(timer);
}

/**
 * Flush the restore state synchronously on hard termination (kill / terminal
 * close), where the debounced async save wouldn't run before the process dies.
 * Normal exit goes through `/exit`; Ctrl+C is ignored, so only SIGTERM/SIGHUP.
 */
export function installHardExitFlush(flushSync: () => void): void {
  const handler = (code: number) => () => {
    flushSync();
    process.exit(code);
  };
  process.once('SIGTERM', handler(143));
  process.once('SIGHUP', handler(129));
}
