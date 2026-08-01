import { createRequire } from 'node:module';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { render } from 'ink';
import {
  errorMessage,
  messages,
  resolveIgnoredFilesMode,
  resolveLang,
  type SessionManager,
} from '@/core';
import {
  copyToClipboard,
  createUpdateService,
  defaultStatePath,
  detectInstallKind,
  fetchModelCatalog,
  fetchTrainingOptIn,
  fetchUsageSnapshot,
  loadConfig,
  loadRepoPrompt,
  openUrl,
  packageRootFrom,
  WorktreeManager,
} from '@/utils';
import { App } from './app';
import {
  buildManager,
  createPersistController,
  installHardExitFlush,
  restoreSessions,
  setupTerminal,
  startPrPolling,
  startUsagePolling,
} from './bootstrap';

// バージョンは package.json を唯一の出所にする。エントリ（src/index.tsx / dist/index.js）
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
  manager = buildManager({
    repoRoot,
    config,
    messages: t,
    worktrees,
    onPersist: persist.schedule,
    appendSystemPrompt,
  });

  // `/model` の選択肢は Claude Code のカタログを唯一の出所にする（直書きしない）。
  // 起動をブロックしないよう await せずに投げておき、App 側で state に解決する。
  // 実測 0.3〜2 秒で、`/model` を開くまでにはほぼ確実に landing する（間に合わなければ
  // ダイアログが取得中を表示する）。失敗してもフォールバック一覧に落ちるだけで起動は
  // 妨げない（fetchModelCatalog は throw しない）。
  // 終了時に取得を打ち切るためのハンドル（取得中に /exit されたときサブプロセスと
  // タイマーを残さない = シェルのプロンプトが返らない事故を防ぐ）。
  const probeAbort = new AbortController();
  const modelCatalog = fetchModelCatalog(query, {
    cwd: repoRoot,
    signal: probeAbort.signal,
  });

  // プラン（Pro / Max / Team …）と使用リミット枠をステータスバーに出すための取得。
  // `rate_limit_event` はセッションがターンを回している間しか届かないので、待機中も
  // 表示を保つために定期ポーリングで補う（1回ごとに短命な probe サブプロセスを
  // 1本。推論は走らないのでトークン消費は無い）。取れない環境では自動で止まる。
  const stopUsagePolling = startUsagePolling({
    fetch: () => fetchUsageSnapshot(query, { cwd: repoRoot, signal: probeAbort.signal }),
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

  await restoreSessions(manager, statePath);
  const stopPrPolling = startPrPolling(manager);
  installHardExitFlush(persist.flushSync);
  const terminal = setupTerminal(config.mouse !== false);

  const { waitUntilExit } = render(
    <App
      manager={manager}
      cwd={repoRoot}
      model={config.model}
      version={appVersion}
      messages={t}
      modelCatalog={modelCatalog}
      trainingOptIn={trainingOptIn}
      updater={updater}
      onOpenPr={openUrl}
      onCopy={(text) => copyToClipboard(text)}
    />,
    { exitOnCtrlC: false },
  );
  await waitUntilExit();

  // Shutdown: stop polling, flush the final state (dispose() used stop() not
  // abort(), so in-flight sessions are still recorded as resumable), restore the
  // terminal (leave alt screen + mouse) so the shell history is intact.
  stopPrPolling();
  stopUsagePolling();
  probeAbort.abort();
  privacyAbort.abort();
  updateAbort.abort();
  await persist.flushAsync();
  terminal.teardown();
}

await main();
