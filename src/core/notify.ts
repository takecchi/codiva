import type { Messages } from './i18n';
import { STATUS_META } from './status-meta';
import type { SessionState, SessionStatus } from './types';

/** A desktop notification to show (title = what happened, body = which session). */
export interface NotificationSpec {
  title: string;
  body: string;
}

function labelFor(status: SessionStatus, m: Messages): string | undefined {
  const key = STATUS_META[status].notifyKey;
  return key ? m.notify[key] : undefined;
}

/**
 * Decide whether a status change deserves a desktop notification. Fires only on an
 * actual transition into a state that wants the user's attention (a question or
 * permission prompt) or a terminal state (completed/failed) — so a burst of
 * same-status streaming updates stays quiet, and each new turn's completion still
 * pings (running → completed is a fresh transition). Pure; the caller does the I/O.
 */
export function notificationFor(
  prev: SessionState,
  next: SessionState,
  m: Messages,
): NotificationSpec | undefined {
  if (prev.status === next.status) {
    return undefined;
  }
  const label = labelFor(next.status, m);
  return label ? { title: `codiva: ${label}`, body: next.title } : undefined;
}
