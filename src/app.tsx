import { Box, useApp, useWindowSize } from 'ink';
import { type FC, useRef, useState } from 'react';
import {
  messages as catalogs,
  isFullscreenViewport,
  type Messages,
  type ModelOption,
  type SessionManager,
  type TrainingOptIn,
  type UpdateService,
} from '@/core';
import {
  type ListViewState,
  MessagesProvider,
  SessionDetail,
  SessionList,
  useBranch,
  useModelCatalog,
  useTrainingOptIn,
  useUpdateCheck,
} from '@/ui';

/** どの画面を出しているか。詳細は対象セッション id を持つ。 */
type View = { mode: 'list' } | { mode: 'detail'; id: string };

export const App: FC<{
  manager: SessionManager;
  cwd?: string;
  model?: string;
  /** アプリのバージョン（package.json 由来）。ヘッダのワードマーク右に表示。 */
  version?: string;
  messages?: Messages;
  /**
   * Claude Code のモデルカタログ取得（`/model` の選択肢）。合成ルートが render 前に
   * 開始した Promise をそのまま受ける。両ビューが使うためここで state に解決して
   * props で配る（一覧・詳細のどちらからでも `/model` を開けるため）。
   */
  modelCatalog?: Promise<readonly ModelOption[]>;
  /**
   * 学習データ利用（claude.ai の「Help improve our AI models」）の判定。合成ルートが
   * render 前に開始した Promise をそのまま受け、解決したら一覧のバナーに注意行を出す
   * （`'on'` のときだけ）。設定 `privacyWarning: false` では未指定になる。
   */
  trainingOptIn?: Promise<TrainingOptIn>;
  /**
   * アップデート機能（npm レジストリの確認と `npm install` の実行）。合成ルートが
   * 注入する。`initial` は起動時に投げたチェックで、ここで state に解決してバナーへ
   * 渡す（一覧が再マウントされても再取得しない）。未注入なら通知も /update も無害に
   * 何もしない。
   */
  updater?: UpdateService;
  /**
   * 対象リポジトリの現在ブランチを読む（`WorktreeManager.currentBranch()`）。ヘッダ表示
   * だけに使うので、失敗・detached HEAD は undefined で構わない。codiva の外でも切り替わる
   * ため定期的に読み直す（`useBranch`）。値をここで持つのはビュー切替で失わないため、
   * 取得を一覧のときだけに絞るのは詳細ビューで無駄なプロセスを立てないため。
   */
  loadBranch?: () => Promise<string | undefined>;
  /**
   * URL をブラウザで開く（main.tsx が `openUrl` を注入。fire-and-forget）。
   * 一覧の PR セルのクリックと、詳細ログ内の URL のクリックが共有する。
   */
  onOpenUrl?: (url: string) => void;
  /** Copy a mouse selection (composer / header / detail log) to the clipboard (OSC 52). */
  onCopy?: (text: string) => void;
}> = ({
  manager,
  cwd,
  model,
  version,
  // 既定は ja。main.tsx が解決済みカタログを注入する。
  messages = catalogs.ja,
  modelCatalog,
  trainingOptIn,
  updater,
  loadBranch,
  onOpenUrl,
  onCopy,
}) => {
  const { exit } = useApp();
  const models = useModelCatalog(modelCatalog);
  const training = useTrainingOptIn(trainingOptIn);
  const { info: updateInfo, clear: clearUpdateInfo } = useUpdateCheck(updater?.initial);
  const [view, setView] = useState<View>({ mode: 'list' });
  // 現在ブランチはここで持つ（一覧はビュー切替でアンマウントされるので、あちらで持つと
  // 詳細から戻った 1 フレームだけブランチが消え、そのたびに git を呼び直す）。ただし
  // **ヘッダを描いていない詳細ビューの間は取得を止める**（誰も読まない値のために 5 秒ごとに
  // git のプロセスを立てない）。値はこのフックに残るので、戻った瞬間から前の値が出て、
  // 同時に 1 回だけ読み直される。
  const branch = useBranch(view.mode === 'list' ? loadBranch : undefined);
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
            models={models}
            onBack={() => setView({ mode: 'list' })}
            onCopy={onCopy}
            onOpenUrl={onOpenUrl}
          />
        ) : (
          <SessionList
            manager={manager}
            onOpen={(id) => setView({ mode: 'detail', id })}
            onOpenPr={onOpenUrl}
            onQuit={quit}
            cwd={cwd}
            branch={branch}
            model={model}
            models={models}
            version={version}
            updateInfo={updateInfo}
            updater={updater}
            onUpdateApplied={clearUpdateInfo}
            initialViewState={listStateRef.current}
            onViewStateChange={(state) => {
              listStateRef.current = state;
            }}
            onCopy={onCopy}
            trainingOptIn={training}
          />
        )}
      </Box>
    </MessagesProvider>
  );
};
