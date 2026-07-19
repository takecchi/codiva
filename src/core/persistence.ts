import type { WorktreeMeta } from './session-ports';
import { STATUS_META } from './status-meta';
import { progressOf } from './status-reducer';
import type { LogEntry, SessionState, SessionStatus, TaskStatus, TodoItem } from './types';

/**
 * On-disk snapshot of a session, enough to rebuild it and resume its SDK
 * conversation after an app restart. The full message log is intentionally not
 * persisted here — it is rebuilt at restore time from the CLI's own transcript
 * (`~/.claude/projects/…/<sessionId>.jsonl`, see `core/transcript.ts`), the
 * single source of truth that also feeds the SDK's `resume`.
 */
export interface PersistedSession {
  id: string;
  title: string;
  prompt: string;
  slug: string;
  branch: string;
  worktreePath: string;
  /** Base branch this session was cut from / merges back into. */
  base: string;
  /** SDK session id for `resume`. Always present — only sessions that reached init (and are thus truly resumable) are persisted. */
  sdkSessionId: string;
  /** Only idle/terminal states are restorable (see restorableStatus). */
  status: 'completed' | 'interrupted' | 'failed';
  startedAt: number;
  finishedAt?: number;
  totalCostUsd?: number;
  /** Resolved model the session last ran on, so a restored row shows it before it resumes. */
  model?: string;
  todos: TodoItem[];
}

export interface PersistedState {
  version: 1;
  sessions: PersistedSession[];
}

/** An empty persisted state (used as the fallback when there's nothing to load). */
export function emptyPersistedState(): PersistedState {
  return { version: 1, sessions: [] };
}

/**
 * Map a live status to what it should be restored as, or undefined if the session
 * shouldn't be persisted at all. In-flight states (running / awaiting_*) come back
 * as `interrupted` — an idle, resumable session the user can send a follow-up to,
 * but flagged so it's distinguishable from a turn that actually ran to completion
 * (closing the app mid-run is not the same as a finished result). A genuine
 * `completed` stays `completed`. `archived` (merged/discarded) and `creating` (no
 * worktree yet) are dropped.
 */
export function restorableStatus(
  status: SessionStatus,
): 'completed' | 'interrupted' | 'failed' | undefined {
  // 復元先は状態の性質なので core/status-meta.ts の表から引く（分類の単一の出所）。
  return STATUS_META[status].restoreAs;
}

/**
 * Build a PersistedSession from live state + worktree meta, or undefined if this
 * session isn't worth persisting. We require an `sdkSessionId`: without it there's
 * nothing to `resume`, and restoring such a session would silently start a brand-new
 * conversation on the first follow-up (losing the original prompt). The worktree is
 * still kept on disk regardless, so no work is lost — only the codiva session entry.
 */
export function toPersistedSession(
  state: SessionState,
  meta: { slug: string; base: string },
): PersistedSession | undefined {
  const status = restorableStatus(state.status);
  if (!status || !state.worktreePath || !state.sdkSessionId) {
    return undefined;
  }
  return {
    id: state.id,
    title: state.title,
    prompt: state.prompt,
    slug: meta.slug,
    branch: state.branch,
    worktreePath: state.worktreePath,
    base: meta.base,
    sdkSessionId: state.sdkSessionId,
    status,
    startedAt: state.startedAt,
    finishedAt: state.finishedAt,
    totalCostUsd: state.totalCostUsd,
    model: state.model,
    todos: state.todos,
  };
}

/**
 * Reconstruct the UI-facing SessionState for a restored (idle) session.
 * `history` is the log rebuilt from the SDK transcript (seq 1..n, see
 * `transcriptLogEntries`); without it the detail view of a restored session
 * would be empty — `resume` restores the model-side context only and never
 * re-emits past messages on the stream.
 */
