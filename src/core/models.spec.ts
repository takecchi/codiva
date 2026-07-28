import { describe, expect, it } from 'vitest';
import {
  currentModelIndex,
  DEFAULT_MODEL_VALUE,
  FALLBACK_MODEL_OPTIONS,
  isCurrentModel,
  type ModelOption,
  toConfigModel,
  toModelOptions,
} from './models';

/**
 * Real `supportedModels()` output captured from the Agent SDK. Kept verbatim —
 * including the `[1m]` context tags and the alias/resolved split — so conversion
 * is tested against actual SDK shapes rather than assumptions.
 */
const SDK_MODELS = [
  {
    value: 'default',
    resolvedModel: 'claude-opus-4-8[1m]',
    displayName: 'Default (recommended)',
    description: 'Opus 4.8 with 1M context · Best for everyday, complex tasks',
    supportsEffort: true,
    supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
    supportsAdaptiveThinking: true,
    supportsFastMode: true,
    supportsAutoMode: true,
  },
  {
    value: 'opus[1m]',
    resolvedModel: 'claude-opus-4-8[1m]',
    displayName: 'Opus',
    description: 'Opus 4.8 with 1M context · Best for everyday, complex tasks',
  },
  {
    value: 'claude-fable-5[1m]',
    resolvedModel: 'claude-fable-5',
    displayName: 'Fable',
    description: 'Fable 5 · Most capable for your hardest and longest-running tasks',
  },
  {
    value: 'sonnet',
    resolvedModel: 'claude-sonnet-5',
    displayName: 'Sonnet',
    description: 'Sonnet 5 · Efficient for routine tasks',
  },
  {
    value: 'haiku',
    resolvedModel: 'claude-haiku-4-5-20251001',
    displayName: 'Haiku',
    description: 'Haiku 4.5 · Fastest for quick answers',
  },
];

describe('toModelOptions', () => {
  it('converts real SDK output preserving order', () => {
    expect(toModelOptions(SDK_MODELS).map((o) => o.value)).toEqual([
      'default',
      'opus[1m]',
      'claude-fable-5[1m]',
      'sonnet',
      'haiku',
    ]);
  });

  it('keeps the display fields and drops SDK extras', () => {
    const sonnet = toModelOptions(SDK_MODELS).find((o) => o.value === 'sonnet');
    expect(sonnet).toEqual({
      value: 'sonnet',
      resolvedModel: 'claude-sonnet-5',
      displayName: 'Sonnet',
      description: 'Sonnet 5 · Efficient for routine tasks',
    });
  });

  it.each([[undefined], [null], [{}], ['sonnet'], [42]])(
    'returns [] for non-array input %p',
    (input) => {
      expect(toModelOptions(input)).toEqual([]);
    },
  );

  it('drops rows without a usable value', () => {
    expect(
      toModelOptions([
        { displayName: 'No value' },
        { value: '   ', displayName: 'Blank value' },
        { value: 42, displayName: 'Numeric value' },
        null,
        'sonnet',
        { value: 'sonnet', displayName: 'Sonnet' },
      ]),
    ).toEqual([{ value: 'sonnet', displayName: 'Sonnet' }]);
  });

  it('falls back to the value when displayName is missing', () => {
    expect(toModelOptions([{ value: 'sonnet' }])).toEqual([
      { value: 'sonnet', displayName: 'sonnet' },
    ]);
  });

  it('deduplicates rows sharing a value, keeping the first', () => {
    const options = toModelOptions([
      { value: 'sonnet', displayName: 'Sonnet' },
      { value: 'sonnet', displayName: 'Sonnet (dup)' },
    ]);
    expect(options).toHaveLength(1);
    expect(options[0]?.displayName).toBe('Sonnet');
  });
});

describe('toConfigModel', () => {
  it('maps the default sentinel to unset (CLI default)', () => {
    expect(toConfigModel(DEFAULT_MODEL_VALUE)).toBeUndefined();
  });

  it('passes any other value through verbatim', () => {
    expect(toConfigModel('sonnet')).toBe('sonnet');
    expect(toConfigModel('claude-fable-5[1m]')).toBe('claude-fable-5[1m]');
  });
});

describe('isCurrentModel', () => {
  const options = toModelOptions(SDK_MODELS);
  const row = (value: string): ModelOption => {
    const found = options.find((o) => o.value === value);
    if (!found) {
      throw new Error(`missing fixture row: ${value}`);
    }
    return found;
  };

  it('marks the default row when nothing is configured', () => {
    expect(isCurrentModel(row('default'), undefined)).toBe(true);
    expect(isCurrentModel(row('sonnet'), undefined)).toBe(false);
  });

  it('matches on the alias value', () => {
    expect(isCurrentModel(row('sonnet'), 'sonnet')).toBe(true);
  });

  it('matches a persisted explicit id against the alias row that covers it', () => {
    // An older codiva persisted the full id; the catalog now offers the alias.
    expect(isCurrentModel(row('sonnet'), 'claude-sonnet-5')).toBe(true);
  });

  it('does not match an unrelated model', () => {
    expect(isCurrentModel(row('sonnet'), 'claude-haiku-4-5')).toBe(false);
  });

  it('never marks the default row for an explicitly configured model', () => {
    // The SDK gives the default row a resolvedModel too ('claude-opus-4-8[1m]').
    // Matching on it would show an explicit Opus choice as "Default".
    expect(row('default').resolvedModel).toBe('claude-opus-4-8[1m]');
    expect(isCurrentModel(row('default'), 'claude-opus-4-8[1m]')).toBe(false);
    expect(isCurrentModel(row('opus[1m]'), 'claude-opus-4-8[1m]')).toBe(true);
  });
});

describe('currentModelIndex', () => {
  const options = toModelOptions(SDK_MODELS);

  it('finds the row for a configured alias', () => {
    expect(currentModelIndex(options, 'sonnet')).toBe(3);
  });

  it('finds the row for a persisted explicit id', () => {
    expect(currentModelIndex(options, 'claude-sonnet-5')).toBe(3);
  });

  it('points at the default row when unset', () => {
    expect(currentModelIndex(options, undefined)).toBe(0);
  });

  it('prefers the explicit row over the default row sharing its resolved model', () => {
    expect(currentModelIndex(options, 'claude-opus-4-8[1m]')).toBe(1);
  });

  it('falls back to the first row for a model missing from the catalog', () => {
    expect(currentModelIndex(options, 'claude-unknown-9')).toBe(0);
  });

  it('stays valid on an empty catalog', () => {
    expect(currentModelIndex([], 'sonnet')).toBe(0);
  });
});

describe('FALLBACK_MODEL_OPTIONS', () => {
  it('leads with the CLI-default row', () => {
    expect(FALLBACK_MODEL_OPTIONS[0]?.value).toBe(DEFAULT_MODEL_VALUE);
  });

  it('uses only family aliases so it cannot go stale on a model release', () => {
    // A version-pinned id here would reintroduce exactly the staleness this
    // module exists to avoid, so assert no row carries version digits.
    for (const option of FALLBACK_MODEL_OPTIONS) {
      expect(option.value).not.toMatch(/\d/);
    }
  });
});
