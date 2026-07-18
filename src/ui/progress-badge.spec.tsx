import { describe, expect, it } from 'vitest';
import { initialState } from '@/core/status-reducer';
import type { SessionState } from '@/core/types';
import { badgeFor } from '@/ui/progress-badge';

const base = initialState({
  id: '1',
  title: 't',
  prompt: 'p',
  branch: 'b',
  worktreePath: '',
  startedAt: 0,
});

describe('badgeFor', () => {
  it('maps statuses to labelled badges', () => {
    expect(badgeFor({ ...base, status: 'creating' }).label).toBe('準備中');
    expect(badgeFor({ ...base, status: 'awaiting_permission' }).label).toBe('許可待ち');
    expect(badgeFor({ ...base, status: 'awaiting_input' }).label).toBe('質問あり');
    expect(badgeFor({ ...base, status: 'completed' }).label).toBe('完了');
    expect(badgeFor({ ...base, status: 'failed' }).label).toBe('失敗');
  });
  it('shows Step n/m when a running session has progress', () => {
    const s: SessionState = { ...base, status: 'running', progress: { done: 4, total: 7 } };
    expect(badgeFor(s).label).toBe('Step 4/7');
  });
  it('shows 実行中 for running without progress', () => {
    expect(badgeFor({ ...base, status: 'running' }).label).toBe('実行中');
  });
});
