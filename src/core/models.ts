/**
 * 選択可能な Claude モデルの一覧（純粋）。UI（/model コマンドのモデル選択）と
 * 設定（config.model）の橋渡しをする。
 *
 * 一覧は **Claude Code 自身が持つカタログを唯一の出所にする**（Agent SDK の
 * `Query.supportedModels()` → `ModelInfo[]`）。取得は I/O なので
 * `utils/model-catalog.ts` が担い、ここには「外部データ→ドメイン型」の変換と
 * 設定値の突き合わせという純粋なロジックだけを置く。
 *
 * モデル ID・表示名・説明文を直書きしないのは、カタログが
 * アカウント種別・サブスクリプション・エンタープライズの `availableModels`
 * ポリシー・CLI バージョンで変わるため。直書きするとリリースごとに陳腐化し、
 * ユーザーが実際に使えないモデルを出してしまう。
 */

/** SDK が「CLI 既定を使う」行に付ける `value`。設定では `undefined` に写像する。 */
export const DEFAULT_MODEL_VALUE = 'default';

/** 選択肢 1 行。SDK の `ModelInfo` から表示に必要な項目だけ写したもの。 */
export interface ModelOption {
  /**
   * SDK へ渡すモデル文字列（`query({ options: { model } })`）。
   * `'default'` は「CLI 既定」を意味する番兵で、設定・SDK へは `undefined` を渡す。
   */
  readonly value: string;
  /**
   * `value` が解決される正規のモデル ID（例: `'sonnet'` → `'claude-sonnet-5'`）。
   * 保存済みの明示 ID を、それを含むエイリアス行に突き合わせるために使う。
   */
  readonly resolvedModel?: string;
  /** 表示名（SDK 由来。例: `'Default (recommended)'`, `'Opus'`）。 */
  readonly displayName: string;
  /** 説明文（SDK 由来。例: `'Sonnet 5 · Efficient for routine tasks'`）。 */
  readonly description?: string;
}

/**
 * カタログ取得に失敗したときだけ使う最小の代替一覧。
 *
 * **バージョンを含む ID は置かない**（それが陳腐化の原因なので）。Claude Code が
 * カタログの `value` にも使うファミリーエイリアスだけを並べる。エイリアスは
 * 常に現行世代へ解決されるため、モデルが更新されても古びない。
 *
 * 既定行の `displayName` は表示に使われない（UI がカタログの `model.defaultRow` を
 * 引くため）。ここに置いてあるのは型を満たすためだけの不活性な値。
 */
/**
 * 「CLI 既定」だけのフォールバック。カタログを取れなかったときに**モデル名を
 * 推測で並べたくない** provider（Codex）向け。Claude の
 * {@link FALLBACK_MODEL_OPTIONS} と違ってファミリーエイリアスすら置かないのは、
 * Codex の slug（`gpt-5.6-sol` 等）が世代ごとに変わる実 ID で、エイリアスに
 * 相当するものが無いため（外せば必ず陳腐化する）。
 */
export const DEFAULT_ONLY_MODEL_OPTIONS: readonly ModelOption[] = [
  { value: DEFAULT_MODEL_VALUE, displayName: 'Default' },
];

export const FALLBACK_MODEL_OPTIONS: readonly ModelOption[] = [
  { value: DEFAULT_MODEL_VALUE, displayName: 'Default' },
  { value: 'opus', displayName: 'Opus' },
  { value: 'sonnet', displayName: 'Sonnet' },
  { value: 'haiku', displayName: 'Haiku' },
];

