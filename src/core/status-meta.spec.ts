import { describe, expect, it } from 'vitest';
import {
  isActiveStatus,
  isResumable,
  isTerminalStatus,
  needsAttention,
  STATUS_META,
} from './status-meta';
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
    // Only creating/running count as "working" for session-time accounting.
    ['creating', true],
    ['running', true],
    ['awaiting_permission', false],
    ['awaiting_input', false],
    ['completed', false],
    ['interrupted', false],
    ['rate_limited', false],
    ['failed', false],
    ['conflict', false],
    ['archived', false],
  ] as const)('isActiveStatus(%s) = %s', (status, expected) => {
    expect(isActiveStatus(status)).toBe(expected);
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
    ['interrupted', 'interrupted'],
    ['rate_limited', 'rateLimited'],
    ['failed', 'failed'],
    ['running', undefined],
    ['creating', undefined],
    ['conflict', undefined],
    ['archived', undefined],
  ] as const)('notifyKey(%s) = %s', (status, expected) => {
    expect(STATUS_META[status].notifyKey).toBe(expected);
  });

  it.each([
    // "Cut off, resume to continue" states offer the explicit resume action.
    ['interrupted', true],
    ['rate_limited', true],
    // completed can receive follow-ups but wasn't cut off — no resume action.
    ['completed', false],
    ['running', false],
    ['creating', false],
    ['awaiting_permission', false],
    ['awaiting_input', false],
    ['failed', false],
    ['conflict', false],
    ['archived', false],
  ] as const)('isResumable(%s) = %s', (status, expected) => {
    expect(isResumable(status)).toBe(expected);
  });
});
