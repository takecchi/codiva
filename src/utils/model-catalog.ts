import type { Options, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { type ModelOption, toModelOptions } from '@/core';

/** 起動を待たせないための上限。取れなければフォールバック一覧で続行する。 */
const CATALOG_TIMEOUT_MS = 10_000;

/**
 * カタログ取得に使う `query` のスライス。streaming-input モード
 * （prompt が AsyncIterable）でのみ `supportedModels()` が使えるため、
 * 単発文字列版の `TitleQuery` とは別に定義する。実物の `query` は代入可能。
 */
export type CatalogQuery = (params: {
  prompt: AsyncIterable<SDKUserMessage>;
  options: Options;
}) => AsyncIterable<unknown> & {
  supportedModels(): Promise<unknown>;
};

/** 何も送らないプロンプト。カタログ取得は init のみで完結するため入力は不要。 */
async function* idlePrompt(): AsyncGenerator<SDKUserMessage> {
  // 中断は abortController が行う。ここで解決しない Promise を待つことで
  // 「入力待ちのまま」= モデル推論を一切走らせない状態を保つ。
  await new Promise<never>(() => {});
}

/**
 * Claude Code が持つ選択可能モデルの一覧を取得する。
 *
 * `claude` サブプロセスを 1 つ起こして初期化ハンドシェイクの結果だけを読み、
 * すぐ abort する。**モデル推論は走らないのでトークン消費もコストも無い**
 * （実測 0.3〜2 秒。設定・プラグインの読み込み量で変わる）。
 *
 * 失敗・タイムアウトでは投げずに空配列を返す。呼び出し側（合成ルート）が
 * `FALLBACK_MODEL_OPTIONS` へ落とすため、カタログが取れなくても /model は動く。
 */
export async function fetchModelCatalog(
  queryFn: CatalogQuery,
  opts: { cwd: string },
): Promise<ModelOption[]> {
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), CATALOG_TIMEOUT_MS);
  try {
    const handle = queryFn({
      prompt: idlePrompt(),
      options: {
        cwd: opts.cwd,
        abortController,
        // カタログはユーザーの設定・ポリシーで変わるため、実セッションと同じ
        // 設定ソースで問い合わせる（session.ts の settingSources と揃える）。
        settingSources: ['project'],
      },
    });
    return toModelOptions(await handle.supportedModels());
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
    // 取得できたら即座にサブプロセスを畳む（常駐させない）。
    abortController.abort();
  }
}
