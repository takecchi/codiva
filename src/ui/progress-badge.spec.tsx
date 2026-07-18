import { describe, expect, it } from 'vitest';
import { messages } from '@/core/i18n';
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
  it('maps statuses to labelled badges (ja)', () => {
    const m = messages.ja;
    expect(badgeFor({ ...base, status: 'creating' }, m).label).toBe('準備中');
    expect(badgeFor({ ...base, status: 'awaiting_permission' }, m).label).toBe('許可待ち');
    expect(badgeFor({ ...base, status: 'awaiting_input' }, m).label).toBe('質問あり');
    expect(badgeFor({ ...base, status: 'completed' }, m).label).toBe('完了');
    expect(badgeFor({ ...base, status: 'failed' }, m).label).toBe('失敗');
  });
  it('maps statuses to labelled badges (en)', () => {
    const m = messages.en;
    expect(badgeFor({ ...base, status: 'creating' }, m).label).toBe('Preparing');
    expect(badgeFor({ ...base, status: 'completed' }, m).label).toBe('Completed');
  });
  it('shows Step n/m when a running session has progress', () => {
    const s: SessionState = { ...base, status: 'running', progress: { done: 4, total: 7 } };
    expect(badgeFor(s, messages.ja).label).toBe('Step 4/7');
  });
  it('shows the running label for running without progress', () => {
    expect(badgeFor({ ...base, status: 'running' }, messages.ja).label).toBe('実行中');
    expect(badgeFor({ ...base, status: 'running' }, messages.en).label).toBe('Running');
  });
});
