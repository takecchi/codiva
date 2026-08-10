/**
 * `/config`（対話的な設定画面）に並べる ON/OFF 項目の表（純粋・I/O 非依存）。
 *
 * 画面に出るのはこの配列だけで、UI は「行を描いて `toggleConfigPatch` を呼ぶ」しかしない。
 * 項目を増やすときは {@link CONFIG_TOGGLES} に 1 エントリ足し、文言を ja / en 両方の
 * カタログ（`core/i18n.ts` の `config` グループ）に書く。
 *
 * **ここに載せるのは真偽値として意味が通る設定だけ**（多肢選択の `language` /
 * `ignoredFiles` / `codexSandbox` などは対象外で、設定ファイルを直接編集する）。
 * `claudeSettingSources` は配列だが「user 層を読むか」= プラグインを使うかという
 * 1 つの ON/OFF に畳めるので、専用の read/write を持たせて例外的に載せている。
 */

import { type ClaudeSettingSource, type CodivaConfig, resolveClaudeSettingSources } from './config';
import type { Messages } from './i18n';

/** 設定画面の 1 項目を指す id（`CodivaConfig` のキー名とは限らない）。 */
export type ConfigToggleId =
  | 'notifications'
  | 'mouse'
  | 'followOrigin'
  | 'autoPr'
  | 'autoSync'
  | 'autoFixCi'
  | 'claudePlugins'
  | 'privacyWarning'
  | 'updateCheck'
  | 'crashLog'
  | 'codexNetworkAccess';

/**
 * 真偽値を持つ設定キー（`CodivaConfig` から導出）。設定の型が変わればここも変わるので、
 * 真偽値でないキーを {@link booleanToggle} に渡すと型エラーになる。
 */
type BooleanConfigKey = {
  [K in keyof CodivaConfig]-?: boolean extends CodivaConfig[K] ? K : never;
}[keyof CodivaConfig];

/** 設定画面の 1 項目。表示文言は必ずカタログから引く（規約: i18n.md）。 */
export interface ConfigToggle {
  id: ConfigToggleId;
  /** 行のラベル。 */
  label: (m: Messages) => string;
  /** 選択中の行について 1 行で出す説明。 */
  describe: (m: Messages) => string;
  /** 今の実効値（未設定なら既定値）。 */
  read: (config: CodivaConfig) => boolean;
  /** 切り替え後の差分（`mergeConfig` に渡す形。`undefined` はキー削除＝既定に戻す）。 */
  write: (on: boolean, config: CodivaConfig) => Partial<CodivaConfig>;
}

/**
 * 真偽値キー 1 つに対応する項目を作る。**既定と同じ値に戻したらキーごと消す** —
 * 設定ファイルを「既定から変えたものだけ」に保つため（既定 on の項目を触っていない
 * ユーザーの config.json に `"notifications": true` が湧かない）。
 */
function booleanToggle(
  id: ConfigToggleId,
  key: BooleanConfigKey,
  defaultOn: boolean,
  label: (m: Messages) => string,
  describe: (m: Messages) => string,
): ConfigToggle {
  return {
    id,
    label,
    describe,
    read: (config) => config[key] ?? defaultOn,
    write: (on) => {
      const patch: Partial<CodivaConfig> = {};
      patch[key] = on === defaultOn ? undefined : on;
      return patch;
    },
  };
}

/**
 * 「Claude Code のプラグインを読み込む」= `claudeSettingSources` に `'user'` を含めるか。
 * プラグインの有効化（`enabledPlugins`）は `~/.claude/settings.json` に書かれるので、
 * user 層を読むかどうかがそのまま「プラグインが載るか」になる（`docs/TECH_NOTES.md`）。
 */
