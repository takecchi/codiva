import { query } from '@anthropic-ai/claude-agent-sdk';
import {
  type CodivaConfig,
  type Messages,
  notificationFor,
  SessionManager,
  type SessionState,
} from '@/core';
import {
  createPr,
  createTitleGenerator,
  lookupPr,
  markPrReady,
  notify,
  prChecks,
  saveConfig,
  type WorktreeManager,
} from '@/utils';

/**
 * A `/model` change persists to `~/.codiva/config.json`. Config is read once at
 * startup, so we keep the latest config in a closure and merge-save it (preserving
 * the other fields) on each change.
 */
function createModelPersister(config: CodivaConfig): (model: string | undefined) => void {
  let current = config;
  return (model) => {
    const next: CodivaConfig = { ...current };
    if (model === undefined) {
      delete next.model;
    } else {
      next.model = model;
    }
    current = next;
    void saveConfig(next).catch(() => undefined);
  };
}

/**
 * Assemble the SessionManager and its injected I/O seams (SDK query, title
 * generation, desktop notifications, PR automation). `onPersist` is supplied by
 * the caller (the persist controller); everything else is wired from config here.
 */
export function buildManager(opts: {
  repoRoot: string;
  config: CodivaConfig;
  messages: Messages;
  worktrees: WorktreeManager;
  onPersist: () => void;
}): SessionManager {
  const { repoRoot, config, messages: t, worktrees, onPersist } = opts;

  // Notifications default on; disable with `"notifications": false` in config.
  const onTransition =
    config.notifications === false
      ? undefined
      : (prev: SessionState, next: SessionState) => {
          const spec = notificationFor(prev, next, t);
          if (spec) {
            notify(spec);
          }
        };

  return new SessionManager({
    worktrees,
    queryFn: query,
    generateTitle: createTitleGenerator(query, { cwd: repoRoot }),
    options: {
      model: config.model,
      effort: config.effort,
      permissionMode: config.permissionMode,
      maxBudgetUsd: config.maxBudgetUsd,
    },
    onTransition,
    onPersist,
    onModelChange: createModelPersister(config),
    lookupPr,
    // origin 追従 / PR 自動化は既定 on。`"followOrigin": false` / `"autoPr": false` で無効化。
    followOrigin: config.followOrigin !== false,
    autoPr: config.autoPr !== false,
    prAutomation: { createPr, checks: prChecks, markReady: markPrReady },
  });
}
