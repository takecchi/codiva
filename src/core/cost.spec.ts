import { describe, expect, it } from 'vitest';
import { formatUsd, totalCostUsd } from '@/core/cost';
import { initialState } from '@/core/status-reducer';
import type { SessionState } from '@/core/types';

function stateWithCost(id: string, cost?: number): SessionState {
  return {
    ...initialState({
      id,
      title: id,
      prompt: 'p',
      branch: `codiva/${id}`,
      worktreePath: `/tmp/${id}`,
      startedAt: 0,
    }),
    totalCostUsd: cost,
  };
}

describe('totalCostUsd', () => {
  it('sums defined costs and treats undefined as 0', () => {
    const states = [stateWithCost('a', 0.01), stateWithCost('b'), stateWithCost('c', 0.25)];
    expect(totalCostUsd(states)).toBeCloseTo(0.26, 10);
  });

  it('is 0 for an empty list', () => {
    expect(totalCostUsd([])).toBe(0);
  });
});

describe('formatUsd', () => {
  it.each([
    [0, '$0.0000'],
    [0.0123, '$0.0123'],
    [0.999, '$0.9990'],
    [1, '$1.00'],
    [2.5, '$2.50'],
    [12.345, '$12.35'],
  ])('formats %o as %s', (input, expected) => {
    expect(formatUsd(input)).toBe(expected);
  });
});
