import { query } from '@anthropic-ai/claude-agent-sdk';
import {
  type AgentAdapter,
  type AgentId,
  agentLabelOf,
  type CodivaConfig,
  createClaudeAdapter,
  createCodexAdapter,
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
  spawnCodex,
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
 * （`core/system-prompt.ts`）。解決は合成レイヤの2箇所（`main.tsx` の `WorktreeManager`
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
 * 使えるエージェントの対応表を組み立てる。**ここが provider の実 I/O を注入する
 * 唯一の場所**（`core/` は SDK もサブプロセスも知らない）。
 *
 * Codex はユーザーがインストールした `codex` CLI を起動する（`gh` と同じ方針で
 * npm 依存を増やさない）。未インストールでも登録自体は害がない — 実際に選ばれた
 * ときに起動が失敗し、`needs_login` / `failed` として普通に扱われる。
 */
export function buildAgents(
  config: CodivaConfig,
  deps: { repoRoot: string },
): Partial<Record<AgentId, AgentAdapter>> {
  // タイトル生成は Claude の haiku を使い回す（Codex にも同じものを渡す）。Codex 側の
  // 短文生成のためだけに `codex exec` をもう 1 本起こすのは高くつくため。
  const generateTitle = createTitleGenerator(query, { cwd: deps.repoRoot });
  return {
    claude: createClaudeAdapter({ queryFn: query, generateTitle }),
    codex: createCodexAdapter({
      spawn: spawnCodex,
      sandbox: config.codexSandbox,
      networkAccess: config.codexNetworkAccess,
      generateTitle,
    }),
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

  const agents = buildAgents(config, { repoRoot });

  // Notifications default on; disable with `"notifications": false` in config.
  const onTransition =
    config.notifications === false
      ? undefined
      : (prev: SessionState, next: SessionState) => {
          // 認証切れの通知は provider ごとに文言が変わる（`codex` へログインし直せ、
          // という通知を Claude の名前で出さない）。
          const spec = notificationFor(prev, next, t, agentLabelOf(agents[next.agent ?? 'claude']));
          if (spec) {
            notify(spec);
          }
        };

  return new SessionManager({
    worktrees,
    agents,
    // 新規セッションの既定 provider（`"agent": "codex"` で切り替え）。未設定は Claude。
    agent: agents[config.agent ?? 'claude'] ?? agents.claude,
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
