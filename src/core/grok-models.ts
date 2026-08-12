import type { GrokModelState } from './grok-events';
import { DEFAULT_MODEL_VALUE, type ModelOption } from './models';

/**
 * Grok が選べるモデルの一覧（純粋な変換）。取得の I/O は `utils/grok.ts` の
 * `fetchGrokModelCatalog`（`grok agent stdio` を 1 回起こして `initialize` の
 * `_meta.modelState` を読む）。
 *
 * `core/models.ts` / `core/codex-models.ts` と同じ方針で **モデル ID・表示名・
 * 説明文を直書きしない**（アカウント種別・CLI バージョンで実際に選べるモデルが変わる）。
 */

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

/**
 * `initialize` / `session/new` が運ぶモデル状態を {@link ModelOption}[] へ変換する。
 *
 * 先頭に「CLI 既定」の番兵行（{@link DEFAULT_MODEL_VALUE}）を足すのは Claude / Codex と
 * 同じで、UI が同じ `ModelSelect` を使い回せるようにするため。`modelId` の無い行は
 * 捨て、1 件も読めなければ空配列を返す（呼び出し側がフォールバックする）。
 */
export function toGrokModelOptions(state: GrokModelState | undefined): ModelOption[] {
  const rows = state?.availableModels;
  if (!Array.isArray(rows)) {
    return [];
  }
  const options: ModelOption[] = [{ value: DEFAULT_MODEL_VALUE, displayName: 'Default' }];
  for (const row of rows) {
    const id = optionalString(row.modelId);
    if (id === undefined) {
      continue;
    }
    options.push({
      value: id,
      // 明示的に選んだモデルを一覧で突き合わせるための正規 ID。Grok の modelId は
      // エイリアスではなく実 ID なので、そのまま同じ値を入れる。
      resolvedModel: id,
      displayName: optionalString(row.name) ?? id,
      description: optionalString(row.description),
    });
  }
  return options.length > 1 ? options : [];
}
