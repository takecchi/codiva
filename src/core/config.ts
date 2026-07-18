import type { Lang } from './i18n';

/**
 * 永続設定のドメイン型。今は表示言語のみ。将来キーが増えても、外部 JSON からの
 * 変換は必ず `toConfig()` に閉じ込める（規約: coding-rules.md）。
 */
export interface CodivaConfig {
  /** 表示言語。'auto' は OS ロケールに従う。未設定も 'auto' 相当。 */
  language?: Lang | 'auto';
}

/** 設定ファイルの生 JSON 形（各フィールドは unknown として受ける）。 */
interface CodivaConfigJson {
  language?: unknown;
}

function toLangSetting(value: unknown): Lang | 'auto' | undefined {
  return value === 'ja' || value === 'en' || value === 'auto' ? value : undefined;
}

/**
 * 外部 JSON（設定ファイル内容）を CodivaConfig へ検証変換する。未知・不正な値は
 * 落として無視する（TUI を設定ミスでクラッシュさせないため、寛容に既定へフォールバック）。
 */
export function toConfig(json: unknown): CodivaConfig {
  if (typeof json !== 'object' || json === null) {
    return {};
  }
  const language = toLangSetting((json as CodivaConfigJson).language);
  return language ? { language } : {};
}
