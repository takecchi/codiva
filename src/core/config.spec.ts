import { describe, expect, it } from 'vitest';
import { type CodivaConfig, toConfig } from '@/core/config';

describe('toConfig', () => {
  it.each([
    [{ language: 'ja' }, { language: 'ja' }],
    [{ language: 'en' }, { language: 'en' }],
    [{ language: 'auto' }, { language: 'auto' }],
  ] as [unknown, CodivaConfig][])('keeps valid language %o', (input, expected) => {
    expect(toConfig(input)).toEqual(expected);
  });

  it.each([
    [{ language: 'fr' }],
    [{ language: 42 }],
    [{ language: null }],
    [{}],
    [null],
    [undefined],
    ['not an object'],
    [123],
  ])('drops invalid/absent language: %o', (input) => {
    expect(toConfig(input)).toEqual({});
  });

  it('ignores unknown extra keys', () => {
    expect(toConfig({ language: 'en', theme: 'dark' })).toEqual({ language: 'en' });
  });
});