const claudePluginsToggle: ConfigToggle = {
  id: 'claudePlugins',
  label: (m) => m.config.claudePlugins,
  describe: (m) => m.config.claudePluginsHelp,
  read: (config) => (config.claudeSettingSources ?? []).includes('user'),
  write: (on, config) => {
    const current = config.claudeSettingSources ?? [];
    const next: ClaudeSettingSource[] = resolveClaudeSettingSources({
      claudeSettingSources: on ? [...current, 'user'] : current.filter((s) => s !== 'user'),
    });
    // 既定（project のみ）に戻ったらキーごと消す（他の項目と同じ扱い）。
    return { claudeSettingSources: next.length === 1 ? undefined : next };
  },
};

/**
 * 設定画面に並ぶ項目。**この配列順が表示順**なので、よく触るものを上に置く。
 *
 * 現状ここにある設定はすべて**起動時に 1 回だけ読まれる**（アダプタ・WorktreeManager・
 * 端末セットアップに焼き込まれる）ので、保存はできても反映は次回起動から。画面は
 * その旨を 1 行出す（`m.config.restartHint`）。即時反映できる項目を将来足すなら、
 * 行ごとの印を持たせるのはそのとき。
 */
export const CONFIG_TOGGLES: readonly ConfigToggle[] = [
  booleanToggle(
    'notifications',
    'notifications',
    true,
    (m) => m.config.notifications,
    (m) => m.config.notificationsHelp,
  ),
  booleanToggle(
    'mouse',
    'mouse',
    true,
    (m) => m.config.mouse,
    (m) => m.config.mouseHelp,
  ),
  booleanToggle(
    'followOrigin',
    'followOrigin',
    true,
    (m) => m.config.followOrigin,
    (m) => m.config.followOriginHelp,
  ),
  booleanToggle(
    'autoPr',
    'autoPr',
    true,
    (m) => m.config.autoPr,
    (m) => m.config.autoPrHelp,
  ),
  booleanToggle(
    'autoSync',
    'autoSync',
    false,
    (m) => m.config.autoSync,
    (m) => m.config.autoSyncHelp,
  ),
  booleanToggle(
    'autoFixCi',
    'autoFixCi',
    false,
    (m) => m.config.autoFixCi,
    (m) => m.config.autoFixCiHelp,
  ),
  claudePluginsToggle,
  booleanToggle(
    'privacyWarning',
    'privacyWarning',
    true,
    (m) => m.config.privacyWarning,
    (m) => m.config.privacyWarningHelp,
  ),
  booleanToggle(
    'updateCheck',
    'updateCheck',
    true,
    (m) => m.config.updateCheck,
    (m) => m.config.updateCheckHelp,
  ),
  booleanToggle(
    'crashLog',
    'crashLog',
    true,
    (m) => m.config.crashLog,
    (m) => m.config.crashLogHelp,
  ),
  booleanToggle(
    'codexNetworkAccess',
    'codexNetworkAccess',
    true,
    (m) => m.config.codexNetworkAccess,
    (m) => m.config.codexNetworkAccessHelp,
  ),
];

/** 設定画面が描く 1 行（UI はここまで解決された値だけを受け取る）。 */
export interface ConfigToggleRow {
  id: ConfigToggleId;
  label: string;
  description: string;
  on: boolean;
}

/** 現在の設定 + 言語カタログ → 設定画面の行。純粋。 */
export function configToggleRows(config: CodivaConfig, m: Messages): ConfigToggleRow[] {
  return CONFIG_TOGGLES.map((toggle) => ({
    id: toggle.id,
    label: toggle.label(m),
    description: toggle.describe(m),
    on: toggle.read(config),
  }));
}

/**
 * 指定した項目を反転する差分を返す（`mergeConfig` に渡す形）。未知の id なら undefined。
 * 状態を持たないので、UI は「今の設定 + id」を渡すだけでよい。
 */
export function toggleConfigPatch(
  config: CodivaConfig,
  id: ConfigToggleId,
): Partial<CodivaConfig> | undefined {
  const toggle = CONFIG_TOGGLES.find((t) => t.id === id);
  return toggle ? toggle.write(!toggle.read(config), config) : undefined;
}
