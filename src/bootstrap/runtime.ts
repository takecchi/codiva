import { isFullscreenViewport, type SessionManager } from '@/core';
import { createMouseControl, enterAltScreen } from '@/utils';

/**
 * 端末セットアップの結果。マウス捕捉は**起動から終了まで有効のまま**にする（一覧・詳細の
 * どちらもクリック/ドラッグ選択に使うため、画面ごとに切替えない）。端末ネイティブの選択が
 * 必要なときは Shift+ドラッグ、恒久的に外すなら設定 `"mouse": false`。
 */
export interface TerminalSetup {
  /** 通常バッファへ戻す（マウス無効化 + alt screen 退出）。 */
  teardown: () => void;
}

/**
 * Enter the alt screen (disabling scrollback) and, on a fullscreen TTY, mouse
 * reporting. Returns a teardown that restores the
 * normal buffer. Low/non-TTY terminals fall back to inline rendering, so nothing
 * is entered. Decided once at startup (switching buffers on a mid-run resize
 * would corrupt the screen).
 */
export function setupTerminal(mouseEnabled: boolean): TerminalSetup {
  const useAltScreen = process.stdout.isTTY && isFullscreenViewport(process.stdout.rows ?? 0);
  const leaveAltScreen = useAltScreen ? enterAltScreen(process.stdout) : undefined;
  // Mouse coordinates only match the output origin under the alt-screen fullscreen.
  const mouse = useAltScreen && mouseEnabled ? createMouseControl(process.stdout) : undefined;
  mouse?.enable();
  return {
    teardown: () => {
      mouse?.disable();
      leaveAltScreen?.();
    },
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
