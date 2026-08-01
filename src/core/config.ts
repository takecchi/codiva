import type { EffortLevel, PermissionMode } from '@anthropic-ai/claude-agent-sdk';
import type { Lang } from './i18n';
import type { IgnoredFilesMode } from './worktree';

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
   * @deprecated `ignoredFiles` を使う。後方互換のためだけに残す:
   * `true`→`'copy'` 相当、`false`→`'none'` 相当として解釈される（`resolveIgnoredFilesMode`）。
   */
  copyIgnored?: boolean;
}

/** SDK 由来 union の実行時検証用リテラル。型が変われば型エラーで気付ける。 */
const EFFORT_LEVELS: readonly EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];
const PERMISSION_MODES: readonly PermissionMode[] = [
  'default',
  'acceptEdits',
  'bypassPermissions',
  'plan',
  'dontAsk',
  'auto',
];
const IGNORED_FILES_MODES: readonly IgnoredFilesMode[] = ['symlink', 'copy', 'none'];

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
  copyIgnored?: unknown;
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
  const copyIgnored = toBoolean(raw.copyIgnored);
  if (copyIgnored !== undefined) {
    config.copyIgnored = copyIgnored;
  }
  return config;
}
