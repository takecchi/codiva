import { query } from '@anthropic-ai/claude-agent-sdk';
import {
  type CodivaConfig,
  type Messages,
  notificationFor,
  resolveIgnoredFilesMode,
  SessionManager,
  type SessionOptions,
  type SessionState,
} from '@/core';
import {
  createPr,
  createTitleGenerator,
  lookupPr,
  lookupPrs,
  markPrReady,
  notify,
  saveConfig,
  saveRepoPrompt,
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
 * 設定ファイル + リポジトリ追加指示 → セッションへ渡す knobs（`SessionOptions`）。
 *
 * `buildManager` から切り出して spec で固定してある: ここは SDK・fs を触らない純粋な
 * 対応付けなので、配線の取り違え（項目の渡し忘れ）だけを安く検出できるようにしたい。
 *
 * `ignoredFiles` は `WorktreeManager` に渡すものと同じ設定値で、`'symlink'` のときだけ
 * 「ignore 済みパスの実体は元リポジトリと共有」という注意書きが systemPrompt に載る
 * （`core/system-prompt.ts`）。解決は合成レイヤの2箇所（`index.tsx` の `WorktreeManager`
 * 生成とここ）で行うが、どちらも同じ config から `resolveIgnoredFilesMode()` で導くので
 * 必ず一致する。
 */
export function sessionOptionsFrom(
  config: CodivaConfig,
  appendSystemPrompt?: string,
): SessionOptions {
  return {
    model: config.model,
    effort: config.effort,
    permissionMode: config.permissionMode,
    maxBudgetUsd: config.maxBudgetUsd,
    appendSystemPrompt,
    ignoredFiles: resolveIgnoredFilesMode(config),
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
  /** リポジトリ単位の追加指示（`.codiva/prompt.md`）。全セッションの systemPrompt に載る。 */
  appendSystemPrompt?: string;
}): SessionManager {
  const { repoRoot, config, messages: t, worktrees, onPersist, appendSystemPrompt } = opts;

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
    options: sessionOptionsFrom(config, appendSystemPrompt),
    onTransition,
    onPersist,
    onModelChange: createModelPersister(config),
    // /prompt での編集を `.codiva/prompt.md` へ永続化（次回起動・新規セッションに反映）。
    onRepoPromptChange: (prompt) => {
      void saveRepoPrompt(repoRoot, prompt ?? '').catch(() => undefined);
    },
    lookupPr,
    // セッションが増えても API コストが比例しないよう、3件以上まとまったら `gh pr list` 1回に畳む。
    lookupPrs,
    // origin 追従 / PR 自動化は既定 on。`"followOrigin": false` / `"autoPr": false` で無効化。
    followOrigin: config.followOrigin !== false,
    autoPr: config.autoPr !== false,
    // 立て直しの自動化は既定 off（オンにすると詰まりを見つけた時点でターンが回る =
    // 課金が走る）。`"autoSync": true` / `"autoFixCi": true` で有効化。手動の
    // `/sync` / `/fix-ci` / `/recover` は設定に関係なく使える。
    autoSync: config.autoSync === true,
    autoFixCi: config.autoFixCi === true,
    // セッションへ送る指示文（競合解決・CI 修正）をカタログから引くために必要。
    messages: t,
    // checks は `gh pr view` の 1 回で PrInfo に同梱されるので、専用の問い合わせは持たない
    // （API（GraphQL）呼び出しを毎ポーリングで倍にしないため）。
    prAutomation: { createPr, markReady: markPrReady },
  });
}
