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
  defaultStatePath,
  fetchModelCatalog,
  fetchUsageSnapshot,
  loadConfig,
  loadRepoPrompt,
  openUrl,
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
const pkg = createRequire(import.meta.url)('../package.json') as { version?: string };
const appVersion = pkg.version;

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
  const worktrees = new WorktreeManager(repoRoot, {
    ignoredFiles: resolveIgnoredFilesMode(config),
  });
  try {
    await worktrees.preflight();
  } catch (err) {
    process.stderr.write(`codiva: ${errorMessage(err)}\n`);
    process.exit(1);
  }

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
  });

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
      onOpenPr={openUrl}
      onCopy={(text) => copyToClipboard(text)}
      // 詳細ビューを開いている間だけマウス捕捉を解除し、端末ネイティブの
      // ドラッグ選択（コピペ）を可能にするためのハンドル。
      mouse={terminal.mouse}
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
  await persist.flushAsync();
  terminal.teardown();
}

await main();
