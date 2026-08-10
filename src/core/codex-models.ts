import { DEFAULT_MODEL_VALUE, type ModelOption } from './models';

/**
 * Codex が選べるモデルの一覧（純粋な変換）。取得の I/O は `utils/codex.ts` の
 * `fetchCodexModelCatalog`（`codex debug models` を 1 回起こす）。
 *
 * `core/models.ts` と同じ方針で **モデル ID・表示名・説明文を直書きしない**
 * （アカウント種別・CLI バージョンで実際に選べるモデルが変わる）。
 */

/** `codex debug models` の 1 件。実際に読む項目だけを見る（増えても落ちない）。 */
interface CodexModelJson {
  slug?: unknown;
  display_name?: unknown;
  description?: unknown;
  /** `'list'` 以外（`'hide'` 等）は内部用モデルなので選択肢に出さない。 */
  visibility?: unknown;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

/**
 * `codex debug models` の出力を {@link ModelOption}[] へ変換する。
 *
 * 先頭に「CLI 既定」の番兵行（{@link DEFAULT_MODEL_VALUE}）を足すのは Claude 側と同じ
 * で、UI が同じ `ModelSelect` を使い回せるようにするため。壊れた行（`slug` 欠落）は
 * 捨てる。JSON が想定の形でなければ空配列を返す（呼び出し側がフォールバックする）。
 */
export function toCodexModelOptions(json: unknown): ModelOption[] {
  if (typeof json !== 'object' || json === null) {
    return [];
  }
  const rows = (json as { models?: unknown }).models;
  if (!Array.isArray(rows)) {
    return [];
  }
  const options: ModelOption[] = [{ value: DEFAULT_MODEL_VALUE, displayName: 'Default' }];
  for (const raw of rows) {
    if (typeof raw !== 'object' || raw === null) {
      continue;
    }
    const row = raw as CodexModelJson;
    const slug = optionalString(row.slug);
    if (slug === undefined) {
      continue;
    }
    // 内部用（承認レビュー用モデル等）はユーザーが選ぶものではない。
    if (optionalString(row.visibility) !== 'list') {
      continue;
    }
    options.push({
      value: slug,
      // 明示的に選んだモデルを一覧で突き合わせるための正規 ID。Codex の slug は
      // エイリアスではなく実 ID なので、そのまま同じ値を入れる。
      resolvedModel: slug,
      displayName: optionalString(row.display_name) ?? slug,
      description: optionalString(row.description),
    });
  }
  // 番兵しか無い＝1 件も読めなかったので、フォールバックさせる。
  return options.length > 1 ? options : [];
}
