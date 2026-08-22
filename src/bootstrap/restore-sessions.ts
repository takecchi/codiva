import {
  agentSupports,
  capabilityLookup,
  type LogEntry,
  type SessionManager,
  transcriptLogEntries,
} from '@/core';
import { loadState, loadTranscriptText, pruneMissingWorktrees } from '@/utils';

/**
 * Restore sessions from a previous run (worktrees still on disk). Each session's
 * conversation log is rebuilt from its SDK transcript (~/.claude/projects/…):
 * `resume` restores only the model-side context and never re-emits past messages,
 * so without this the detail view would start empty.
 *
 * トランスクリプトの読み出しは **`transcript` capability を持つ provider のセッション
 * だけ**に投げる。パスの組み立てと JSONL の解釈は Claude CLI の記録に固有なので、
 * Codex / Grok のセッション id で問い合わせても当たらない（今は空振りするだけだが、
 * worktree が同じで id が偶然衝突すれば**別 provider のログを混ぜて**復元してしまう）。
 */
export async function restoreSessions(manager: SessionManager, statePath: string): Promise<void> {
  const persisted = pruneMissingWorktrees(await loadState(statePath));
  const capabilities = capabilityLookup(manager.listAgents());
  const histories = new Map<string, LogEntry[]>();
  // One transcript at a time on purpose. Reading them in parallel held every raw
  // JSONL (a busy session's is several MB) in the heap simultaneously, on top of
  // the parsed entries — a launch-time spike that scales with the number of
  // restored sessions. Sequentially, each text is collectable as soon as it has
  // been converted, and the (bounded) entries are all that stay.
  for (const p of persisted.sessions) {
    // 現在の provider にまだ会話が無いセッション（切替直後に保存されたもの）は
    // 読むトランスクリプトが無い。控え（`agentSessions`）の id は**別 provider の
    // もの**なので代わりに読まない。
    if (!agentSupports(capabilities, p.agent, 'transcript') || p.sdkSessionId === undefined) {
      continue;
    }
    const text = await loadTranscriptText(p.worktreePath, p.sdkSessionId);
    if (text !== undefined) {
      histories.set(p.id, transcriptLogEntries(text));
    }
  }
  manager.restore(persisted, histories);
}
