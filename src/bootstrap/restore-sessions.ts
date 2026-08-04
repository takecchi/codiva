import { type LogEntry, type SessionManager, transcriptLogEntries } from '@/core';
import { loadState, loadTranscriptText, pruneMissingWorktrees } from '@/utils';

/**
 * Restore sessions from a previous run (worktrees still on disk). Each session's
 * conversation log is rebuilt from its SDK transcript (~/.claude/projects/…):
 * `resume` restores only the model-side context and never re-emits past messages,
 * so without this the detail view would start empty.
 */
export async function restoreSessions(manager: SessionManager, statePath: string): Promise<void> {
  const persisted = pruneMissingWorktrees(await loadState(statePath));
  const histories = new Map<string, LogEntry[]>();
  // One transcript at a time on purpose. Reading them in parallel held every raw
  // JSONL (a busy session's is several MB) in the heap simultaneously, on top of
  // the parsed entries — a launch-time spike that scales with the number of
  // restored sessions. Sequentially, each text is collectable as soon as it has
  // been converted, and the (bounded) entries are all that stay.
  for (const p of persisted.sessions) {
    const text = await loadTranscriptText(p.worktreePath, p.sdkSessionId);
    if (text !== undefined) {
      histories.set(p.id, transcriptLogEntries(text));
    }
  }
  manager.restore(persisted, histories);
}
