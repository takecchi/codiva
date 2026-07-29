import { describe, expect, it } from 'vitest';
import { messages } from '@/core/i18n';
import { resumeInstruction } from '@/core/resume';

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
