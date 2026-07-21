import { isFullscreenViewport, type MouseControl, type SessionManager } from '@/core';
import { createMouseControl, enterAltScreen } from '@/utils';

/** 端末セットアップの結果。`mouse` は詳細ビューが出入りで捕捉を切替えるのに使う。 */
export interface TerminalSetup {
  /**
   * マウスレポートのコントローラ（起動時に有効化済み）。マウスが使えない環境
   * （非 TTY / 低解像度 / 設定で無効）では undefined。詳細ビューはこれがあるときだけ
   * 一時的に disable してネイティブのテキスト選択を許す。
   */
  mouse?: MouseControl;
  /** 通常バッファへ戻す（マウス無効化 + alt screen 退出）。 */
  teardown: () => void;
}

/**
 * Enter the alt screen (disabling scrollback) and, on a fullscreen TTY, mouse
 * reporting. Returns a mouse control handle plus a teardown that restores the
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
    mouse,
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