export function restoredSessionState(p: PersistedSession, history: LogEntry[] = []): SessionState {
  return {
    id: p.id,
    title: p.title,
    status: p.status,
    prompt: p.prompt,
    branch: p.branch,
    worktreePath: p.worktreePath,
    todos: p.todos,
    progress: progressOf(p.todos),
    messages: history,
    sdkSessionId: p.sdkSessionId,
    startedAt: p.startedAt,
    // In-flight sessions persisted as `interrupted` have no finishedAt; freeze the
    // elapsed clock at startedAt so a restored (idle) row doesn't show an
    // ever-growing timer computed from an old startedAt.
    finishedAt: p.finishedAt ?? p.startedAt,
    totalCostUsd: p.totalCostUsd,
    model: p.model,
    // Continue numbering after the restored history so new turns append cleanly.
    logSeq: history.at(-1)?.seq ?? 0,
  };
}

/**
 * Build the on-disk snapshot of every restorable session (for state.json) from
 * the manager's session order + per-session state/worktree accessors. Sessions
 * that can't be restored (no sdkSessionId, creating/archived, missing meta) are
 * dropped by toPersistedSession.
 */
export function assemblePersistedState(
  ids: readonly string[],
  getState: (id: string) => SessionState | undefined,
  getMeta: (id: string) => WorktreeMeta | undefined,
): PersistedState {
  const sessions = ids
    .map((id) => {
      const state = getState(id);
      const meta = getMeta(id);
      if (!state || !meta) {
        return undefined;
      }
      return toPersistedSession(state, { slug: meta.worktree.slug, base: meta.base });
    })
    .filter((s): s is PersistedSession => s !== undefined);
  return { version: 1, sessions };
}

// ── Validation of untrusted JSON (state.json can be hand-edited or stale) ──────

const TASK_STATUSES: readonly TaskStatus[] = ['pending', 'in_progress', 'completed', 'deleted'];

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function toTodo(v: unknown): TodoItem | undefined {
  if (typeof v !== 'object' || v === null) {
    return undefined;
  }
  const o = v as Record<string, unknown>;
  const id = str(o.id);
  const subject = typeof o.subject === 'string' ? o.subject : undefined;
  if (id === undefined || subject === undefined) {
    return undefined;
  }
  const status = TASK_STATUSES.includes(o.status as TaskStatus)
    ? (o.status as TaskStatus)
    : 'pending';
  return {
    id,
    subject,
    status,
    activeForm: typeof o.activeForm === 'string' ? o.activeForm : undefined,
  };
}

function toPersistedSessionJson(v: unknown): PersistedSession | undefined {
  if (typeof v !== 'object' || v === null) {
    return undefined;
  }
  const o = v as Record<string, unknown>;
  const id = str(o.id);
  const worktreePath = str(o.worktreePath);
  const base = str(o.base);
  const sdkSessionId = str(o.sdkSessionId);
  const status =
    o.status === 'completed' || o.status === 'interrupted' || o.status === 'failed'
      ? o.status
      : undefined;
  const startedAt = num(o.startedAt);
  // These are the minimum needed to rebuild + resume a session. sdkSessionId is
  // required — a persisted session without it can't be resumed (see toPersistedSession).
  if (
    id === undefined ||
    worktreePath === undefined ||
    status === undefined ||
    sdkSessionId === undefined
  ) {
    return undefined;
  }
  const todos = Array.isArray(o.todos)
    ? o.todos.map(toTodo).filter((t): t is TodoItem => t !== undefined)
    : [];
  return {
    id,
    title: typeof o.title === 'string' ? o.title : id,
    prompt: typeof o.prompt === 'string' ? o.prompt : '',
    slug: str(o.slug) ?? id,
    branch: str(o.branch) ?? `codiva/${id}`,
    worktreePath,
    base: base ?? 'HEAD',
    sdkSessionId,
    status,
    startedAt: startedAt ?? 0,
    finishedAt: num(o.finishedAt),
    totalCostUsd: num(o.totalCostUsd),
    model: str(o.model),
    todos,
  };
}

/**
 * Validate untrusted JSON into a PersistedState, dropping anything malformed.
 * Never throws — a corrupt state file must not stop the app from launching.
 */
export function fromPersistedJson(json: unknown): PersistedState {
  if (typeof json !== 'object' || json === null) {
    return emptyPersistedState();
  }
  const raw = (json as { sessions?: unknown }).sessions;
  if (!Array.isArray(raw)) {
    return emptyPersistedState();
  }
  const sessions = raw
    .map(toPersistedSessionJson)
    .filter((s): s is PersistedSession => s !== undefined);
  return { version: 1, sessions };
}
