import { query } from '@anthropic-ai/claude-agent-sdk';
import { render } from 'ink';
import {
  type CodivaConfig,
  isFullscreenViewport,
  messages,
  notificationFor,
  resolveLang,
  SessionManager,
  type SessionState,
  WorktreeManager,
} from '@/core';
import {
  createTitleGenerator,
  defaultStatePath,
  enableMouse,
  enterAltScreen,
  launchClaudeSession,
  loadConfig,
  loadState,
  notify,
  pruneMissingWorktrees,
  saveConfig,
  saveState,
  saveStateSync,
} from '@/utils';
import { App, type ExternalRunner } from './app';

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

  // /model による切替を ~/.codiva/config.json に永続化する。設定は起動時に一度
  // 読むだけなので、他フィールドを保つため直近の設定を保持してマージ保存する。
  let currentConfig: CodivaConfig = config;
  const persistModel = (model: string | undefined): void => {
    const next: CodivaConfig = { ...currentConfig };
    if (model === undefined) {
      delete next.model;
    } else {
      next.model = model;
    }
    currentConfig = next;
    void saveConfig(next).catch(() => undefined);
  };

  const manager = new SessionManager({
    worktrees,
    queryFn: query,
    generateTitle: createTitleGenerator(query, { cwd: repoRoot }),
    options: {
      model: config.model,
      effort: config.effort,
      permissionMode: config.permissionMode,
      maxBudgetUsd: config.maxBudgetUsd,
    },
    onTransition: notifyOnTransition,
    onPersist: schedulePersist,
    onModelChange: persistModel,
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

  // 全画面レイアウトで描くときは alt screen に入り、スクロールバックを無効化する
  // （上へのスクロールをロック）。低すぎる端末はインライン描画へフォールバックし
  // 端末スクロールに頼るため、通常バッファのまま。判定は起動時の一度きり
  // （途中のリサイズでバッファを切り替えると画面が壊れるため追従しない）。
  const useAltScreen = process.stdout.isTTY && isFullscreenViewport(process.stdout.rows ?? 0);
  let leaveAltScreen = useAltScreen ? enterAltScreen(process.stdout) : undefined;

  // マウス（クリックでキャレット移動・行選択）は全画面時のみ。座標を出力原点と
  // 同一視できるのが alt screen 全画面のときだけのため。`"mouse": false` で無効化。
  const useMouse = useAltScreen && config.mouse !== false;
  let disableMouse = useMouse ? enableMouse(process.stdout) : undefined;

  // claude CLI へ端末を明け渡す間だけ、マウスレポートと alt screen を解除する
  // （Ink 側の suspend は App の suspendTerminal が行う）。復帰時に張り直す。
  const runExternal: ExternalRunner = async (args) => {
    disableMouse?.();
    leaveAltScreen?.();
    try {
      return await launchClaudeSession(args);
    } finally {
      if (useAltScreen) {
        leaveAltScreen = enterAltScreen(process.stdout);
      }
      if (useMouse) {
        disableMouse = enableMouse(process.stdout);
      }
    }
  };

  const { waitUntilExit } = render(
    <App manager={manager} cwd={repoRoot} messages={t} runExternal={runExternal} />,
    { exitOnCtrlC: false },
  );
  await waitUntilExit();

  // Flush the final state on quit. dispose() used stop() (not abort()), so
  // in-flight sessions are still recorded as resumable here.
  if (persistTimer) {
    clearTimeout(persistTimer);
  }
  await saveState(manager.persistableState(), statePath).catch(() => undefined);

  // 終了メッセージは alt screen を抜けてから書き、通常バッファ（シェルの履歴）に残す。
  disableMouse?.();
  leaveAltScreen?.();

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
