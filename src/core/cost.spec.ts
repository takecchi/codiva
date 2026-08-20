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

  it('金額を報告しない provider のセッションは数えない', () => {
    // 混在時に「Claude ぶんの合計」を全体のコストとして出さないための明示的な分岐
    // （0 だから自然に消える、という偶然に頼らない）。
    const claude = { ...stateWithCost('a', 0.5), agent: 'claude' as const };
    const codex = { ...stateWithCost('b', 0.5), agent: 'codex' as const };
    expect(totalCostUsd([claude, codex], (agent) => agent === 'claude')).toBeCloseTo(0.5, 10);
    // 述語なしは従来どおり全件を数える。
    expect(totalCostUsd([claude, codex])).toBeCloseTo(1, 10);
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
