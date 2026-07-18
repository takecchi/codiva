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
});
