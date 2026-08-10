import type { Lang } from './i18n';
import type { AgentId } from './types';
import type { IgnoredFilesMode } from './worktree';

/**
 * 推論の effort レベル。**この配列が唯一の出所**で、型（`EffortLevel`）も実行時検証も
 * ここから導出する。
 *
 * 値の集合は Claude Agent SDK の同名 union と同じだが、`core/` を特定エージェントの
 * SDK から独立させるため（規約: architecture.md）あえて自前で持つ。したがって
 * **SDK 側に値が増えたらここへ追従させる必要がある**（型で気付けないので、SDK 更新時に
 * 目視で確認する）。将来エージェントを増やすときも、解釈の差はアダプタ側で吸収する。
 */
const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

/** 設定で指定できる effort レベル。`EFFORT_LEVELS` から導出（追加はそちらへ）。 */
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

/**
 * ツール実行の許可モード。**この配列が唯一の出所**で、型（`PermissionMode`）も実行時検証も
 * ここから導出する。
 *
 * `EFFORT_LEVELS` と同じ理由で自前定義（`core/` を SDK から独立させる / SDK に値が増えたら
 * ここへ追従）。とくに permissionMode は Claude Code 固有の概念なので、**エージェントが
 * 増えれば解釈が変わりうる**（同じ文字列を別エージェントがどう扱うかはアダプタの責任）。
 */
const PERMISSION_MODES = [
  'default',
  'acceptEdits',
  'bypassPermissions',
  'plan',
  'dontAsk',
  'auto',
] as const;

/** 設定で指定できる許可モード。`PERMISSION_MODES` から導出（追加はそちらへ）。 */
export type PermissionMode = (typeof PERMISSION_MODES)[number];

/**
 * Claude Code がディスクから読む設定ファイルの層。**この配列が唯一の出所**で、型も
 * 実行時検証もここから導出する（`EFFORT_LEVELS` と同じ理由で SDK からは引かない）。
 *
 * - `'user'`   … `~/.claude/settings.json`
 * - `'project'`… `<repo>/.claude/settings.json`
 * - `'local'`  … `<repo>/.claude/settings.local.json`
 *
 * 並びは Claude Code の優先順位（user < project < local）に合わせてあり、
 * `resolveClaudeSettingSources` はこの順で正規化する。
 */
const CLAUDE_SETTING_SOURCES = ['user', 'project', 'local'] as const;

/** 設定で指定できる Claude の設定ソース。`CLAUDE_SETTING_SOURCES` から導出。 */
export type ClaudeSettingSource = (typeof CLAUDE_SETTING_SOURCES)[number];

/**
 * 永続設定のドメイン型。表示言語に加え、セッション起動時に SDK へ渡す
 * model / effort / permissionMode / maxBudgetUsd と、通知の on/off を持つ。
 * 外部 JSON からの変換は必ず `toConfig()` に閉じ込める（規約: coding-rules.md）。
 */
