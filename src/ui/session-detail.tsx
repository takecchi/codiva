import { Box, Text, useInput, useWindowSize } from 'ink';
import { type FC, useEffect, useRef, useState } from 'react';
import {
  type DiffStat,
  emptyBuffer,
  type LogEntry,
  logViewportRows,
  logWindow,
  parseSgrMouse,
  type ScrollAnchor,
  type SessionManager,
  scrollDown,
  scrollUp,
  type TextBuffer,
  WHEEL_SCROLL_ROWS,
} from '@/core';
import { useRunMode, useSessions } from './hooks';
import { useMessages } from './i18n-context';
import { editText, resolveEnter } from './input';
import { PermissionDialog } from './permission-dialog';
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

const TERMINAL = new Set(['completed', 'interrupted', 'failed', 'archived']);

/** The live-typing preview: the last non-empty line of the streamed text so far. */
function streamTail(text: string): string {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (line && line.length > 0) {
      return line;
    }
  }
  return '';
}

const LogLine: FC<{ entry: LogEntry }> = ({ entry }) => {
  const spec = LOG[entry.kind];
  return (
    <Text color={spec.color} dimColor={spec.dim} wrap="truncate-end">
      {spec.prefix}
      {entry.text}
    </Text>
  );
};

/**
 * The in-app detail view: live log of a single session plus a follow-up
 * composer. Reconnects to the running SDK session (no external CLI) — send
 * routes straight to `manager.send`, and merge/discard live in an actions panel.
 *
 * A single `useInput` runs a small state machine (panel = input | actions) so
 * typing and command keys never collide (see .claude/rules/ink-components.md).
 * When the session is blocked on a permission/question, the dialog owns the keys.
 */
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
  const [buffer, setBuffer] = useState<TextBuffer>(emptyBuffer());
  // 一覧と同じ理由（連打・ペースト・エスケープ列が同一 tick に複数回届く）で、
  // バッファ編集は ref を経由して逐次適用し、描画用 state へ反映する。
  const bufferRef = useRef<TextBuffer>(buffer);
  const updateBuffer = (next: TextBuffer | ((prev: TextBuffer) => TextBuffer)) => {
    bufferRef.current = typeof next === 'function' ? next(bufferRef.current) : next;
    setBuffer(bufferRef.current);
  };
  // Log scroll position; 'bottom' follows the newest line (see core/scroll.ts).
  const [anchor, setAnchor] = useState<ScrollAnchor>('bottom');
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

  const total = session?.messages.length ?? 0;

  useInput((input, key) => {
    // SGR マウスレポートはキー入力より先に解釈する。これをしないと（マウス有効時に）
    // ホイールスクロールのエスケープ列が生テキストとして editText に流れ込み、
    // 「スクロールしようとすると文字が入力される」バグになる（一覧の useInput と同じ対策）。
    const mouse = parseSgrMouse(input);
    if (mouse) {
      if (mouse.kind === 'wheel') {
        setAnchor((a) =>
          mouse.dir === 'up'
            ? scrollUp(a, total, WHEEL_SCROLL_ROWS)
            : scrollDown(a, total, WHEEL_SCROLL_ROWS),
        );
      }
      return; // press/release はログビューでは無視（クリック操作はない）
    }
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
    // Log scroll (terminal scrollback is disabled under the alt screen). The
    // step is derived from the *visible* log height, not the full terminal, so a
    // page never jumps past unseen lines.
    if (key.pageUp) {
      setAnchor((a) => scrollUp(a, total, logViewportRows(rows)));
      return;
    }
    if (key.pageDown) {
      setAnchor((a) => scrollDown(a, total, logViewportRows(rows)));
      return;
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
    // input panel (multi-line composer; arrows move the caret, Esc goes back)
    if (key.return) {
      const enter = resolveEnter(bufferRef.current, key);
      if (enter.kind === 'newline') {
        updateBuffer(enter.buffer);
        return;
      }
      if (enter.text && session) {
        manager.send(session.id, enter.text);
        updateBuffer(emptyBuffer());
        setAnchor('bottom'); // jump back to the tail to watch the new turn
      }
      return;
    }
    const edit = editText(bufferRef.current, input, key, { arrows: true, vertical: true });
    if (edit.changed) {
      updateBuffer(edit.buffer);
    }
  });

  if (!session) {
    return (
      <Box flexGrow={1} padding={1}>
        <Text dimColor>{m.detail.notFound}</Text>
      </Box>
    );
  }

  const footerHint = pending
    ? m.detail.helpPending
    : panel === 'actions'
      ? m.detail.helpActions
      : m.detail.helpInput;
  const win = logWindow(session.messages, rows, anchor);
  const preview = session.streamingText ? streamTail(session.streamingText) : '';

  return (
    <Box flexDirection="column" flexGrow={1} padding={1}>
      {/*
       * ヘッダは持たない（要件: セッション詳細はコンテンツ + フッタのみ）。
       * メッセージログの末尾ビューポートが上端いっぱいまで残り高さを占める。
       * flexGrow で残りを占め、justifyContent="flex-end" + overflowY="hidden" で
       * 「最新行が下端、溢れた古い行は上へクリップ」にする。<Static> はスクロール
       * バック側に書くため全画面レイアウトでは画面外に消えてしまい使えない。
       */}
      <Box flexDirection="column" flexGrow={1} overflowY="hidden" justifyContent="flex-end">
        {win.entries.map((entry) => (
          <LogLine key={entry.seq} entry={entry} />
        ))}
        {/* Live streaming preview, only while following the tail. */}
        {win.atBottom && preview ? (
          <Text color={theme.accent} dimColor wrap="truncate-end">
            {preview}
          </Text>
        ) : null}
      </Box>

      {/* Scrollback indicator: shown only when the view is lifted off the tail. */}
      {!win.atBottom ? (
        <Box flexShrink={0}>
          <Text color="yellow" dimColor>
            {m.detail.scrollHint(win.hiddenBelow)}
          </Text>
        </Box>
      ) : null}

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
          <PromptInput buffer={buffer} focused placeholder={m.detail.followupPlaceholder} />
        )}

        <StatusFooter mode={mode} hint={footerHint} />
      </Box>
    </Box>
  );
};
