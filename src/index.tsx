import { query } from '@anthropic-ai/claude-agent-sdk';
import { render } from 'ink';
import { messages, resolveLang, SessionManager, WorktreeManager } from '@/core';
import { loadConfig } from '@/utils';
import { App } from './app';

async function main(): Promise<void> {
  // 表示言語を決定: CODIVA_LANG > 設定ファイル(~/.codiva/config.json) > OS ロケール。
  const config = await loadConfig();
  const lang = resolveLang({
    env: process.env.CODIVA_LANG,
    config: config.language,
    locale: process.env.LC_ALL ?? process.env.LC_MESSAGES ?? process.env.LANG,
  });
  const t = messages[lang];

  const repoRoot = process.cwd();
  const worktrees = new WorktreeManager(repoRoot);

  try {
    await worktrees.preflight();
  } catch (err) {
    process.stderr.write(`codiva: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }

  const manager = new SessionManager({
    worktrees,
    queryFn: query,
  });

  const { waitUntilExit } = render(<App manager={manager} cwd={repoRoot} messages={t} />, {
    exitOnCtrlC: false,
  });
  await waitUntilExit();

  // Sessions are aborted on quit but their worktrees are intentionally kept so
  // no work is lost. Tell the user where they are.
  const remaining = manager.activeWorktreePaths();
  if (remaining.length > 0) {
    process.stdout.write(`\n${t.app.remainingWorktrees(remaining.length)}\n`);
    for (const path of remaining) {
      process.stdout.write(`  ${path}\n`);
    }
  }
}

await main();
