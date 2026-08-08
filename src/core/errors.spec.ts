import { describe, expect, it } from 'vitest';
import { errorMessage, errorStack } from './errors';

describe('errorMessage', () => {
  it('uses an Error message', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom');
  });

  it('stringifies non-Error values', () => {
    expect(errorMessage('plain')).toBe('plain');
    expect(errorMessage(42)).toBe('42');
  });
});

describe('errorStack', () => {
  it('returns the stack of an Error', () => {
    const stack = errorStack(new Error('boom'));
    expect(stack).toContain('Error: boom');
    expect(stack).toContain('errors.spec.ts');
  });

  it('follows the cause chain so a wrapped error still shows its origin', () => {
    const stack = errorStack(new Error('outer', { cause: new Error('inner') }));
    expect(stack).toContain('Error: outer');
    expect(stack).toContain('caused by: ');
    expect(stack).toContain('Error: inner');
  });

  it('falls back to name: message when the Error has no stack', () => {
    const err = new Error('boom');
    err.stack = undefined;
    expect(errorStack(err)).toBe('Error: boom');
  });

  it('stops on a self-referential cause', () => {
    const err = new Error('loop');
    (err as Error & { cause?: unknown }).cause = err;
    expect(errorStack(err)?.split('caused by: ')).toHaveLength(1);
  });

  it.each([['string'], [42], [undefined], [null], [{}]])(
    'has no stack for a non-Error: %o',
    (value) => {
      expect(errorStack(value)).toBeUndefined();
    },
  );
});
