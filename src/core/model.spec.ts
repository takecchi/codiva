import { describe, expect, it } from 'vitest';
import { formatModel } from './model';

describe('formatModel', () => {
  it.each([
    // current dashed ids
    ['claude-opus-4-8', 'Opus 4.8'],
    ['claude-sonnet-4-5', 'Sonnet 4.5'],
    ['claude-haiku-4-5', 'Haiku 4.5'],
    ['claude-fable-5', 'Fable 5'],
    // dated ids (family after the version digits)
    ['claude-3-5-sonnet-20241022', 'Sonnet 3.5'],
    ['claude-3-opus-20240229', 'Opus 3'],
    // context-window tag is stripped
    ['claude-sonnet-4-5[1m]', 'Sonnet 4.5'],
    // aliases without a version
    ['sonnet', 'Sonnet'],
    ['opus', 'Opus'],
    // case / whitespace tolerance
    ['  Claude-Opus-4-8  ', 'Opus 4.8'],
  ])('formats %s → %s', (input, expected) => {
    expect(formatModel(input)).toBe(expected);
  });

  it('returns undefined for empty/undefined input', () => {
    expect(formatModel(undefined)).toBeUndefined();
    expect(formatModel('')).toBeUndefined();
    expect(formatModel('   ')).toBeUndefined();
  });

  it('returns unknown ids verbatim', () => {
    expect(formatModel('gpt-4o')).toBe('gpt-4o');
    expect(formatModel('default')).toBe('default');
  });
});
