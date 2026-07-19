import { describe, expect, it } from 'vitest';
import { isTerminalStatus, needsAttention, STATUS_META } from './status-meta';
import type { SessionStatus } from './types';

const ALL_STATUSES: SessionStatus[] = [
  'creating',
  'running',
  'awaiting_permission',
  'awaiting_input',
  'completed',
  'interrupted',
  'rate_limited',
  'failed',
  'conflict',
  'archived',
];

describe('STATUS_META', () => {
  it('has an entry for every SessionStatus', () => {
    for (const status of ALL_STATUSES) {
      expect(STATUS_META[status]).toBeDefined();
    }
    expect(Object.keys(STATUS_META).sort()).toEqual([...ALL_STATUSES].sort());
  });

  it.each([
    ['creating', false],
    ['running', false],
    ['awaiting_permission', false],
    ['awaiting_input', false],
    ['completed', true],
    ['interrupted', true],
    ['rate_limited', true],
    ['failed', true],
    ['conflict', true],
    ['archived', true],
  ] as const)('isTerminalStatus(%s) = %s', (status, expected) => {
    expect(isTerminalStatus(status)).toBe(expected);
  });

  it.each([
    ['awaiting_permission', true],
    ['awaiting_input', true],
    ['running', false],
    ['completed', false],
    ['creating', false],
  ] as const)('needsAttention(%s) = %s', (status, expected) => {
    expect(needsAttention(status)).toBe(expected);
  });

  it.each([
    ['creating', undefined],
    ['running', 'interrupted'],
    ['awaiting_permission', 'interrupted'],
    ['awaiting_input', 'interrupted'],
    ['completed', 'completed'],
    ['interrupted', 'interrupted'],
    ['rate_limited', 'interrupted'],
    ['failed', 'failed'],
    ['conflict', undefined],
    ['archived', undefined],
  ] as const)('restoreAs(%s) = %s', (status, expected) => {
    expect(STATUS_META[status].restoreAs).toBe(expected);
  });

  it.each([
    ['awaiting_permission', 'needsPermission'],
    ['awaiting_input', 'needsInput'],
    ['completed', 'completed'],
    ['rate_limited', 'rateLimited'],
    ['failed', 'failed'],
    ['running', undefined],
    ['creating', undefined],
    ['conflict', undefined],
    ['archived', undefined],
  ] as const)('notifyKey(%s) = %s', (status, expected) => {
    expect(STATUS_META[status].notifyKey).toBe(expected);
  });
});
