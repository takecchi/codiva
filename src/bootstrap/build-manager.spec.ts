import { describe, expect, it } from 'vitest';
import type { CodivaConfig, IgnoredFilesMode } from '@/core';
import { sessionOptionsFrom } from './build-manager';

describe('sessionOptionsFrom', () => {
  it('forwards the configured knobs verbatim', () => {
    const config: CodivaConfig = {
      model: 'claude-opus-4-8',
      effort: 'high',
      permissionMode: 'plan',
      maxBudgetUsd: 3,
    };
    expect(sessionOptionsFrom(config, 'Open a PR when done')).toEqual({
      model: 'claude-opus-4-8',
      effort: 'high',
      permissionMode: 'plan',
      maxBudgetUsd: 3,
      appendSystemPrompt: 'Open a PR when done',
      ignoredFiles: 'symlink',
    });
  });

  // `ignoredFiles` を渡し忘れると symlink 共有の注意書きが systemPrompt から消える
  // （= セッションが共有物だと知らずにビルドする）。`WorktreeManager` と同じ解決結果に
  // なることをここで固定する。
  it.each<[CodivaConfig, IgnoredFilesMode]>([
    [{}, 'symlink'],
    [{ ignoredFiles: 'symlink' }, 'symlink'],
    [{ ignoredFiles: 'copy' }, 'copy'],
    [{ ignoredFiles: 'none' }, 'none'],
    [{ copyIgnored: true }, 'copy'],
    [{ copyIgnored: false }, 'none'],
    [{ ignoredFiles: 'symlink', copyIgnored: true }, 'symlink'],
  ])('resolves the worktree ignored-files mode from %o', (config, expected) => {
    expect(sessionOptionsFrom(config).ignoredFiles).toBe(expected);
  });

  it('leaves an absent repo prompt undefined', () => {
    expect(sessionOptionsFrom({}).appendSystemPrompt).toBeUndefined();
  });
});
