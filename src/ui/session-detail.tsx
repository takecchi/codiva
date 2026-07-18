import { Box, Static, Text, useInput } from 'ink';
import { type FC, useEffect, useState } from 'react';
import type { DiffStat, LogEntry, SessionManager } from '@/core';
import { useSessions } from './hooks';
import { editBuffer } from './input';
import { PermissionDialog } from './permission-dialog';
import { ProgressBadge } from './progress-badge';
import { PromptInput } from './prompt-input';

const LOG_COLOR: Record<LogEntry['kind'], string | undefined> = {
  assistant_text: undefined,
  tool_use: 'blue',
  tool_result: 'gray',
  result: 'green',
  user: 'cyan',
  system: 'yellow',
  error: 'red',
};

const TERMINAL = new Set(['completed', 'failed', 'archived']);

const LogLine: FC<{ entry: LogEntry }> = ({ entry }) => {
  const prefix =
    entry.kind === 'user'
      ? '» '
      : entry.kind === 'tool_use'
        ? '· '
        : entry.kind === 'error'
          ? '✖ '
          : '';
  return (
    <Text color={LOG_COLOR[entry.kind]} wrap="truncate-end">
      {prefix}
      {entry.text}
    </Text>
  );
};

export const SessionDetail: FC<{
  manager: SessionManager;
  id: string;
  onBack: () => void;
}> = ({ manager, id, onBack }) => {
  const sessions = useSessions(manager);
  const session = sessions.find((s) => s.id === id);
  const [buffer, setBuffer] = useState('');
  const [panel, setPanel] = useState<'input' | 'actions'>('input');
  const [confirm, setConfirm] = useState<'merge' | 'discard' | null>(null);
  const [diff, setDiff] = useState<DiffStat | undefined>(undefined);
  const [actionError, setActionError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  const pending = session?.pendingPermission;
  const status = session?.status;
  const isTerminal = status !== undefined && TERMINAL.has(status);

  // Fetch the diff summary once the session reaches a terminal state.
  useEffect(() => {
    if (!isTerminal) {
      return;
    }
    let alive = true;
    manager
      .diffStat(id)
      .then((d) => {
        if (alive) {
          setDiff(d);
        }
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [manager, id, isTerminal]);

  const run = (action: 'merge' | 'discard') => {
    setBusy(true);
    const promise = action === 'merge' ? manager.merge(id) : manager.discard(id, { force: true });
    promise.then((result) => {
      setBusy(false);
      setConfirm(null);
      if (result.ok) {
        setActionError(undefined);
        setPanel('input');
      } else {
        setActionError(result.error);
      }
    });
  };

  useInput((input, key) => {
    if (key.escape) {
      if (confirm) {
        setConfirm(null);
        return;
      }
      if (panel === 'actions') {
        setPanel('input');
        return;
      }
      onBack();
      return;
    }
    if (busy) {
      return;
    }
    if (pending) {
      return; // PermissionDialog owns the keys
    }
    if (confirm) {
      if (input === 'y' || input === 'Y') {
        run(confirm);
      } else if (input === 'n' || input === 'N') {
        setConfirm(null);
      }
      return;
    }
    if (key.tab) {
      setPanel((p) => (p === 'input' ? 'actions' : 'input'));
      return;
    }
    if (panel === 'actions') {
      if (input === 'm' || input === 'M') {
        setConfirm('merge');
      } else if (input === 'd' || input === 'D') {
        setConfirm('discard');
      }
      return;
    }
    // input panel
    if (key.leftArrow) {
      onBack();
      return;
    }
    if (key.return) {
      const text = buffer.trim();
      if (text && session) {
        manager.send(session.id, text);
        setBuffer('');
      }
      return;
    }
    const edit = editBuffer(buffer, input, key);
    if (edit.changed) {
      setBuffer(edit.value);
    }
  });

  if (!session) {
    return (
      <Box padding={1}>
        <Text dimColor>セッションが見つかりません。Esc で戻ります。</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" padding={1}>
      <Static items={session.messages}>{(m) => <LogLine key={m.seq} entry={m} />}</Static>

      <Box marginTop={1}>
        <Text bold>{session.title} </Text>
        <ProgressBadge state={session} />
        <Text dimColor> {session.branch}</Text>
      </Box>

      {session.progress ? (
        <Text dimColor>
          進捗 {session.progress.done}/{session.progress.total}
          {session.todos.find((t) => t.status === 'in_progress')?.activeForm
            ? ` — ${session.todos.find((t) => t.status === 'in_progress')?.activeForm}`
            : ''}
        </Text>
      ) : null}

      {session.error ? <Text color="red">error: {session.error}</Text> : null}

      {isTerminal && diff ? (
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>変更（{session.branch} vs ベース）:</Text>
          {diff.committed ? (
            <Text>{diff.committed}</Text>
          ) : (
            <Text dimColor>（コミット済みの変更なし）</Text>
          )}
          {diff.uncommitted.length > 0 ? (
            <Text color="yellow">未コミット {diff.uncommitted.length} 件</Text>
          ) : null}
        </Box>
      ) : null}

      {actionError ? <Text color="red">操作エラー: {actionError}</Text> : null}

      {pending ? (
        <Box marginTop={1}>
          <PermissionDialog
            request={pending}
            onAnswer={(answers) => manager.answer(session.id, answers)}
            onAllow={() => manager.allow(session.id)}
            onDeny={(message) => manager.deny(session.id, message)}
          />
        </Box>
      ) : panel === 'actions' ? (
        <Box
          flexDirection="column"
          marginTop={1}
          borderStyle="round"
          borderColor="blue"
          paddingX={1}
        >
          {confirm ? (
            <Text>
              {confirm === 'merge' ? 'ベースへマージします。' : 'worktree とブランチを破棄します。'}
              実行しますか？ <Text color="green">y</Text> / <Text color="red">n</Text>
              {busy ? <Text dimColor> …実行中</Text> : null}
            </Text>
          ) : (
            <>
              <Text color="blue" bold>
                操作
              </Text>
              <Text>
                <Text color="green">m</Text>: マージ（--no-ff） ・ <Text color="red">d</Text>:
                破棄（worktree削除）
              </Text>
            </>
          )}
        </Box>
      ) : (
        <Box marginTop={1}>
          <PromptInput value={buffer} focused placeholder="追加の指示を入力…" />
        </Box>
      )}

      <Box marginTop={1}>
        <Text dimColor>
          {pending
            ? 'Esc: 一覧へ戻る'
            : panel === 'actions'
              ? 'm/d: 操作 ・ Tab: 入力へ ・ Esc: 戻る'
              : 'Enter: 送信 ・ Tab: 操作 ・ Esc/←: 一覧へ戻る'}
        </Text>
      </Box>
    </Box>
  );
};
