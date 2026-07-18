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

  it('keeps a valid model string', () => {
    expect(toConfig({ model: 'claude-opus-4-8' })).toEqual({ model: 'claude-opus-4-8' });
  });

  it.each([[''], ['   '], [42], [null], [{}]])('drops invalid model: %o', (model) => {
    expect(toConfig({ model })).toEqual({});
  });

  it.each([['low'], ['medium'], ['high'], ['xhigh'], ['max']])('keeps effort %s', (effort) => {
    expect(toConfig({ effort })).toEqual({ effort });
  });

  it.each([['ultra'], [3], [null]])('drops invalid effort: %o', (effort) => {
    expect(toConfig({ effort })).toEqual({});
  });

  it.each([['default'], ['acceptEdits'], ['bypassPermissions'], ['plan'], ['dontAsk'], ['auto']])(
    'keeps permissionMode %s',
    (permissionMode) => {
      expect(toConfig({ permissionMode })).toEqual({ permissionMode });
    },
  );

  it.each([['yolo'], [1], [null]])('drops invalid permissionMode: %o', (permissionMode) => {
    expect(toConfig({ permissionMode })).toEqual({});
  });

  it.each([
    [1, 1],
    [0.5, 0.5],
    [10.25, 10.25],
  ])('keeps positive maxBudgetUsd %o', (input, expected) => {
    expect(toConfig({ maxBudgetUsd: input })).toEqual({ maxBudgetUsd: expected });
  });

  it.each([[0], [-1], [Number.NaN], [Number.POSITIVE_INFINITY], ['5'], [null]])(
    'drops invalid maxBudgetUsd: %o',
    (maxBudgetUsd) => {
      expect(toConfig({ maxBudgetUsd })).toEqual({});
    },
  );

  it.each([
    [true, true],
    [false, false],
  ])('keeps boolean notifications %o', (input, expected) => {
    expect(toConfig({ notifications: input })).toEqual({ notifications: expected });
  });

  it.each([['yes'], [1], [null]])('drops invalid notifications: %o', (notifications) => {
    expect(toConfig({ notifications })).toEqual({});
  });

  it('collects all valid keys together', () => {
    expect(
      toConfig({
        language: 'en',
        model: 'claude-sonnet-5',
        effort: 'high',
        permissionMode: 'acceptEdits',
        maxBudgetUsd: 2.5,
        notifications: false,
      }),
    ).toEqual({
      language: 'en',
      model: 'claude-sonnet-5',
      effort: 'high',
      permissionMode: 'acceptEdits',
      maxBudgetUsd: 2.5,
      notifications: false,
    });
  });
});
