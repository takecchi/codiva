import { describe, expect, it } from 'vitest';
import { messages } from '@/core/i18n';
import { notificationFor } from '@/core/notify';
import { initialState } from '@/core/status-reducer';
import type { SessionState, SessionStatus } from '@/core/types';

function withStatus(status: SessionStatus, title = 'add login'): SessionState {
  return {
    ...initialState({
      id: '1',
      title,
      prompt: 'p',
      branch: 'codiva/x',
      worktreePath: '/tmp/x',
      startedAt: 0,
    }),
    status,
  };
}

const m = messages.ja;

describe('notificationFor', () => {
  it.each<[SessionStatus, string]>([
    ['awaiting_input', '質問があります'],
    ['awaiting_permission', '許可を待っています'],
    ['completed', '完了しました'],
    ['interrupted', '接続が中断されました（再開できます）'],
    ['rate_limited', 'レート制限に達しました'],
    ['failed', '失敗しました'],
  ])('notifies on transition into %s', (status, label) => {
    const spec = notificationFor(withStatus('running'), withStatus(status), m);
    expect(spec).toEqual({ title: `codiva: ${label}`, body: 'add login' });
  });

  it('returns undefined when the status is unchanged (same-status update)', () => {
    expect(notificationFor(withStatus('running'), withStatus('running'), m)).toBeUndefined();
  });

  it.each<SessionStatus>(['creating', 'running', 'archived'])(
    'does not notify on transition into non-attention state %s',
    (status) => {
      expect(notificationFor(withStatus('completed'), withStatus(status), m)).toBeUndefined();
    },
  );

  it('notifies again when a new turn completes (running → completed after a follow-up)', () => {
    // completed → running (user follow-up) → completed should ping the second time.
    expect(notificationFor(withStatus('running'), withStatus('completed'), m)).toBeDefined();
  });

  it('uses the English catalog when provided', () => {
    const spec = notificationFor(withStatus('running'), withStatus('completed'), messages.en);
    expect(spec).toEqual({ title: 'codiva: Completed', body: 'add login' });
  });
});
