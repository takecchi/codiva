import { Box, Text, useInput, useWindowSize } from 'ink';
import { type FC, useEffect, useState } from 'react';
import { type DiffStat, type LogEntry, type SessionManager, tailMessages } from '@/core';
import { useRunMode, useSessions } from './hooks';
import { useMessages } from './i18n-context';
import { editBuffer } from './input';
import { PermissionDialog } from './permission-dialog';
import { ProgressBadge } from './progress-badge';
import { PromptInput } from './prompt-input';
import { StatusFooter } from './status-footer';
import { glyph, theme } from './theme';

/** How each log kind is prefixed/colored — chosen to echo Claude Code's transcript. */
const LOG: Record<LogEntry['kind'], { prefix: string; color?: string; dim?: boolean }> = {
  assistant_text: { prefix: '' },
  tool_use: { prefix: `${glyph.bullet} `, color: theme.accent },
  tool_result: { prefix: `  ${glyph.branch} `, color: 'gray', dim: true },
  result: { prefix: '', color: 'green' },
  user: { prefix: '> ', color: 'cyan' },
  system: { prefix: '', color: 'yellow' },
  error: { prefix: '✗ ', color: 'red' },
};

const TERMINAL = new Set(['completed', 'failed', 'archived']);

const LogLine: FC<{ entry: LogEntry }> = ({ entry }) => {
  const spec = LOG[entry.kind];
  return (
    <Text color={spec.color} dimColor={spec.dim} wrap="truncate-end">
      {spec.prefix}
      {entry.text}
    </Text>
  );
};

export const SessionDetail: FC<{
  manager: SessionManager;
  id: string;
  onBack: () => void;
}> = ({ manager, id, onBack }) => {
  const m = useMessages();
  const sessions = useSessions(manager);
  const mode = useRunMode(manager);
  const { rows } = useWindowSize();
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
    if (key.tab && key.shift) {
      manager.cycleMode();
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
      <Box flexGrow={1} padding={1}>
        <Text dimColor>{m.detail.notFound}</Text>
      </Box>
    );
  }

  const activeForm = session.todos.find((t) => t.status === 'in_progress')?.activeForm;
  const footerHint = pending
    ? m.detail.helpPending
    : panel === 'actions'
      ? m.detail.helpActions
      : m.detail.helpInput;

  return (
    <Box flexDirection="column" flexGrow={1} padding={1}>
      {/* ステータスヘッダ（画面上部に固定） */}
      <Box flexDirection="column" flexShrink={0}>
        <Box>
          <Text color={theme.accent}>{glyph.star} </Text>
          <Text bold>{session.title} </Text>
          <ProgressBadge state={session} />
          <Text dimColor>
            {'   '}
            {session.branch}
          </Text>
        </Box>

        {session.progress ? (
          <Text dimColor>
            {m.detail.progress(session.progress.done, session.progress.total, activeForm)}
          </Text>
        ) : null}

        {session.error ? (
          <Text color="red">
            {m.detail.errorLabel}: {session.error}
          </Text>
        ) : null}
      </Box>

      {/*
       * メッセージログの末尾ビューポート。flexGrow で残り高さを占め、
       * justifyContent="flex-end" + overflowY="hidden" で「最新行が下端、
       * 溢れた古い行は上へクリップ」にする。<Static> はスクロールバック側に
       * 書くため全画面レイアウトでは画面外に消えてしまい使えない。
       */}
      <Box
        flexDirection="column"
        flexGrow={1}
        marginTop={1}
        overflowY="hidden"
        justifyContent="flex-end"
      >
        {tailMessages(session.messages, rows).map((entry) => (
          <LogLine key={entry.seq} entry={entry} />
        ))}
      </Box>

      <Box flexDirection="column" marginTop={1} flexShrink={0}>
        {isTerminal && diff ? (
          <Box flexDirection="column" marginBottom={1}>
            <Text dimColor>{m.detail.changesTitle(session.branch)}</Text>
            {diff.committed ? (
              <Text>{diff.committed}</Text>
            ) : (
              <Text dimColor>{m.detail.noCommittedChanges}</Text>
            )}
            {diff.uncommitted.length > 0 ? (
              <Text color="yellow">{m.detail.uncommitted(diff.uncommitted.length)}</Text>
            ) : null}
          </Box>
        ) : null}

        {actionError ? (
          <Text color="red">
            {m.detail.actionErrorLabel}: {actionError}
          </Text>
        ) : null}
        {pending ? (
          <PermissionDialog
            request={pending}
            onAnswer={(answers) => manager.answer(session.id, answers)}
            onAllow={() => manager.allow(session.id)}
            onDeny={(message) => manager.deny(session.id, message)}
          />
        ) : panel === 'actions' ? (
          <Box flexDirection="column" borderStyle="round" borderColor="blue" paddingX={1}>
            {confirm ? (
              <Text>
                {confirm === 'merge' ? m.detail.mergePrompt : m.detail.discardPrompt}{' '}
                {m.detail.confirmRun} <Text color="green">y</Text> / <Text color="red">n</Text>
                {busy ? <Text dimColor> {m.detail.busySuffix}</Text> : null}
              </Text>
            ) : (
              <>
                <Text color="blue" bold>
                  {m.detail.actionsTitle}
                </Text>
                <Text>
                  <Text color="green">m</Text>: {m.detail.mergeAction} ・ <Text color="red">d</Text>
                  : {m.detail.discardAction}
                </Text>
              </>
            )}
          </Box>
        ) : (
          <PromptInput value={buffer} focused placeholder={m.detail.followupPlaceholder} />
        )}

        <StatusFooter mode={mode} hint={footerHint} />
      </Box>
    </Box>
  );
};
