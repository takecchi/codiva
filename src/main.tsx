import { createRequire } from 'node:module';
import { render } from 'ink';
import {
  DEFAULT_AGENT_ORDER,
  errorMessage,
  formatMemoryUsage,
  messages,
  parseCliArgs,
  resolveDefaultAgentId,
  resolveIgnoredFilesMode,
  resolveLang,
  type SessionManager,
  summarizeStatuses,
} from '@/core';
import {
  claudeQuery,
  copyToClipboard,
  createUpdateService,
  defaultLogDir,
  defaultStatePath,
  detectInstallKind,
  enableFatalErrorReports,
  fetchCodexModelCatalog,
  fetchModelCatalog,
  fetchTrainingOptIn,
  fetchUsageSnapshot,
  loadConfig,
  loadRepoPrompt,
  openUrl,
  packageRootFrom,
  resetTerminalModes,
  WorktreeManager,
  writeCrashLogSync,
} from '@/utils';
import { App } from './app';
import {
  buildManager,
  createConfigStore,
  createPersistController,
  type Diagnostic,
  installCrashHandlers,
  installHardExitFlush,
  restoreSessions,
  setupTerminal,
  startPerfTimelineCleanup,
  startPrPolling,
  startUsagePolling,
  type TerminalSetup,
} from './bootstrap';

// バージョンは package.json を唯一の出所にする。合成ルート（src/main.tsx / dist/main-<hash>.js）
// から見た相対位置は dev/ビルド後どちらも `../package.json` なので createRequire で読む。
const pkg = createRequire(import.meta.url)('../package.json') as {
  name?: string;
  version?: string;
};
const appVersion = pkg.version;
const appName = pkg.name;

