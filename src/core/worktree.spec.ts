import { describe, expect, it } from 'vitest';
import {
  DEFAULT_IGNORED_EXCLUDES,
  excludedIgnoredEntries,
  ignoredCopyEntries,
  ignoredExcludePatterns,
  isExcludedIgnoredEntry,
} from '@/core/worktree';

describe('ignoredCopyEntries', () => {
  it('keeps ignored files and dirs but drops .codiva and .git', () => {
    const raw = ['.codiva/', '.env', '.env.local', '.git/', 'node_modules/', ''].join('\n');
    expect(ignoredCopyEntries(raw)).toEqual(['.env', '.env.local', 'node_modules/']);
  });

  it('returns an empty list for empty output', () => {
    expect(ignoredCopyEntries('')).toEqual([]);
  });

  // `.codiva/.gitignore`（中身 `*`）を置くと ls-files が `.codiva/` を 1 件に畳まず
  // 中身まで列挙する。`.codiva/worktrees/` を引き継ぐと新 worktree の中へ worktree 群
  // 自身へのリンクが張られ、以後の `git worktree remove` が ELOOP で失敗する。
  it('drops everything under .codiva/ and .git/, not just the exact dir', () => {
    const raw = [
      '.codiva/',
      '.codiva/.gitignore',
      '.codiva/state.json',
      '.codiva/worktrees/',
      '.git/hooks/',
      '.env',
    ].join('\n');
    expect(ignoredCopyEntries(raw)).toEqual(['.env']);
  });

  // issue #81: 生成物を共有すると開発サーバ同士が同じ実体へ書き込み、
  // ルートで再帰監視する開発サーバからは worktree の数だけ同じ木が見えてフリーズする。
  it('drops build output and caches by default', () => {
    const raw = [
      '.env',
      'node_modules/',
      '.next/',
      'dist/',
      'coverage/',
      '.turbo/',
      'tsconfig.tsbuildinfo',
      'apps/web/.next/',
      'packages/ui/dist/',
    ].join('\n');
    expect(ignoredCopyEntries(raw)).toEqual(['.env', 'node_modules/']);
  });

  it('honours extra and negated patterns from config', () => {
    const raw = ['.env', 'node_modules/', 'dist/', '.venv/'].join('\n');
    const excludes = ignoredExcludePatterns(['!dist', '.venv']);
    expect(ignoredCopyEntries(raw, excludes)).toEqual(['.env', 'node_modules/', 'dist/']);
  });
});

describe('isExcludedIgnoredEntry', () => {
  it.each<[string, boolean]>([
    // 既定パターンは最終セグメントで一致する（ネストした生成物にも効く）
    ['.next/', true],
    ['apps/web/.next/', true],
    ['dist/', true],
    ['packages/ui/dist', true],
    ['target/', true],
    ['tsconfig.tsbuildinfo', true],
    ['packages/ui/tsconfig.tsbuildinfo', true],
    // 依存・環境ファイルは引き継ぐ（symlink モードの利点そのもの）
    ['node_modules/', false],
    ['.env', false],
    ['.env.local', false],
    ['.venv/', false],
    // 部分一致で巻き込まない
    ['distribution/', false],
    ['my-dist/', false],
    ['.tsbuildinfo', false],
    ['src/outbox/', false],
  ])('%s → excluded=%s with defaults', (entry, expected) => {
    expect(isExcludedIgnoredEntry(entry, DEFAULT_IGNORED_EXCLUDES)).toBe(expected);
  });

  it.each<[string, string[], boolean]>([
    // 最後に一致したパターンが勝つ（.gitignore と同じ）
    ['dist/', ['dist', '!dist'], false],
    ['dist/', ['!dist', 'dist'], true],
    // パスを含むパターンはフルパスに一致（他の同名ディレクトリは残す）
    ['apps/web/.cache/', ['apps/web/.cache'], true],
    ['apps/api/.cache/', ['apps/web/.cache'], false],
    // 空・空白だけのパターンは無視する（全部除外にならない）
    ['node_modules/', ['', '  '], false],
    // 接尾一致
    ['debug.log', ['*.log'], true],
    ['logs/', ['*.log'], false],
  ])('%s with %o → excluded=%s', (entry, patterns, expected) => {
    expect(isExcludedIgnoredEntry(entry, patterns)).toBe(expected);
  });
});

describe('excludedIgnoredEntries', () => {
  it('is the complement of ignoredCopyEntries (minus .codiva/.git)', () => {
    const raw = ['.codiva/', '.git/', '.env', 'node_modules/', '.next/', 'dist/'].join('\n');
    expect(excludedIgnoredEntries(raw)).toEqual(['.next/', 'dist/']);
    expect(ignoredCopyEntries(raw)).toEqual(['.env', 'node_modules/']);
  });

  it('follows the configured patterns', () => {
    const raw = ['dist/', '.venv/'].join('\n');
    expect(excludedIgnoredEntries(raw, ignoredExcludePatterns(['!dist', '.venv']))).toEqual([
      '.venv/',
    ]);
  });
});

describe('ignoredExcludePatterns', () => {
  it('returns the defaults when nothing extra is set', () => {
    expect(ignoredExcludePatterns()).toBe(DEFAULT_IGNORED_EXCLUDES);
    expect(ignoredExcludePatterns([])).toBe(DEFAULT_IGNORED_EXCLUDES);
  });

  it('appends extras after the defaults so they can negate them', () => {
    expect(ignoredExcludePatterns(['!dist'])).toEqual([...DEFAULT_IGNORED_EXCLUDES, '!dist']);
  });
});
