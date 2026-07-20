import { createRequire } from 'node:module';
import { render } from 'ink';
import {
  errorMessage,
  messages,
  resolveIgnoredFilesMode,
  resolveLang,
  type SessionManager,
} from '@/core';
import { defaultStatePath, loadConfig, loadRepoPrompt, openUrl, WorktreeManager } from '@/utils';
import { App } from './app';
import {
  buildManager,
  createPersistController,
  installHardExitFlush,
  restoreSessions,
  setupTerminal,
  startPrPolling,
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

  await restoreSessions(manager, statePath);
  const stopPrPolling = startPrPolling(manager);
  installHardExitFlush(persist.flushSync);
  const restoreTerminal = setupTerminal(config.mouse !== false);

  const { waitUntilExit } = render(
    <App
      manager={manager}
      cwd={repoRoot}
      model={config.model}
      version={appVersion}
      messages={t}
      onOpenPr={openUrl}
    />,
    { exitOnCtrlC: false },
  );
  await waitUntilExit();

  // Shutdown: stop polling, flush the final state (dispose() used stop() not
  // abort(), so in-flight sessions are still recorded as resumable), restore the
  // terminal (leave alt screen + mouse) so the shell history is intact.
  stopPrPolling();
  await persist.flushAsync();
  restoreTerminal();
}

await main();