/** `ModelInfo` の構造検証用。SDK 型に依存せず、実際に読む項目だけを見る。 */
interface ModelInfoJson {
  value?: unknown;
  resolvedModel?: unknown;
  displayName?: unknown;
  description?: unknown;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

/**
 * SDK の `supportedModels()` 出力を `ModelOption[]` へ変換する。
 *
 * 壊れた行（`value` 欠落など）は落として無視する。SDK が項目を増やしても
 * 落ちないよう寛容に読む（外部データの変換はこの関数に閉じ込める規約）。
 * `displayName` が無い行は `value` をそのまま表示名に使う。
 */
export function toModelOptions(json: unknown): ModelOption[] {
  if (!Array.isArray(json)) {
    return [];
  }
  const options: ModelOption[] = [];
  const seen = new Set<string>();
  for (const row of json) {
    if (typeof row !== 'object' || row === null) {
      continue;
    }
    const raw = row as ModelInfoJson;
    const value = optionalString(raw.value);
    // value が無い行は選択しても SDK へ渡すものが無いので捨てる。
    if (value === undefined || seen.has(value)) {
      continue;
    }
    seen.add(value);
    const option: ModelOption = {
      value,
      displayName: optionalString(raw.displayName) ?? value,
      ...(optionalString(raw.resolvedModel) !== undefined
        ? { resolvedModel: optionalString(raw.resolvedModel) }
        : {}),
      ...(optionalString(raw.description) !== undefined
        ? { description: optionalString(raw.description) }
        : {}),
    };
    options.push(option);
  }
  return options;
}

/**
 * 選択肢を設定値（`config.model`）へ写像する。`'default'` は「未設定 = CLI 既定」
 * なので `undefined` になる。
 */
export function toConfigModel(value: string): string | undefined {
  return value === DEFAULT_MODEL_VALUE ? undefined : value;
}

/**
 * モデル ID を突き合わせ用に正規化する。
 *
 * 同じモデルが出所によって違う綴りで来るため、素の文字列比較では一致しない:
 *
 * | 出所 | 例 |
 * |---|---|
 * | セッションが報告する解決済みモデル（`system/init`） | `claude-opus-4-8` |
 * | カタログの `resolvedModel` | `claude-opus-4-8[1m]` |
 * | カタログの `resolvedModel`（日付付き） | `claude-haiku-4-5-20251001` |
 * | 設定 / カタログの `value`（エイリアス） | `opus`, `opus[1m]` |
 *
 * コンテキストタグ（`[1m]`）と末尾の日付スナップショットを落として比較する。
 * ファミリーやバージョンの数字は残すので `claude-haiku-4-5` と `claude-haiku-3` は
 * 別物として扱われる。
 */
function normalizeModelId(id: string): string {
  return id
    .replace(/\[[^\]]*\]/g, '')
    .replace(/-\d{8}$/, '')
    .trim()
    .toLowerCase();
}

/**
 * 選択肢が現在のモデル（設定値、またはセッションが報告した解決済みモデル）を
 * 指しているか。
 *
 * `value` だけでなく `resolvedModel` も見るのは、明示 ID（`'claude-sonnet-5'`）が
 * 保存されていてもカタログ側はエイリアス行（`value: 'sonnet'`）で来ることがあるため。
 * 比較は `normalizeModelId` を通すので、`[1m]` タグや日付スナップショットの
 * 綴り違いでも一致する（ここを素の比較にすると ✔ が消え、カーソルが既定行に
 * 落ちて Enter がユーザーの選択を破棄する）。
 */
export function isCurrentModel(option: ModelOption, model: string | undefined): boolean {
  // 既定行は「未設定」専用。SDK は既定行にも `resolvedModel`（例 'claude-opus-4-8[1m]'）
  // を付けるので、これを外すと明示的に Opus を選んだ設定が「デフォルト」行に
  // マッチしてしまい、ユーザーの選択が既定として表示される。
  if (option.value === DEFAULT_MODEL_VALUE) {
    return model === undefined;
  }
  if (model === undefined) {
    return false;
  }
  const target = normalizeModelId(model);
  if (target.length === 0) {
    return false;
  }
  return (
    normalizeModelId(option.value) === target ||
    (option.resolvedModel !== undefined && normalizeModelId(option.resolvedModel) === target)
  );
}

/**
 * 設定モデルに対応する行の位置。見つからなければ 0（先頭 = 既定行）を返すので、
 * カタログに無いモデルが保存されていてもカーソルは常に有効な行に乗る。
 */
export function currentModelIndex(
  options: readonly ModelOption[],
  model: string | undefined,
): number {
  const index = options.findIndex((option) => isCurrentModel(option, model));
  return index < 0 ? 0 : index;
}
