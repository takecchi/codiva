import { Box, useApp, useWindowSize } from 'ink';
import { type FC, useMemo, useRef, useState } from 'react';
import {
  type CodivaConfig,
  messages as catalogs,
  DEFAULT_ONLY_MODEL_OPTIONS,
  isFullscreenViewport,
  type Messages,
  type ModelOption,
  mergeConfig,
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
   * Codex のモデルカタログ取得（`codex debug models`）。Claude とは選べるモデルが
   * まったく別なので、`/model` はセッションを駆動しているエージェントに応じて
   * こちらを出す。未注入なら「デフォルト」1 行だけになる。
   */
  codexModelCatalog?: Promise<readonly ModelOption[]>;
  /**
   * Grok のモデルカタログ取得（`grok agent stdio` の `initialize`）。Codex と同じく
   * Claude とは別のモデル群なので、駆動中のエージェントで出し分ける。
   */
  grokModelCatalog?: Promise<readonly ModelOption[]>;
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
  /**
   * 起動時に読んだ設定（`/config` の初期表示）。表示用の最新値はここで state に持つ
   * — 一覧はビュー切替でアンマウントされるので、あちらに置くと戻るたびに巻き戻る。
   */
  config?: CodivaConfig;
  /**
   * `/config` の変更差分を永続化する（`main.tsx` の `ConfigStore`）。未注入なら
   * 画面上だけ変わって保存されない（テスト用）。
   */
  onConfigChange?: (patch: Partial<CodivaConfig>) => void;
}> = ({
  manager,
  cwd,
  model,
  version,
  // 既定は ja。main.tsx が解決済みカタログを注入する。
  messages = catalogs.ja,
  modelCatalog,
  codexModelCatalog,
  grokModelCatalog,
  trainingOptIn,
  updater,
  loadBranch,
  onOpenUrl,
  onCopy,
  config: initialConfig,
  onConfigChange,
}) => {
  const { exit } = useApp();
  const models = useModelCatalog(modelCatalog);
  // 取得に失敗しても Claude のモデル名を Codex の選択肢に出さない（別物なので）。
  const codexModels = useModelCatalog(codexModelCatalog, DEFAULT_ONLY_MODEL_OPTIONS);
  // 取得に失敗しても Claude のモデル名を Grok の選択肢に出さない（別物なので）。
  const grokModels = useModelCatalog(grokModelCatalog, DEFAULT_ONLY_MODEL_OPTIONS);
  /**
   * エージェントごとの `/model` の選択肢。**表で持つ**ことで、provider が増えても
   * ビュー側の分岐（`agent === 'codex' ? ... : ...`）を増やさずに済む。
   * 未登録のエージェントは Claude 側のカタログ（`models`）へフォールバックする。
   */
  const modelsByAgent = useMemo(
    () => ({ codex: codexModels, grok: grokModels }),
    [codexModels, grokModels],
  );
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
  // `/config` が触る設定。差分を畳んで持ち（`mergeConfig`）、同じ差分を親（合成ルート）へ
  // 渡して保存させる。永続化側は `/model` や `/agent` の変更も混ざった最新値を持つので、
  // ここでは全体ではなく**差分**を上げるのが要点（互いの変更を消し合わないため）。
  const [config, setConfig] = useState<CodivaConfig>(initialConfig ?? {});
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
            modelsByAgent={modelsByAgent}
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
            modelsByAgent={modelsByAgent}
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
            config={config}
            onConfigChange={(patch) => {
              setConfig((prev) => mergeConfig(prev, patch));
              onConfigChange?.(patch);
            }}
          />
        )}
      </Box>
    </MessagesProvider>
  );
};
