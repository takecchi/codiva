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
  await Promise.all(
    persisted.sessions.map(async (p) => {
      const text = await loadTranscriptText(p.worktreePath, p.sdkSessionId);
      if (text !== undefined) {
        histories.set(p.id, transcriptLogEntries(text));
      }
    }),
  );
  manager.restore(persisted, histories);
}
