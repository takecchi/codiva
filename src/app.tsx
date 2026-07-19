import { Box, useApp, useInput, useWindowSize } from 'ink';
import type { FC } from 'react';
import {
  messages as catalogs,
  isFullscreenViewport,
  type Messages,
  type SessionManager,
} from '@/core';
import { MessagesProvider, SessionList } from '@/ui';

/**
 * Runs the claude CLI for a session while the TUI is suspended. Injected from
 * the composition root (index.tsx wraps alt-screen/mouse teardown around the
 * spawn); tests inject a fake. When omitted, opening in claude is disabled.
 */
export type ExternalRunner = (args: {
  cwd: string;
  sessionId: string;
}) => Promise<{ ok: boolean; error?: string }>;

export const App: FC<{
  manager: SessionManager;
  cwd?: string;
  model?: string;
  messages?: Messages;
  runExternal?: ExternalRunner;
  /** Open a PR URL in the browser. Injected from index.tsx (fire-and-forget). */
  onOpenPr?: (url: string) => void;
}> = ({
  manager,
  cwd,
  model,
  // 既定は ja。index.tsx が解決済みカタログを注入する。
  messages = catalogs.ja,
  runExternal,
  onOpenPr,
}) => {
  const { exit, suspendTerminal } = useApp();
  // Ink はコンテンツの高さぶんしか描画しない（インラインレンダラ）ため、端末の
  // 行数を root に明示して全画面（web の 100dvh 相当）にする。リサイズにも追従。
  // overflow="hidden" は保険: フレームが端末高さを超えると Ink が全画面クリアに
  // フォールバックしてちらつくので、超過分は必ずクリップする。
  // ただし端末が極端に低いと固定部分（バナー+入力欄+フッタ）だけで rows を超え、
  // クリップすると操作不能になるため、その場合はインライン描画へフォールバックする。
  const { rows } = useWindowSize();
  const fullscreen = isFullscreenViewport(rows);

  const quit = () => {
    manager.dispose();
    exit();
  };

  // Global safety net for Ctrl+C (render is configured with exitOnCtrlC: false).
  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      quit();
    }
  });

  /**
   * Hand the session off to the interactive claude CLI: stop the codiva-side
   * query (single writer per SDK session), release the terminal to the child,
   * and pick the TUI back up when the user exits claude.
   */
  const openExternal = async (id: string): Promise<{ ok: boolean; error?: string }> => {
    const state = manager.getSnapshot().find((s) => s.id === id);
    const sessionId = state?.sdkSessionId;
    if (!state || !sessionId || !runExternal) {
      return { ok: false, error: messages.list.openNotReady };
    }
    manager.detach(id);
    let result: { ok: boolean; error?: string } = { ok: true };
    await suspendTerminal(async () => {
      result = await runExternal({ cwd: state.worktreePath, sessionId });
    });
    return result;
  };

  return (
    <MessagesProvider value={messages}>
      <Box
        flexDirection="column"
        height={fullscreen ? rows : undefined}
        overflow={fullscreen ? 'hidden' : undefined}
      >
        <SessionList
          manager={manager}
          onOpenExternal={runExternal ? openExternal : undefined}
          onOpenPr={onOpenPr}
          onQuit={quit}
          cwd={cwd}
          model={model}
        />
      </Box>
    </MessagesProvider>
  );
};
