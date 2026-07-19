import { Box, useApp, useWindowSize } from 'ink';
import { type FC, useRef, useState } from 'react';
import {
  messages as catalogs,
  isFullscreenViewport,
  type Messages,
  type SessionManager,
} from '@/core';
import { type ListViewState, MessagesProvider, SessionDetail, SessionList } from '@/ui';

/** どの画面を出しているか。詳細は対象セッション id を持つ。 */
type View = { mode: 'list' } | { mode: 'detail'; id: string };

export const App: FC<{
  manager: SessionManager;
  cwd?: string;
  model?: string;
  /** アプリのバージョン（package.json 由来）。ヘッダのワードマーク右に表示。 */
  version?: string;
  messages?: Messages;
  /** Open a PR URL in the browser. Injected from index.tsx (fire-and-forget). */
  onOpenPr?: (url: string) => void;
}> = ({
  manager,
  cwd,
  model,
  version,
  // 既定は ja。index.tsx が解決済みカタログを注入する。
  messages = catalogs.ja,
  onOpenPr,
}) => {
  const { exit } = useApp();
  const [view, setView] = useState<View>({ mode: 'list' });
  // 一覧はビュー切替でアンマウントされ内部 state（選択行・フォーカス）が失われる。
  // 詳細から戻ったときに「前見ていた箇所」を復元できるよう、最新の表示状態をここに
  // 保持し、再マウント時の初期値として渡す（選択行 = スクロール状態なので一緒に戻る）。
  const listStateRef = useRef<ListViewState | undefined>(undefined);
  // Ink はコンテンツの高さぶんしか描画しない（インラインレンダラ）ため、端末の
  // 行数を root に明示して全画面（web の 100dvh 相当）にする。リサイズにも追従。
  // overflow="hidden" は保険: フレームが端末高さを超えると Ink が全画面クリアに
  // フォールバックしてちらつくので、超過分は必ずクリップする。
  // ただし端末が極端に低いと固定部分（バナー+入力欄+フッタ）だけで rows を超え、
  // クリップすると操作不能になるため、その場合はインライン描画へフォールバックする。
  const { rows } = useWindowSize();
  const fullscreen = isFullscreenViewport(rows);

  // 終了は `/exit` コマンド経由のみ。Ctrl+C では終了しない（render は
  // exitOnCtrlC: false で構成し、Ctrl+C 用のグローバルハンドラも持たない）。
  const quit = () => {
    manager.dispose();
    exit();
  };

  return (
    <MessagesProvider value={messages}>
      <Box
        flexDirection="column"
        height={fullscreen ? rows : undefined}
        overflow={fullscreen ? 'hidden' : undefined}
      >
        {view.mode === 'detail' ? (
          <SessionDetail
            manager={manager}
            id={view.id}
            onBack={() => setView({ mode: 'list' })}
            onQuit={quit}
          />
        ) : (
          <SessionList
            manager={manager}
            onOpen={(id) => setView({ mode: 'detail', id })}
            onOpenPr={onOpenPr}
            onQuit={quit}
            cwd={cwd}
            model={model}
            version={version}
            initialViewState={listStateRef.current}
            onViewStateChange={(state) => {
              listStateRef.current = state;
            }}
          />
        )}
      </Box>
    </MessagesProvider>
  );
};
