import { describe, expect, it } from 'vitest';
import { MODELS, modelChoiceForConfig } from './models';

describe('MODELS', () => {
  it('starts with the CLI-default choice (unset)', () => {
    expect(MODELS[0]).toEqual({ id: 'default', model: undefined });
  });

  it('has unique ids', () => {
    const ids = MODELS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('maps brand ids to the current full model strings', () => {
    expect(MODELS.find((c) => c.id === 'opus')?.model).toBe('claude-opus-4-8');
    expect(MODELS.find((c) => c.id === 'fable')?.model).toBe('claude-fable-5');
    expect(MODELS.find((c) => c.id === 'sonnet')?.model).toBe('claude-sonnet-5');
    expect(MODELS.find((c) => c.id === 'haiku')?.model).toBe('claude-haiku-4-5');
  });
});

describe('modelChoiceForConfig', () => {
  it('resolves a saved model string to its choice', () => {
    expect(modelChoiceForConfig('claude-sonnet-5').id).toBe('sonnet');
  });

  it('falls back to default when unset', () => {
    expect(modelChoiceForConfig(undefined).id).toBe('default');
  });

  it('falls back to default for an unknown model string', () => {
    expect(modelChoiceForConfig('claude-unknown-9').id).toBe('default');
  });
});
