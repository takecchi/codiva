import { type CodivaConfig, mergeConfig } from '@/core';
import { saveConfig } from '@/utils';

/**
 * `~/.codiva/config.json` の**唯一の書き手**。起動時に読んだ設定をメモリに持ち、
 * 差分を畳んでから保存する。
 *
 * `saveConfig` はファイルを丸ごと上書きするので、書き手が複数（`/model` / `/agent` /
 * `/config`）あってそれぞれ起動時のスナップショットを持つと、後から書いた方が
 * 相手の変更を消す（`/config` でトグルしたあとに `/model` を変えると設定が巻き戻る）。
 * 変更経路をこの 1 つに集約して、その事故を構造的に防ぐ。
 */
export interface ConfigStore {
  /** 今の設定（起動時の値 + これまでの変更）。 */
  get(): CodivaConfig;
  /** 差分を当てて保存する（`undefined` の値はキー削除＝既定に戻す）。返りは新しい値。 */
  update(patch: Partial<CodivaConfig>): CodivaConfig;
  /** 保留中の書き込みが終わるまで待つ（終了時の取りこぼし防止・テスト用）。失敗しても reject しない。 */
  flush(): Promise<void>;
}

/**
 * 設定ストアを作る。保存は fire-and-forget（失敗しても TUI を落とさない）で、
 * 書き込み I/O は DI できる（テストはフェイクを渡す）。
 *
 * 書き込みは**必ず 1 本ずつ直列に**行い、待っている間に来た更新は最新の 1 つへ畳む。
 * 並行に投げると完了順が入れ替わり、**古いスナップショットが新しい設定を上書きする**
 * （`/config` をトグルした直後に `/model` を変えると、遅れて着地した前者でファイルが
 * 巻き戻る。issue #111）。メモリ上の `current` だけが正しくてディスクが古い状態は、
 * 次回起動まで気付けないので構造的に潰す。
 */
export function createConfigStore(
  initial: CodivaConfig,
  deps: { save?: (config: CodivaConfig) => Promise<void> } = {},
): ConfigStore {
  const save = deps.save ?? saveConfig;
  let current = initial;
  // 書き込み待ちの最新スナップショット（undefined = 待ちなし）。
  let queued: CodivaConfig | undefined;
  let writing: Promise<void> | undefined;

  const drain = async (): Promise<void> => {
    // ループの継続判定は await の直後（同期）に行うので、この間に割り込んだ
    // update() の `queued` を必ず拾える。
    while (queued !== undefined) {
      const next = queued;
      queued = undefined;
      await save(next).catch(() => undefined);
    }
    writing = undefined;
  };

  return {
    get: () => current,
    update(patch) {
      current = mergeConfig(current, patch);
      queued = current;
      if (!writing) {
        writing = drain();
      }
      return current;
    },
    flush: () => writing ?? Promise.resolve(),
  };
}
