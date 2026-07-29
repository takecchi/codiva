import type { Messages } from './i18n';
import type { SessionStatus } from './types';

/**
 * The instruction sent to Claude when the user resumes a session that was cut off
 * (see `isResumable`). Pure so both views can share it — the list's `r` key and
 * the detail view's resume action must send the same thing.
 *
 * `needs_login` gets its own wording: telling Claude "the connection dropped"
 * when the real cause was an expired login is simply wrong, and the resume only
 * happens *after* the user has logged back in — so the instruction says so.
 */
export function resumeInstruction(status: SessionStatus, m: Messages): string {
  return status === 'needs_login' ? m.resume.authInstruction : m.resume.instruction;
}
