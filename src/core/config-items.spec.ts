import { describe, expect, it } from 'vitest';
import { type CodivaConfig, mergeConfig } from '@/core/config';
import {
  CONFIG_TOGGLES,
  type ConfigToggleId,
  configToggleRows,
  toggleConfigPatch,
} from '@/core/config-items';
import { messages } from '@/core/i18n';

const m = messages.ja;

/** 表示順（= `CONFIG_TOGGLES` の並び）。増減にここが気付けるよう固定する。 */
const ORDER: ConfigToggleId[] = [
  'notifications',
  'mouse',
  'followOrigin',
  'autoPr',
  'autoSync',
  'autoFixCi',
  'claudePlugins',
  'privacyWarning',
  'updateCheck',
  'crashLog',
  'codexNetworkAccess',
];

describe('configToggleRows', () => {
  it('lists every toggle in display order', () => {
    expect(configToggleRows({}, m).map((r) => r.id)).toEqual(ORDER);
  });

  it('labels and descriptions come from the catalog (never empty)', () => {
    for (const row of configToggleRows({}, m)) {
      expect(row.label.length).toBeGreaterThan(0);
      expect(row.description.length).toBeGreaterThan(0);
    }
  });

  // 既定 on / 既定 off の両方があるので、未設定の実効値をテーブルで固定する。
  it.each<[ConfigToggleId, boolean]>([
    ['notifications', true],
    ['mouse', true],
    ['followOrigin', true],
    ['autoPr', true],
    ['autoSync', false],
    ['autoFixCi', false],
    ['claudePlugins', false],
    ['privacyWarning', true],
    ['updateCheck', true],
    ['crashLog', true],
    ['codexNetworkAccess', true],
  ])('defaults %s to %s when unset', (id, expected) => {
    expect(configToggleRows({}, m).find((r) => r.id === id)?.on).toBe(expected);
  });

  it.each<[CodivaConfig, ConfigToggleId, boolean]>([
    [{ notifications: false }, 'notifications', false],
    [{ autoSync: true }, 'autoSync', true],
    [{ claudeSettingSources: ['user', 'project'] }, 'claudePlugins', true],
    [{ claudeSettingSources: ['project', 'local'] }, 'claudePlugins', false],
  ])('reads %o as %s = %s', (config, id, expected) => {
    expect(configToggleRows(config, m).find((r) => r.id === id)?.on).toBe(expected);
  });
});

describe('toggleConfigPatch', () => {
  // 「既定から変えたものだけを書く」ため、既定へ戻す側の差分はキー削除になる。
  it.each<[ConfigToggleId, CodivaConfig, Partial<CodivaConfig>]>([
    ['notifications', {}, { notifications: false }],
    ['notifications', { notifications: false }, { notifications: undefined }],
    ['autoSync', {}, { autoSync: true }],
    ['autoSync', { autoSync: true }, { autoSync: undefined }],
  ])('toggles %s from %o', (id, config, expected) => {
    expect(toggleConfigPatch(config, id)).toEqual(expected);
  });

  it('turning a default-on item off then on again leaves the key unset', () => {
    const off = toggleConfigPatch({}, 'autoPr') ?? {};
    const config = mergeConfig({}, off);
    expect(config).toEqual({ autoPr: false });
    const on = toggleConfigPatch(config, 'autoPr') ?? {};
    expect(mergeConfig(config, on)).toEqual({});
  });

  // プラグインの ON/OFF は `claudeSettingSources` の 'user' の出し入れ。他の層は保つ。
  it.each<[CodivaConfig, Partial<CodivaConfig>]>([
    [{}, { claudeSettingSources: ['user', 'project'] }],
    [{ claudeSettingSources: ['local'] }, { claudeSettingSources: ['user', 'project', 'local'] }],
    [{ claudeSettingSources: ['user'] }, { claudeSettingSources: undefined }],
    [
      { claudeSettingSources: ['user', 'project', 'local'] },
      { claudeSettingSources: ['project', 'local'] },
    ],
  ])('toggles claudePlugins from %o', (config, expected) => {
    expect(toggleConfigPatch(config, 'claudePlugins')).toEqual(expected);
  });

  it('round-trips claudePlugins back to the unset default', () => {
    const on = toggleConfigPatch({}, 'claudePlugins') ?? {};
    const enabled = mergeConfig({}, on);
    expect(enabled.claudeSettingSources).toEqual(['user', 'project']);
    const off = toggleConfigPatch(enabled, 'claudePlugins') ?? {};
    expect(mergeConfig(enabled, off)).toEqual({});
  });

  it('every toggle round-trips through mergeConfig', () => {
    for (const toggle of CONFIG_TOGGLES) {
      const before = configToggleRows({}, m).find((r) => r.id === toggle.id)?.on;
      const flipped = mergeConfig({}, toggleConfigPatch({}, toggle.id) ?? {});
      const after = configToggleRows(flipped, m).find((r) => r.id === toggle.id)?.on;
      expect(after).toBe(!before);
      const back = mergeConfig(flipped, toggleConfigPatch(flipped, toggle.id) ?? {});
      expect(back).toEqual({});
    }
  });
});