export interface CodivaConfig {
  /** 表示言語。'auto' は OS ロケールに従う。未設定も 'auto' 相当。 */
  language?: Lang | 'auto';
  /** 使用モデル（例: 'claude-opus-4-8'）。未設定は CLI 既定。 */
  model?: string;
  /** 推論の effort レベル。未設定はモデル既定。 */
  effort?: EffortLevel;
  /** SDK の許可モード。未設定は codiva 既定（'acceptEdits'）。 */
  permissionMode?: PermissionMode;
  /** セッションあたりの上限コスト（USD）。超過で error_max_budget_usd。 */
  maxBudgetUsd?: number;
  /** 質問・完了時のデスクトップ通知。未設定は有効（true）。 */
  notifications?: boolean;
  /**
   * 学習データ利用（claude.ai の「Help improve our AI models」）が ON のとき、
   * 一覧画面に警告行を出す。未設定は有効（true）。
   *
   * 判定は `~/.claude.json` のキャッシュ →（無ければ）Claude Code の非公開
   * エンドポイントへの問い合わせの順（`utils/privacy.ts`）。`false` にすると
   * 判定自体を走らせない（Keychain もネットワークも触らない）。
   */
  privacyWarning?: boolean;
  /**
   * 起動時に npm レジストリを見て新しいバージョンを通知する。未設定は有効（true）。
   * `false` にすると起動時の通信を一切やめる（`/update` も「確認できませんでした」に
   * なる）。通信は `latest` の 1 リクエスト（実測 2.3KB・3 秒でタイムアウト）で、
   * 送るのはパッケージ名だけ。バージョンや利用状況は送らない。
   */
  updateCheck?: boolean;
  /**
   * マウスサポート（クリックでキャレット移動・行選択、入力欄のドラッグで範囲選択→
   * クリップボードへコピー）。未設定は有効（true）。有効中は端末の通常ドラッグ選択は
   * 奪われるが、入力欄はアプリ側の選択コピー（OSC 52）で代替する（Shift+ドラッグで
   * 端末ネイティブ選択も可）。なお有効時でも、セッション詳細ビューを開いている間は
   * 捕捉を一時解除し、ログを通常ドラッグで選択・コピペできるようにする（戻ると再度有効化）。
   */
  mouse?: boolean;
  /**
   * セッション作成時に origin を自動追従する。`git fetch origin <base>` して
   * 最新の `origin/<base>` から worktree を切る（origin が無ければローカル HEAD）。
   * 未設定は有効（true）。
   */
  followOrigin?: boolean;
  /**
   * PR 自動化。セッション完了時に branch を push→ draft PR を作成し、以降の
   * ポーリングでチェックが緑になったら ready 化する。未設定は有効（true）。
   */
  autoPr?: boolean;
  /**
   * PR が「ベースと競合している」と GitHub が報告したら、自動でベースブランチを
   * worktree へ取り込む。競合しなければ push まで済ませる（セッションは起こさない =
   * トークンを使わない）。競合したらセッションへ解決を依頼する。未設定は無効（false）。
   *
   * 既定を off にしているのは、依頼が発生した時点で課金が走るため。手動の `/sync` は
   * 設定に関係なくいつでも使える。
   */
  autoSync?: boolean;
  /**
   * PR のチェックが赤くなったら、失敗したチェック名を添えてセッションへ修正を依頼する。
   * 未設定は無効（false。理由は `autoSync` と同じ）。手動は `/fix-ci`。
   *
   * 依頼は 1 セッションあたり `MAX_AUTO_RECOVERY_ATTEMPTS` 回まで（`core/pr-recovery.ts`）。
   * 上限が無いと「依頼したのに push されない」ときにポーリングのたび永久に投げ続ける。
   */
  autoFixCi?: boolean;
  /**
   * セッション用 worktree 作成時に `.gitignore` された未追跡ファイル
   * （`node_modules/`・`.env` など）をどう引き継ぐか。未設定は `'symlink'`。
   * - `'symlink'`: 元へシンボリックリンクを張る（複製なしで即起動、実体は共有）。
   * - `'copy'`: 実体を複製する（worktree 完全独立、大きいと重い）。
   * - `'none'`: 引き継がない。
   */
  ignoredFiles?: IgnoredFilesMode;
  /**
   * 引き継ぎから除外する追加パターン。既定（`DEFAULT_IGNORED_EXCLUDES` = ビルド生成物・
   * キャッシュ）の**後ろ**に足され、最後に一致したパターンが勝つ。`!` 前置で既定の除外を
   * 打ち消せる（例: `["!dist", ".venv"]` = `dist/` は引き継ぐ・`.venv/` は引き継がない）。
   * `/` を含まないパターンはパスの最終セグメントに一致（`apps/web/.next/` にも効く）。
   */
  ignoredFilesExclude?: string[];
  /**
   * クラッシュ時に `~/.codiva/logs/` へレポートを残すか。未設定は有効（true）。
   *
   * 有効なときは (1) 捕捉できた例外のレポート（`crash-<時刻>-<pid>.log`）と
   * (2) Node の診断レポート（`report.*.json`。V8 のヒープ枯渇のように JS へ
   * 通知が来ない死に方でも C++ 層が書く）の 2 種類を出す。`false` にすると
   * どちらも書かず、理由の表示と端末の復元だけを行う。
   */
  crashLog?: boolean;
  /**
   * 新しいセッションを既定でどのエージェントで動かすか。未設定は `'claude'`。
   * セッションごとの切替は `/agent`（切替先が過去に会話を持っていれば resume される）。
   */
  agent?: AgentId;
  /**
   * Claude セッションで読み込む設定ファイルの層（`AgentAdapter` 経由で SDK の
   * `settingSources` になる）。未設定は `['project']`（= 対象リポジトリの
   * `.claude/settings.json` と CLAUDE.md だけ）。
   *
   * **Claude Code のプラグインを codiva のセッションでも使いたいときはここに
   * `'user'` を足す**。`claude plugin install` で入れたプラグインの有効化
   * （`enabledPlugins`）は `~/.claude/settings.json` に書かれるので、user 層を
   * 読まない既定のままではプラグインの skill / command / agent / hook / MCP が
   * 一切ロードされない（実測: `plugins: []`）。
   *
   * 副作用として、その層の他の設定（hooks・permissions・statusLine など）も
   * セッションに載る。既定を `['project']` に据えているのはそのため — セッションは
   * ユーザーの手元ではなく worktree で自動的に走るので、手元の Claude Code 用の
   * 設定を黙って持ち込まない側に倒している。
   *
   * `'project'` は指定に関わらず必ず含まれる（対象リポジトリの CLAUDE.md を
   * セッションに読ませる唯一の経路なので、設定ミスで落とせないようにする）。
   */
  claudeSettingSources?: ClaudeSettingSource[];
  /**
   * Codex セッションのサンドボックス。未設定は `'workspace-write'`
   * （書き込みは worktree 内に限定しつつ、読み取りは全体に許す）。
   *
   * Codex の exec モードは**ツール許可をユーザーに上げられない**（承認要求は CLI が
   * 自動 reject する）ため、ここが Codex セッションに対する唯一の安全弁になる。
   */
  codexSandbox?: CodexSandbox;
  /**
   * `codexSandbox: 'workspace-write'` のときネットワークアクセスを許可するか。
   * 未設定は有効（true）。Codex CLI の既定は遮断だが、それでは `npm install` や
   * `gh` が失敗して大半の作業が完了しないため codiva 側では開けておく。
   */
  codexNetworkAccess?: boolean;
  /**
   * @deprecated `ignoredFiles` を使う。後方互換のためだけに残す:
   * `true`→`'copy'` 相当、`false`→`'none'` 相当として解釈される（`resolveIgnoredFilesMode`）。
   */
  copyIgnored?: boolean;
}

