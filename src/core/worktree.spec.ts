import { describe, expect, it } from 'vitest';
import { ignoredCopyEntries } from '@/core/worktree';

describe('ignoredCopyEntries', () => {
  it('keeps ignored files and dirs but drops .codiva and .git', () => {
    const raw = ['.codiva/', '.env', '.env.local', '.git/', 'node_modules/', ''].join('\n');
    expect(ignoredCopyEntries(raw)).toEqual(['.env', '.env.local', 'node_modules/']);
  });

  it('returns an empty list for empty output', () => {
    expect(ignoredCopyEntries('')).toEqual([]);
  });
});
