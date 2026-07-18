import { query } from '@anthropic-ai/claude-agent-sdk';
import { render } from 'ink';
import { SessionManager, WorktreeManager } from '@/core';
import { App } from './app';

async function main(): Promise<void> {
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

  const { waitUntilExit } = render(<App manager={manager} />, { exitOnCtrlC: false });
  await waitUntilExit();

  // Sessions are aborted on quit but their worktrees are intentionally kept so
  // no work is lost. Tell the user where they are.
  const remaining = manager.activeWorktreePaths();
  if (remaining.length > 0) {
    process.stdout.write(
      `\ncodiva: ${remaining.length} 個の worktree が残っています（作業内容は保持されます）:\n`,
    );
    for (const path of remaining) {
      process.stdout.write(`  ${path}\n`);
    }
  }
}

await main();