const IGNORED_FILES_MODES: readonly IgnoredFilesMode[] = ['symlink', 'copy', 'none'];

/**
 * 設定で選べるエージェント。**この配列が唯一の出所**で、実行時検証もここから導出する
 * （型は `AgentId`）。実装済みのアダプタだけを並べる — Grok は未対応なので入れない。
 */
const CONFIGURABLE_AGENTS: readonly AgentId[] = ['claude', 'codex'];

/** Codex のサンドボックスモード。値の集合は Codex CLI の `--sandbox` と同じ。 */
const CODEX_SANDBOXES = ['read-only', 'workspace-write', 'danger-full-access'] as const;

/** 設定で指定できる Codex のサンドボックス。`CODEX_SANDBOXES` から導出。 */
export type CodexSandbox = (typeof CODEX_SANDBOXES)[number];

/** 設定ファイルの生 JSON 形（各フィールドは unknown として受ける）。 */
interface CodivaConfigJson {
  language?: unknown;
  model?: unknown;
  effort?: unknown;
  permissionMode?: unknown;
  maxBudgetUsd?: unknown;
  notifications?: unknown;
  privacyWarning?: unknown;
  updateCheck?: unknown;
  mouse?: unknown;
  followOrigin?: unknown;
  autoPr?: unknown;
  autoSync?: unknown;
  autoFixCi?: unknown;
  ignoredFiles?: unknown;
  ignoredFilesExclude?: unknown;
  crashLog?: unknown;
  agent?: unknown;
  claudeSettingSources?: unknown;
  codexSandbox?: unknown;
  codexNetworkAccess?: unknown;
  copyIgnored?: unknown;
}

