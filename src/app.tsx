import { useApp, useInput } from 'ink';
import { type FC, useState } from 'react';
import { messages as catalogs, type Messages, type SessionManager } from '@/core';
import { MessagesProvider, SessionDetail, SessionList } from '@/ui';

type View = { mode: 'list' } | { mode: 'detail'; id: string };

export const App: FC<{ manager: SessionManager; cwd?: string; messages?: Messages }> = ({
  manager,
  cwd,
  // 既定は ja。index.tsx が解決済みカタログを注入する。
  messages = catalogs.ja,
}) => {
  const { exit } = useApp();
  const [view, setView] = useState<View>({ mode: 'list' });

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
    </MessagesProvider>
  );
};
