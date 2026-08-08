import { type AgentLabel, DEFAULT_AGENT_LABEL, type Messages } from './i18n';
import { STATUS_META } from './status-meta';
import type { SessionState, SessionStatus } from './types';

/** A desktop notification to show (title = what happened, body = which session). */
export interface NotificationSpec {
  title: string;
  body: string;
}

// Some notification labels name the agent (login required), so the catalog entry is a
// template function while the rest stay plain strings. Resolve both shapes here instead
// of forcing every notify key to take an argument.
function labelFor(status: SessionStatus, m: Messages, agent: AgentLabel): string | undefined {
  const key = STATUS_META[status].notifyKey;
  if (!key) {
    return undefined;
  }
  const label = m.notify[key];
  return typeof label === 'function' ? label(agent) : label;
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
  agent: AgentLabel = DEFAULT_AGENT_LABEL,
): NotificationSpec | undefined {
  if (prev.status === next.status) {
    return undefined;
  }
  const label = labelFor(next.status, m, agent);
  return label ? { title: `codiva: ${label}`, body: next.title } : undefined;
}
