import type { CrashKind, SessionManager } from '@/core';
import { isFullscreenViewport } from '@/core';
import {
  createMouseControl,
  disableMouseReports,
  enterAltScreen,
  resetTerminalModes,
} from '@/utils';

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
  if (!useAltScreen) {
    // Inline rendering sets no terminal mode, so it must not write escapes either
    // (stdout may be a pipe, where they would corrupt the output).
    return { teardown: () => undefined };
  }
  // Heal a terminal left in mouse-reporting mode by a previous run that died hard
  // (an OOM abort or SIGKILL skips `process.on('exit')`, so its teardown never
  // ran). Without this, scrolling keeps injecting `\x1b[<64;…M` as input.
  disableMouseReports(process.stdout);
  const leaveAltScreen = enterAltScreen(process.stdout);
  // Mouse coordinates only match the output origin under the alt-screen fullscreen.
  const mouse = mouseEnabled ? createMouseControl(process.stdout) : undefined;
  mouse?.enable();
  return {
    teardown: () => {
      mouse?.disable();
      leaveAltScreen();
      // Belt and braces: one sequence that clears every mode we could have set
      // (including ones an aborted previous run may have left behind). Idempotent,
      // so it is safe after the individual teardowns above.
      resetTerminalModes(process.stdout);
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
 *
 * `record` (optional) notes the signal in the crash log, so a session that
 * "just vanished" can be told apart from a real crash afterwards. The terminal
 * itself is restored by the `process.on('exit')` hooks that `toggleEscape`
 * installs, which `process.exit()` below still runs.
 */
export function installHardExitFlush(
  flushSync: () => void,
  record?: (kind: CrashKind, summary: string) => void,
): void {
  const handler = (signal: string, code: number) => () => {
    flushSync();
    record?.('signal', `terminated by ${signal}`);
    process.exit(code);
  };
  process.once('SIGTERM', handler('SIGTERM', 143));
  process.once('SIGHUP', handler('SIGHUP', 129));
}
