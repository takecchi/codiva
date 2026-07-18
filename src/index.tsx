import { query } from '@anthropic-ai/claude-agent-sdk';
import { render } from 'ink';
import {
  messages,
  notificationFor,
  resolveLang,
  SessionManager,
  type SessionState,
  WorktreeManager,
} from '@/core';
import {
  defaultStatePath,
  loadConfig,
  loadState,
  notify,
  pruneMissingWorktrees,
  saveState,
  saveStateSync,
} from '@/utils';
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

  // Notifications default on; disable with `"notifications": false` in config.
  const notifyOnTransition =
    config.notifications === false
      ? undefined
      : (prev: SessionState, next: SessionState) => {
          const spec = notificationFor(prev, next, t);
          if (spec) {
            notify(spec);
          }
        };

  // Persist the restore state to <repo>/.codiva/state.json, debounced so a burst
  // of streaming updates writes at most once per window.
  const statePath = defaultStatePath(repoRoot);
  let persistTimer: ReturnType<typeof setTimeout> | undefined;
  const schedulePersist = () => {
    if (persistTimer) {
      clearTimeout(persistTimer);
    }
    persistTimer = setTimeout(() => {
      void saveState(manager.persistableState(), statePath).catch(() => undefined);
    }, 500);
  };

  const manager = new SessionManager({
    worktrees,
    queryFn: query,
    options: {
      model: config.model,
      effort: config.effort,
      permissionMode: config.permissionMode,
      maxBudgetUsd: config.maxBudgetUsd,
    },
    onTransition: notifyOnTransition,
    onPersist: schedulePersist,
  });

  // Restore sessions from a previous run (worktrees that still exist on disk).
  manager.restore(pruneMissingWorktrees(await loadState(statePath)));

  // Flush synchronously on hard termination (kill / terminal close), where the
  // debounced async save wouldn't run before the process dies. Ctrl+C is handled
  // by the App (dispose → exit → final flush below), so we only cover SIGTERM/SIGHUP.
  const flushSyncAndExit = (code: number) => () => {
    try {
      saveStateSync(manager.persistableState(), statePath);
    } catch {
      // best-effort — never block shutdown on a failed save
    }
    process.exit(code);
  };
  process.once('SIGTERM', flushSyncAndExit(143));
  process.once('SIGHUP', flushSyncAndExit(129));

  const { waitUntilExit } = render(<App manager={manager} cwd={repoRoot} messages={t} />, {
    exitOnCtrlC: false,
  });
  await waitUntilExit();

  // Flush the final state on quit. dispose() used stop() (not abort()), so
  // in-flight sessions are still recorded as resumable here.
  if (persistTimer) {
    clearTimeout(persistTimer);
  }
  await saveState(manager.persistableState(), statePath).catch(() => undefined);

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
