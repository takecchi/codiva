/**
 * 選択可能な Claude モデルの一覧（純粋）。UI（/model コマンドのモデル選択）と
 * 設定（config.model）の橋渡しをする。
 *
 * ここには id → SDK に渡すモデル文字列の対応だけを置く。表示名・説明文は
 * 翻訳対象なので i18n カタログ（core/i18n.ts の `model` グループ）に持つ。
 * ブランド名（Opus/Fable/…）は翻訳しないが、"Default" 等の語を含むため
 * 名称もカタログ側で解決する。
 */

/** 選択肢の安定した識別子（設定保存・i18n キー・テストで使う）。 */
export type ModelId = 'default' | 'opus' | 'fable' | 'sonnet' | 'haiku';

export interface ModelChoice {
  readonly id: ModelId;
  /** SDK query（および CLI）へ渡すモデル文字列。undefined は CLI 既定を使う。 */
  readonly model: string | undefined;
}

/**
 * UI に並べる順の選択肢。先頭は「CLI 既定を使う」= 未設定（推奨）。
 * モデル文字列は claude-api の現行ラインナップ（Opus 4.8 / Fable 5 /
 * Sonnet 5 / Haiku 4.5）に合わせる。
 */
export const MODELS: readonly ModelChoice[] = [
  { id: 'default', model: undefined },
  { id: 'opus', model: 'claude-opus-4-8' },
  { id: 'fable', model: 'claude-fable-5' },
  { id: 'sonnet', model: 'claude-sonnet-5' },
  { id: 'haiku', model: 'claude-haiku-4-5' },
];

/**
 * 保存済み設定値（config.model）から対応する選択肢を引く。未設定・未知の値は
 * 「デフォルト（CLI 既定）」にフォールバックする（設定の手書きでも壊れないように）。
 */
export function modelChoiceForConfig(model: string | undefined): ModelChoice {
  return MODELS.find((c) => c.model === model) ?? { id: 'default', model: undefined };
}