function toAgent(value: unknown): AgentId | undefined {
  return CONFIGURABLE_AGENTS.includes(value as AgentId) ? (value as AgentId) : undefined;
}

/**
 * 設定ソースの配列を検証する。既知の層だけを残し、重複は畳む（順序の正規化は
 * `resolveClaudeSettingSources` の仕事）。1 件も残らなければ未設定扱い —
 * 空配列は SDK では「設定を一切読まない」を意味するが、それでは対象リポジトリの
 * CLAUDE.md まで落ちるので、設定ミスの受け皿にはしない。
 */
function toClaudeSettingSources(value: unknown): ClaudeSettingSource[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const sources = CLAUDE_SETTING_SOURCES.filter((source) => value.includes(source));
  return sources.length > 0 ? sources : undefined;
}

function toCodexSandbox(value: unknown): CodexSandbox | undefined {
  return CODEX_SANDBOXES.includes(value as CodexSandbox) ? (value as CodexSandbox) : undefined;
}

function toLangSetting(value: unknown): Lang | 'auto' | undefined {
  return value === 'ja' || value === 'en' || value === 'auto' ? value : undefined;
}

function toModel(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function toEffort(value: unknown): EffortLevel | undefined {
  return EFFORT_LEVELS.includes(value as EffortLevel) ? (value as EffortLevel) : undefined;
}

function toPermissionMode(value: unknown): PermissionMode | undefined {
  return PERMISSION_MODES.includes(value as PermissionMode) ? (value as PermissionMode) : undefined;
}

function toMaxBudget(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function toBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

/**
 * 文字列パターンの配列を検証する。配列でなければ落とし、文字列以外の要素と空文字は捨てる
 * （設定ミスの1要素で TUI を落とさない）。1件も残らなければ未設定扱い。
 */
function toPatternList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const patterns = value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return patterns.length > 0 ? patterns : undefined;
}

function toIgnoredFilesMode(value: unknown): IgnoredFilesMode | undefined {
  return IGNORED_FILES_MODES.includes(value as IgnoredFilesMode)
    ? (value as IgnoredFilesMode)
    : undefined;
}

/**
 * 設定から worktree の ignore ファイル引き継ぎモードを決める。新しい `ignoredFiles` を
 * 優先し、無ければ非推奨の `copyIgnored`（`true`→`'copy'` / `false`→`'none'`）へ後方互換
 * フォールバック、どちらも無ければ既定の `'symlink'`。純粋（副作用なし）。
 */
export function resolveIgnoredFilesMode(config: CodivaConfig): IgnoredFilesMode {
  if (config.ignoredFiles !== undefined) {
    return config.ignoredFiles;
  }
  if (config.copyIgnored !== undefined) {
    return config.copyIgnored ? 'copy' : 'none';
  }
  return 'symlink';
}

/**
 * 設定に差分を当てた新しい設定を返す（純粋）。**`undefined` の値はキーごと消す** —
 * 「既定へ戻す」を差分で表現できるようにするため（`{ autoPr: undefined }` = 既定に従う）。
 *
 * `saveConfig` は丸ごと上書きなので、書き手（`/model`・`/agent`・`/config`）が
 * それぞれ自前のスナップショットを持つと互いの変更を消し合う。差分をこの関数で
 * 1 つの最新値へ畳んでから保存する（合成ルートの `createConfigStore`）。
 */
export function mergeConfig(base: CodivaConfig, patch: Partial<CodivaConfig>): CodivaConfig {
  const next: CodivaConfig = { ...base, ...patch };
  for (const key of Object.keys(patch) as (keyof CodivaConfig)[]) {
    if (patch[key] === undefined) {
      delete next[key];
    }
  }
  return next;
}

/**
 * 設定から Claude セッションの設定ソース（SDK の `settingSources`）を決める。純粋。
 *
 * `'project'` は指定に関わらず必ず含める: 対象リポジトリの CLAUDE.md はこの層でしか
 * 読まれず、落とすと「リポジトリの決まりを知らないセッション」が黙って生まれる。
 * 返りは常に Claude Code の優先順位（user < project < local）の並びに正規化する。
 */
export function resolveClaudeSettingSources(config: CodivaConfig): ClaudeSettingSource[] {
  const requested = config.claudeSettingSources ?? [];
  return CLAUDE_SETTING_SOURCES.filter(
    (source) => source === 'project' || requested.includes(source),
  );
}

/**
 * 外部 JSON（設定ファイル内容）を CodivaConfig へ検証変換する。未知・不正な値は
 * 落として無視する（TUI を設定ミスでクラッシュさせないため、寛容に既定へフォールバック）。
 * 有効なキーのみを詰めるので、返り値に undefined 値は現れない。
 */
export function toConfig(json: unknown): CodivaConfig {
  if (typeof json !== 'object' || json === null) {
    return {};
  }
  const raw = json as CodivaConfigJson;
  const config: CodivaConfig = {};
  const language = toLangSetting(raw.language);
  if (language !== undefined) {
    config.language = language;
  }
  const model = toModel(raw.model);
  if (model !== undefined) {
    config.model = model;
  }
  const effort = toEffort(raw.effort);
  if (effort !== undefined) {
    config.effort = effort;
  }
  const permissionMode = toPermissionMode(raw.permissionMode);
  if (permissionMode !== undefined) {
    config.permissionMode = permissionMode;
  }
  const maxBudgetUsd = toMaxBudget(raw.maxBudgetUsd);
  if (maxBudgetUsd !== undefined) {
    config.maxBudgetUsd = maxBudgetUsd;
  }
  const notifications = toBoolean(raw.notifications);
  if (notifications !== undefined) {
    config.notifications = notifications;
  }
  const privacyWarning = toBoolean(raw.privacyWarning);
  if (privacyWarning !== undefined) {
    config.privacyWarning = privacyWarning;
  }
  const updateCheck = toBoolean(raw.updateCheck);
  if (updateCheck !== undefined) {
    config.updateCheck = updateCheck;
  }
  const mouse = toBoolean(raw.mouse);
  if (mouse !== undefined) {
    config.mouse = mouse;
  }
  const followOrigin = toBoolean(raw.followOrigin);
  if (followOrigin !== undefined) {
    config.followOrigin = followOrigin;
  }
  const autoPr = toBoolean(raw.autoPr);
  if (autoPr !== undefined) {
    config.autoPr = autoPr;
  }
  const autoSync = toBoolean(raw.autoSync);
  if (autoSync !== undefined) {
    config.autoSync = autoSync;
  }
  const autoFixCi = toBoolean(raw.autoFixCi);
  if (autoFixCi !== undefined) {
    config.autoFixCi = autoFixCi;
  }
  const ignoredFiles = toIgnoredFilesMode(raw.ignoredFiles);
  if (ignoredFiles !== undefined) {
    config.ignoredFiles = ignoredFiles;
  }
  const ignoredFilesExclude = toPatternList(raw.ignoredFilesExclude);
  if (ignoredFilesExclude !== undefined) {
    config.ignoredFilesExclude = ignoredFilesExclude;
  }
  const crashLog = toBoolean(raw.crashLog);
  if (crashLog !== undefined) {
    config.crashLog = crashLog;
  }
  const agent = toAgent(raw.agent);
  if (agent !== undefined) {
    config.agent = agent;
  }
  const claudeSettingSources = toClaudeSettingSources(raw.claudeSettingSources);
  if (claudeSettingSources !== undefined) {
    config.claudeSettingSources = claudeSettingSources;
  }
  const codexSandbox = toCodexSandbox(raw.codexSandbox);
  if (codexSandbox !== undefined) {
    config.codexSandbox = codexSandbox;
  }
  const codexNetworkAccess = toBoolean(raw.codexNetworkAccess);
  if (codexNetworkAccess !== undefined) {
    config.codexNetworkAccess = codexNetworkAccess;
  }
  const copyIgnored = toBoolean(raw.copyIgnored);
  if (copyIgnored !== undefined) {
    config.copyIgnored = copyIgnored;
  }
  return config;
}
