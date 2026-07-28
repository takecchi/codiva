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

/**
 * 何も送らないプロンプト。カタログ取得は init のみで完結するため入力は不要で、
 * 待ち続けることで「入力待ちのまま」= モデル推論を一切走らせない状態を保つ。
 *
 * 待ちは abort で解ける。決して解決しない Promise にすると、この async generator は
 * `.return()` を完了できず、`for await … break` する消費者が永久に待つことになる。
 */
async function* idlePrompt(signal: AbortSignal): AsyncGenerator<SDKUserMessage> {
  await new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    signal.addEventListener('abort', () => resolve(), { once: true });
  });
}

/**
 * Claude Code が持つ選択可能モデルの一覧を取得する。
 *
 * `claude` サブプロセスを 1 つ起こして初期化ハンドシェイクの結果だけを読み、
 * すぐ abort する。**モデル推論は走らないのでトークン消費もコストも無い**
 * （実測 0.3〜2 秒。設定・プラグインの読み込み量で変わる）。
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
  const abortController = new AbortController();
  const abort = () => abortController.abort();
  opts.signal?.addEventListener('abort', abort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const handle = queryFn({
      prompt: idlePrompt(abortController.signal),
      options: {
        cwd: opts.cwd,
        abortController,
        // カタログはユーザーの設定・ポリシーで変わるため、実セッションと同じ
        // 設定ソースで問い合わせる（session.ts の settingSources と揃える）。
        settingSources: ['project'],
      },
    });
    const catalog = handle.supportedModels();
    // タイムアウト勝ちの後に届いた rejection を unhandled にしない。
    catalog.catch(() => {});
    // タイムアウトは自前で決着させる（abort 時に SDK が必ず reject することに
    // 依存すると、SDK の内部挙動が変わったとき「取得中…」で固まる）。
    const timedOut = Symbol('timeout');
    const result = await Promise.race([
      catalog,
      new Promise<typeof timedOut>((resolve) => {
        timer = setTimeout(() => resolve(timedOut), CATALOG_TIMEOUT_MS);
        // 取得中に終了されても、このタイマーがプロセスを生かし続けないように。
        timer.unref?.();
      }),
    ]);
    return result === timedOut ? [] : toModelOptions(result);
  } catch {
    return [];
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    opts.signal?.removeEventListener('abort', abort);
    // どの経路でも即座にサブプロセスを畳む（常駐させない）。
    abortController.abort();
  }
}
