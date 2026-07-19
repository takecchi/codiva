import { Box, useApp, useInput, useWindowSize } from 'ink';
import { type FC, useState } from 'react';
import {
  messages as catalogs,
  isFullscreenViewport,
  type Messages,
  type SessionManager,
} from '@/core';
import { MessagesProvider, SessionDetail, SessionList } from '@/ui';

/** どの画面を出しているか。詳細は対象セッション id を持つ。 */
type View = { mode: 'list' } | { mode: 'detail'; id: string };

export const App: FC<{ manager: SessionManager; cwd?: string; messages?: Messages }> = ({
  manager,
  cwd,
  // 既定は ja。index.tsx が解決済みカタログを注入する。
  messages = catalogs.ja,
}) => {
  const { exit } = useApp();
  const [view, setView] = useState<View>({ mode: 'list' });
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

  return (
    <MessagesProvider value={messages}>
      <Box
        flexDirection="column"
        height={fullscreen ? rows : undefined}
        overflow={fullscreen ? 'hidden' : undefined}
      >
        {view.mode === 'detail' ? (
          <SessionDetail manager={manager} id={view.id} onBack={() => setView({ mode: 'list' })} />
        ) : (
          <SessionList
            manager={manager}
            onOpen={(id) => setView({ mode: 'detail', id })}
            onQuit={quit}
            cwd={cwd}
          />
        )}
      </Box>
    </MessagesProvider>
  );
};
