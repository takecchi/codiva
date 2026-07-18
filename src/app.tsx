import { useApp, useInput } from 'ink';
import { type FC, useState } from 'react';
import type { SessionManager } from '@/core';
import { SessionDetail, SessionList } from '@/ui';

type View = { mode: 'list' } | { mode: 'detail'; id: string };

export const App: FC<{ manager: SessionManager }> = ({ manager }) => {
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

  if (view.mode === 'detail') {
    return (
      <SessionDetail manager={manager} id={view.id} onBack={() => setView({ mode: 'list' })} />
    );
  }
  return (
    <SessionList manager={manager} onOpen={(id) => setView({ mode: 'detail', id })} onQuit={quit} />
  );
};