async function main(): Promise<void> {
  // 表示言語を決定: CODIVA_LANG > 設定ファイル(~/.codiva/config.json) > OS ロケール。
  const config = await loadConfig();
  const t =
    messages[
      resolveLang({
        env: process.env.CODIVA_LANG,
        config: config.language,
        locale: process.env.LC_ALL ?? process.env.LC_MESSAGES ?? process.env.LANG,
      })
    ];

  // 保守用フラグ `--reset-terminal`: 端末モード（マウス捕捉・代替スクリーン・カーソル）を
  // 戻すだけで終了する。強制終了（OOM の abort / SIGKILL）で codiva が死ぬと
  // `process.on('exit')` すら走らずマウスレポートが残り、スクロールが大量の文字入力に
  // 化けるため、その脱出口。git リポジトリ判定より前に処理する（どこでも実行できるべき）。
  if (parseCliArgs(process.argv.slice(2)).kind === 'reset-terminal') {
    resetTerminalModes(process.stdout);
    process.stdout.write(`${t.crash.resetDone}\n`);
    return;
  }

  const repoRoot = process.cwd();
  // `.gitignore` された node_modules/.env 等は git worktree に引き継がれないため、
  // 既定でリポジトリルートへシンボリックリンクを張る（設定 `"ignoredFiles"`: 'symlink' |
  // 'copy' | 'none' で切替。非推奨の `copyIgnored` も後方互換で解釈する）。
  // ビルド生成物・キャッシュは既定で引き継がない（設定 `"ignoredFilesExclude"` で調整）。
  const worktrees = new WorktreeManager(repoRoot, {
    ignoredFiles: resolveIgnoredFilesMode(config),
    ignoredFilesExclude: config.ignoredFilesExclude,
  });
  try {
    await worktrees.preflight();
  } catch (err) {
    process.stderr.write(`codiva: ${errorMessage(err)}\n`);
    process.exit(1);
  }
  // `.codiva/` を git から隠す（中身が `*` だけの `.codiva/.gitignore`）。セッションを 1 つも
  // 作らなくても `.codiva/state.json` / `prompt.md` は書かれるので、worktree 作成時ではなく
  // 起動時に置く。best-effort で起動は止めない。
  await worktrees.ensureIgnored().catch(() => undefined);
  // 以前のバージョン（あるいは前回の設定）が張った「もう引き継がないパス」のリンクを外す。
  // 残っていると生成物の共有＝開発サーバのフリーズ要因も残るため（issue #81）。リンクだけを
  // 外すので指し先は無傷。best-effort で起動は止めない。
  await worktrees.pruneExcludedLinks().catch(() => undefined);

  // Persist controller reads the manager lazily, so it can be created first and
  // wired as the manager's onPersist dirty signal.
  const statePath = defaultStatePath(repoRoot);
  let manager: SessionManager;
  const persist = createPersistController(() => manager.persistableState(), statePath);
  // リポジトリ固有の追加指示（`.codiva/prompt.md`）を全セッションの systemPrompt に載せる。
  const appendSystemPrompt = await loadRepoPrompt(repoRoot);
  // 設定ファイルの書き手はここ 1 つに集約する（`/model` `/agent` `/config` が
  // それぞれ起動時のスナップショットで丸ごと上書きすると互いの変更を消すため）。
  const configStore = createConfigStore(config);
  manager = buildManager({
    repoRoot,
    config,
    messages: t,
    worktrees,
    onPersist: persist.schedule,
    appendSystemPrompt,
    saveConfigPatch: (patch) => {
      configStore.update(patch);
    },
  });

  // クラッシュ時の後始末を配線する。alt screen のまま死ぬと例外の内容が画面ごと消え、
  // ユーザーには「突然ターミナルに戻った」としか見えない（そのうえマウスレポートが
  // 残って入力が壊れる）。ハンドラは (1) 端末を戻し (2) 状態を flush し (3) 理由を
  // 通常バッファへ出し (4) `~/.codiva/logs/` にレポートを残す。
  const crashLogEnabled = config.crashLog !== false;
  const logDir = defaultLogDir();
  if (crashLogEnabled) {
    // V8 のヒープ枯渇（OOM）やネイティブのクラッシュは JS に通知が来ないため、
    // C++ 層が abort 前に書く Node の診断レポートだけが証拠を残せる。
    enableFatalErrorReports(logDir);
  }
  const diagnostics = (): readonly Diagnostic[] => [
    ['codiva', appVersion ?? 'unknown'],
    ['node', process.version],
    ['platform', `${process.platform} ${process.arch}`],
    ['terminal', `${process.env.TERM ?? '-'} / ${process.env.TERM_PROGRAM ?? '-'}`],
    [
      'viewport',
      `${process.stdout.columns ?? 0}x${process.stdout.rows ?? 0} tty=${process.stdout.isTTY === true}`,
    ],
    ['uptime', `${Math.round(process.uptime())}s`],
    ['memory', formatMemoryUsage(process.memoryUsage())],
    ['sessions', summarizeStatuses(manager.getSnapshot().map((session) => session.status))],
  ];
  let terminal: TerminalSetup | undefined;
  const crash = installCrashHandlers({
    messages: t,
    restore: () => terminal?.teardown(),
    flush: persist.flushSync,
    diagnostics,
    write: crashLogEnabled
      ? (report, at) => writeCrashLogSync(report, { at, dir: logDir })
      : undefined,
  });

  // `/model` の選択肢は Claude Code のカタログを唯一の出所にする（直書きしない）。
  // 起動をブロックしないよう await せずに投げておき、App 側で state に解決する。
  // 実測 0.3〜2 秒で、`/model` を開くまでにはほぼ確実に landing する（間に合わなければ
  // ダイアログが取得中を表示する）。失敗してもフォールバック一覧に落ちるだけで起動は
  // 妨げない（fetchModelCatalog は throw しない）。
  // 終了時に取得を打ち切るためのハンドル（取得中に /exit されたときサブプロセスと
  // タイマーを残さない = シェルのプロンプトが返らない事故を防ぐ）。
  const probeAbort = new AbortController();
  const modelCatalog = fetchModelCatalog(claudeQuery, {
    cwd: repoRoot,
    signal: probeAbort.signal,
  });
  // Codex 側の選択肢（`codex debug models`）。ローカルのカタログを読むだけで推論は
  // 走らず、`codex` が入っていなければ空配列になる（`/model` は「デフォルト」のみ）。
  const codexModelCatalog = fetchCodexModelCatalog({
    cwd: repoRoot,
    signal: probeAbort.signal,
  });

  // プラン（Pro / Max / Team …）と使用リミット枠をステータスバーに出すための取得。
  // `rate_limit_event` はセッションがターンを回している間しか届かないので、待機中も
  // 表示を保つために定期ポーリングで補う（1回ごとに短命な probe サブプロセスを
  // 1本。推論は走らないのでトークン消費は無い）。取れない環境では自動で止まる。
  const stopUsagePolling = startUsagePolling({
    fetch: () => fetchUsageSnapshot(claudeQuery, { cwd: repoRoot, signal: probeAbort.signal }),
    apply: (snapshot) => manager.applyUsage(snapshot),
    // カタログ取得の後にずらす（どちらも probe サブプロセスを立てるので、起動直後に
    // 2本同時に走らせない）。失敗しても取得は行う。
    after: modelCatalog,
  });

  // 学習データ利用（claude.ai の「Help improve our AI models」）が ON なら一覧に注意行を
  // 出す。ここも await せずに投げておき（キャッシュヒットなら即答、問い合わせに落ちても
  // 数百 ms）、解決したらバナーに反映される。設定 `privacyWarning: false` なら判定自体を
  // 走らせない（Keychain もネットワークも触らない）。
  const privacyAbort = new AbortController();
  const trainingOptIn =
    config.privacyWarning === false
      ? undefined
      : fetchTrainingOptIn({ signal: privacyAbort.signal });
  // アップデート通知。起動ごとに npm レジストリの `latest` を 1 回だけ問い合わせる
  // （await しないので起動はブロックしない。3 秒でタイムアウトし、失敗しても throw
  // しない）。設定 `"updateCheck": false` で通信を完全に止められる。
  // インストール経路はここで 1 回だけ判定する（判定不能なら codiva は `npm install`
  // を実行せず、手動コマンドの提示だけに留める）。
  const updateAbort = new AbortController();
  const updatePackageRoot = packageRootFrom(import.meta.url);
  const updater =
    config.updateCheck !== false && appName !== undefined && appVersion !== undefined
      ? createUpdateService({
          pkg: appName,
          current: appVersion,
          packageRoot: updatePackageRoot,
          install: detectInstallKind(updatePackageRoot),
          signal: updateAbort.signal,
        })
      : undefined;

  // 登録エージェントの導入・ログイン状態を検出する（`/agent` とセットアップ案内が読む）。
  // await しない（サブプロセスを数本起こすだけで起動はブロックしない）。設定 `agent` が
  // 無いときは、検出が済み次第「導入済みのもの」を新規セッションの既定に寄せる
  // （永続化はしない = ユーザーが選んでいない値を config へ書かない）。
  void manager
    .checkAgents()
    .then((availability) => {
      if (config.agent === undefined) {
        const pick = resolveDefaultAgentId(
          undefined,
          manager.listAgents().map((a) => a.id),
          availability,
          DEFAULT_AGENT_ORDER,
        );
        if (pick) {
          manager.setDefaultAgent(pick, { persist: false });
        }
      }
    })
    .catch(() => undefined);

  await restoreSessions(manager, statePath);
  const stopPrPolling = startPrPolling(manager);
  // React の dev ビルドが積む user timing を溜め込まないための保険（本筋は
  // `src/index.tsx` が production ビルドを選ばせること）。
  const stopPerfCleanup = startPerfTimelineCleanup();
  // シグナルで殺されたときも記録する（クラッシュと「kill された」の切り分けに使う）。
  installHardExitFlush(persist.flushSync, crash.record);
  terminal = setupTerminal(config.mouse !== false);

  const { waitUntilExit } = render(
    <App
      manager={manager}
      cwd={repoRoot}
      model={config.model}
      version={appVersion}
      messages={t}
      modelCatalog={modelCatalog}
      codexModelCatalog={codexModelCatalog}
      trainingOptIn={trainingOptIn}
      updater={updater}
      loadBranch={() => worktrees.currentBranch()}
      onOpenUrl={openUrl}
      onCopy={(text) => copyToClipboard(text)}
      config={config}
      onConfigChange={(patch) => {
        configStore.update(patch);
      }}
    />,
    { exitOnCtrlC: false },
  );
  await waitUntilExit();

  // Shutdown: stop polling, flush the final state (dispose() used stop() not
  // abort(), so in-flight sessions are still recorded as resumable), restore the
  // terminal (leave alt screen + mouse) so the shell history is intact.
  stopPrPolling();
  stopUsagePolling();
  stopPerfCleanup();
  probeAbort.abort();
  privacyAbort.abort();
  updateAbort.abort();
  await persist.flushAsync();
  // 直前の `/config` / `/model` が書き込み中のまま終了しないように待つ（reject しない）。
  await configStore.flush();
  terminal.teardown();
  // 後片付け（flush 含む）が終わってから外す。先に外すと shutdown 中の例外だけ
  // 記録が残らない。
  crash.uninstall();
}

await main();
