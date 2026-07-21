import { describe, expect, it } from 'vitest';
import { toRepoPrompt } from './repo-prompt';

describe('toRepoPrompt', () => {
  it('returns the trimmed content for a non-empty prompt', () => {
    expect(toRepoPrompt('  作業が終わったら PR を出して\n')).toBe('作業が終わったら PR を出して');
  });

  it.each([
    ['empty string', ''],
    ['whitespace only', '   \n\t  \n'],
  ])('returns undefined for %s', (_label, raw) => {
    expect(toRepoPrompt(raw)).toBeUndefined();
  });

  it('strips a leading UTF-8 BOM', () => {
    expect(toRepoPrompt('﻿Always run npm test')).toBe('Always run npm test');
  });

  it('preserves internal blank lines and formatting', () => {
    const raw = 'Line 1\n\nLine 2\n';
    expect(toRepoPrompt(raw)).toBe('Line 1\n\nLine 2');
  });
});
