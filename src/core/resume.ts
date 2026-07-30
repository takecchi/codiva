import type { Messages } from './i18n';
import { isResumable } from './status-meta';
import type { SessionState, SessionStatus } from './types';

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

/**
 * The sessions a bulk resume would restart: every session that was cut off and
 * can continue (`isResumable` — interrupted / rate_limited / needs_login), in
 * list order. Pure so the list view can both count them (for the hint and the
 * confirm prompt) and send to them without duplicating the filter.
 *
 * One dropped network / one closed lid interrupts *every* running session at
 * once, so recovering them one keypress per session is the case worth avoiding.
 */
export function resumableSessions(sessions: readonly SessionState[]): SessionState[] {
  return sessions.filter((s) => isResumable(s.status));
}
