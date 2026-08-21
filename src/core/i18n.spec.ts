import stringWidth from 'string-width';
import { describe, expect, it } from 'vitest';
import {
  detectLocaleLang,
  LANGS,
  type Lang,
  type Messages,
  messages,
  normalizeLang,
  resolveLang,
} from '@/core/i18n';
import { BADGE_COLUMN_WIDTH } from '@/core/layout';

describe('detectLocaleLang', () => {
  it.each([
    ['ja_JP.UTF-8', 'ja'],
    ['ja', 'ja'],
    ['JA_JP', 'ja'],
    ['en_US.UTF-8', 'en'],
    ['fr_FR', 'en'],
    [undefined, 'en'],
    ['', 'en'],
  ] as const)('%s → %s', (locale, expected) => {
    expect(detectLocaleLang(locale)).toBe(expected);
  });
});

describe('normalizeLang', () => {
  it.each([
    ['ja', 'ja'],
    ['ja_JP', 'ja'],
    ['en', 'en'],
    ['en_US', 'en'],
    ['EN', 'en'],
    ['fr', undefined],
    ['', undefined],
    [undefined, undefined],
  ] as const)('%s → %s', (value, expected) => {
    expect(normalizeLang(value)).toBe(expected);
  });
});

describe('resolveLang', () => {
  it('prefers CODIVA_LANG over config and locale', () => {
    expect(resolveLang({ env: 'en', config: 'ja', locale: 'ja_JP' })).toBe('en');
  });
  it('falls back to config when env is unset/invalid', () => {
    expect(resolveLang({ env: undefined, config: 'ja', locale: 'en_US' })).toBe('ja');
    expect(resolveLang({ env: 'xx', config: 'en', locale: 'ja_JP' })).toBe('en');
  });
  it('uses the OS locale when config is "auto"', () => {
    expect(resolveLang({ config: 'auto', locale: 'ja_JP' })).toBe('ja');
    expect(resolveLang({ config: 'auto', locale: 'en_US' })).toBe('en');
  });
  it('uses the OS locale when nothing is set', () => {
    expect(resolveLang({ locale: 'ja_JP' })).toBe('ja');
    expect(resolveLang({})).toBe('en');
  });
});

describe('message catalogs', () => {
  it('exposes ja and en', () => {
    expect(LANGS).toEqual(['ja', 'en']);
    expect(messages.ja).toBeDefined();
    expect(messages.en).toBeDefined();
  });

  // Collect every leaf key path so we can assert no translation is missing in
  // either language — the whole point of enforcing a shared Messages shape.
  const keyPaths = (obj: Record<string, unknown>, prefix = ''): string[] =>
    Object.entries(obj)
      .flatMap(([k, v]) =>
        typeof v === 'object' && v !== null
          ? keyPaths(v as Record<string, unknown>, `${prefix}${k}.`)
          : [`${prefix}${k}`],
      )
      .sort();

  it('ja and en have identical key sets', () => {
    const jaKeys = keyPaths(messages.ja as unknown as Record<string, unknown>);
    const enKeys = keyPaths(messages.en as unknown as Record<string, unknown>);
    expect(jaKeys).toEqual(enKeys);
  });

  // 一覧のバッジ列は固定幅（`BADGE_COLUMN_WIDTH`）。溢れる文言を入れると
  // `truncate-end` で切れて読めず、折り返させれば 1 セッション = 1 行を前提にした
  // クリック判定がズレる（英語の 'Awaiting permission' が実際に 19 セルあった）。
  it.each(LANGS)('%s のバッジは一覧の列幅に収まる', (lang: Lang) => {
    const b = messages[lang].badge;
    const labels = Object.values(b).map((v) =>
      typeof v === 'function' ? (v as (a: number, t: number) => string)(12, 34) : v,
    );
    for (const label of labels) {
      expect(stringWidth(label), label).toBeLessThanOrEqual(BADGE_COLUMN_WIDTH);
    }
  });

  it.each(LANGS)('%s renders dynamic strings without leftover placeholders', (lang: Lang) => {
    const m: Messages = messages[lang];
    expect(m.list.sessionCount(1)).toContain('1');
    expect(m.badge.step(2, 5)).toBe('Step 2/5');
    expect(m.permission.toolTitle('Bash')).toContain('Bash');
    expect(m.permission.questionHelp(true)).toContain('Space');
    expect(m.permission.questionHelp(false)).not.toContain('Space');
  });
});
