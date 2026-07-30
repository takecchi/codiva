import { type ModelOption, toModelOptions } from '@/core';
import { type ProbeQuery, runSdkProbe } from './sdk-probe';

/**
 * カタログ取得に使う `query` のスライス。streaming-input モードでのみ
 * `supportedModels()` が使えるため、単発文字列版の `TitleQuery` とは別物
 * （probe 共通の {@link ProbeQuery} をそのまま使う）。
 */
export type CatalogQuery = ProbeQuery;

/**
 * Claude Code が持つ選択可能モデルの一覧を取得する。
 *
 * `claude` サブプロセスを 1 つ起こして初期化ハンドシェイクの結果だけを読み、
 * すぐ abort する（実体は `utils/sdk-probe.ts` の `runSdkProbe`）。**モデル推論は
 * 走らないのでトークン消費もコストも無い**（実測 0.3〜2 秒。設定・プラグインの
 * 読み込み量で変わる）。
 *
 * 失敗・タイムアウトでは投げずに空配列を返す。呼び出し側（`ui/hooks.ts` の
 * `useModelCatalog`）が `FALLBACK_MODEL_OPTIONS` へ落とすため、カタログが
 * 取れなくても /model は動く。
 *
 * `opts.signal` を渡すと取得を外から打ち切れる。合成ルートは終了時にこれを
 * abort する（取得中に終了されたときサブプロセスを残さないため）。
 */
export async function fetchModelCatalog(
  queryFn: CatalogQuery,
  opts: { cwd: string; signal?: AbortSignal },
): Promise<ModelOption[]> {
  const rows = await runSdkProbe(queryFn, opts, (handle) =>
    handle.supportedModels ? handle.supportedModels() : Promise.resolve(undefined),
  );
  return rows === undefined ? [] : toModelOptions(rows);
}
