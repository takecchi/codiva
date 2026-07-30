import { describe, expect, it } from 'vitest';
import { messages } from '@/core/i18n';
import { resumableSessions, resumeInstruction } from '@/core/resume';
import { initialState } from '@/core/status-reducer';
import type { SessionState, SessionStatus } from '@/core/types';

describe('resumeInstruction', () => {
  it('tells Claude the login was renewed when resuming from needs_login', () => {
    for (const lang of ['ja', 'en'] as const) {
      const m = messages[lang];
      expect(resumeInstruction('needs_login', m)).toBe(m.resume.authInstruction);
      // Saying "the connection dropped" would be plainly wrong here.
      expect(resumeInstruction('needs_login', m)).not.toBe(m.resume.instruction);
    }
  });

  it('uses the generic continue instruction for the other cut-off states', () => {
    const m = messages.ja;
    expect(resumeInstruction('interrupted', m)).toBe(m.resume.instruction);
    expect(resumeInstruction('rate_limited', m)).toBe(m.resume.instruction);
  });
});

describe('resumableSessions', () => {
  const session = (id: string, status: SessionStatus): SessionState => ({
    ...initialState({
      id,
      title: id,
      prompt: 'p',
      branch: `codiva/${id}`,
      worktreePath: `/tmp/${id}`,
      startedAt: 0,
    }),
    status,
  });

  it('picks every cut-off session, in list order', () => {
    // 一度の回線断で複数セッションが同時に中断されるので、一括再開の対象になる。
    const sessions = [
      session('1', 'interrupted'),
      session('2', 'running'),
      session('3', 'rate_limited'),
      session('4', 'needs_login'),
    ];
    expect(resumableSessions(sessions).map((s) => s.id)).toEqual(['1', '3', '4']);
  });

  it('leaves out sessions that are not waiting to be continued', () => {
    // completed は追加指示を受けられるが「中断」ではない（勝手に走らせない）。
    // failed / conflict / archived も一括再開の対象外。
    const sessions: SessionStatus[] = [
      'creating',
      'running',
      'awaiting_permission',
      'awaiting_input',
      'completed',
      'failed',
      'conflict',
      'archived',
    ];
    expect(resumableSessions(sessions.map((s, i) => session(String(i), s)))).toEqual([]);
  });

  it('is empty for an empty list', () => {
    expect(resumableSessions([])).toEqual([]);
  });
});
