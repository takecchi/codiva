import type { EffortLevel, PermissionMode } from '@anthropic-ai/claude-agent-sdk';
import type { Lang } from './i18n';

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

/** 設定ファイルの生 JSON 形（各フィールドは unknown として受ける）。 */
interface CodivaConfigJson {
  language?: unknown;
  model?: unknown;
  effort?: unknown;
  permissionMode?: unknown;
  maxBudgetUsd?: unknown;
  notifications?: unknown;
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

function toNotifications(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
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
  const notifications = toNotifications(raw.notifications);
  if (notifications !== undefined) {
    config.notifications = notifications;
  }
  return config;
}
