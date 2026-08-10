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
}

/**
 * 設定ストアを作る。保存は fire-and-forget（失敗しても TUI を落とさない）で、
 * 書き込み I/O は DI できる（テストはフェイクを渡す）。
 */
export function createConfigStore(
  initial: CodivaConfig,
  deps: { save?: (config: CodivaConfig) => Promise<void> } = {},
): ConfigStore {
  const save = deps.save ?? saveConfig;
  let current = initial;
  return {
    get: () => current,
    update(patch) {
      current = mergeConfig(current, patch);
      void save(current).catch(() => undefined);
      return current;
    },
  };
}
