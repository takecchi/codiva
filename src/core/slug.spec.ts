import { describe, expect, it } from 'vitest';
import { makeSlug, makeTitle, uniqueSlug } from '@/core/slug';

describe('makeSlug', () => {
  it('kebab-cases ASCII prompts', () => {
    expect(makeSlug('Implement the HogeHoge feature')).toBe('implement-the-hogehoge-feature');
  });

  it('strips punctuation and collapses separators', () => {
    expect(makeSlug('Fix: the  bug!! (urgent)')).toBe('fix-the-bug-urgent');
  });

  it('truncates to 40 chars without trailing hyphen', () => {
    const s = makeSlug(`${'a'.repeat(30)} ${'b'.repeat(30)}`);
    expect(s.length).toBeLessThanOrEqual(40);
    expect(s.endsWith('-')).toBe(false);
  });

  it('falls back to "task" for non-ASCII (Japanese) prompts', () => {
    expect(makeSlug('HogeHoge機能を実装してください')).toBe('hogehoge');
  });

  it('falls back to "task" for empty/whitespace/symbols-only', () => {
    expect(makeSlug('   ')).toBe('task');
    expect(makeSlug('！！！')).toBe('task');
    expect(makeSlug('')).toBe('task');
  });
});

describe('uniqueSlug', () => {
  it('returns the base slug when unused', () => {
    expect(uniqueSlug('feature', new Set())).toBe('feature');
  });

  it('appends -2, -3 on collision', () => {
    const taken = new Set(['feature', 'feature-2']);
    expect(uniqueSlug('feature', taken)).toBe('feature-3');
  });
});

describe('makeTitle', () => {
  it('keeps short prompts as-is (trimmed, single-line)', () => {
    expect(makeTitle('  Implement login  ')).toBe('Implement login');
    expect(makeTitle('line one\nline two')).toBe('line one line two');
  });

  it('truncates long prompts with an ellipsis', () => {
    const t = makeTitle('x'.repeat(80));
    expect(t.length).toBeLessThanOrEqual(51);
    expect(t.endsWith('…')).toBe(true);
  });

  it('preserves Japanese text (only length-limits)', () => {
    expect(makeTitle('ログイン機能を実装')).toBe('ログイン機能を実装');
  });

  // 「リンク + ひとこと」の指示はタイトルを生成しない（要約器はリンク先を読めない）ので、
  // ここの出力がそのまま残る。URL をそのまま置くと 50 文字の枠を使い切って本文が消える。
  const githubUrls: ReadonlyArray<readonly [string, string]> = [
    [
      'https://github.com/takecchi/codiva/issues/139\nこちらの対応をお願いします。',
      'codiva#139 こちらの対応をお願いします。',
    ],
    [
      'https://github.com/The-Phage-Inc/glucose-flight-backend/pull/1723 リリース日を変更',
      'glucose-flight-backend#1723 リリース日を変更',
    ],
    ['https://github.com/o/r/issues/7#issuecomment-42 を見て', 'r#7 を見て'],
  ];
  it.each(githubUrls)('folds a GitHub issue/PR URL: %j', (prompt, expected) => {
    expect(makeTitle(prompt)).toBe(expected);
  });

  it('leaves other URLs alone (their shape is unknown)', () => {
    expect(makeTitle('https://example.com/a/b を見て')).toBe('https://example.com/a/b を見て');
  });
});
