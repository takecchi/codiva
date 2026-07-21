import { Box, type DOMElement, Text, useInput, useWindowSize } from 'ink';
import { type FC, useEffect, useMemo, useRef, useState } from 'react';
import {
  bufferOf,
  COMMANDS,
  caretIndexAtClick,
  type DiffStat,
  type DisplayLine,
  emptyBuffer,
  INPUT_MAX_ROWS,
  isCommandInput,
  isTerminalStatus,
  type LogEntry,
  logLines,
  logViewportRows,
  logWindow,
  matchCommands,
  parseSgrMouse,
  type ScrollAnchor,
  type SessionManager,
  scrollDown,
  scrollUp,
  streamTail,
  WHEEL_SCROLL_ROWS,
} from '@/core';
import { CommandPalette } from './command-palette';
import { ConfirmPrompt } from './confirm-prompt';
import { DialogBox } from './dialog-box';
import {
  useAbsolutePosition,
  useCommandRunner,
  useComposerSelection,
  useLifecycleAction,
  useRunMode,
  useSessions,
  useTextBufferRef,
} from './hooks';
import { useMessages } from './i18n-context';
import { editText, normalizeChord, resolveEnter } from './input';
import { ModelSelect } from './model-select';
import { PermissionDialog } from './permission-dialog';
import { PromptInput } from './prompt-input';
import { StatusFooter } from './status-footer';
import { glyph, logColor, statusColor, theme } from './theme';

/** Prefix/indent for each log kind — echoes Claude Code's transcript. Colors live in `logColor`. */
const LOG_PREFIX: Record<LogEntry['kind'], string> = {
  assistant_text: '',
  tool_use: `${glyph.bullet} `,
  tool_result: `  ${glyph.branch} `,
  result: '',
  user: '> ',
  system: '',
  error: '✗ ',
};

/** Kinds rendered dimmed (secondary transcript lines). */
const LOG_DIM: Partial<Record<LogEntry['kind'], boolean>> = { tool_result: true };

// One physical row of the log. `line.text` already carries the kind's prefix /
// continuation indent (built by core's logLines); truncate is only a safety net
// against width drift — wrapping happened in core at the exact content width.
const LogLine: FC<{ line: DisplayLine }> = ({ line }) => (
  <Text color={logColor[line.kind]} dimColor={LOG_DIM[line.kind]} wrap="truncate-end">
    {line.text}
  </Text>
);

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
  onQuit: () => void;
  /** コンポーザのマウス選択をクリップボードへコピーする（index.tsx が OSC 52 を注入）。 */
  onCopy?: (text: string) => void;
}> = ({ manager, id, onBack, onQuit, onCopy }) => {
  const m = useMessages();
  const sessions = useSessions(manager);
  const mode = useRunMode(manager);
  const { rows, columns } = useWindowSize();
  const session = sessions.find((s) => s.id === id);
  const { buffer, bufferRef, updateBuffer } = useTextBufferRef();
  // フォローアップ入力欄のマウス範囲選択（ドラッグで選択→離すとコピー）。
  const sel = useComposerSelection(onCopy);
  const composerRef = useRef<DOMElement>(null);
  const composerBox = useAbsolutePosition(composerRef);
  // Log scroll position; 'bottom' follows the newest line (see core/scroll.ts).
  const [anchor, setAnchor] = useState<ScrollAnchor>('bottom');
  const [panel, setPanel] = useState<'input' | 'actions'>('input');
  // Open when the user runs `/model`; the ModelSelect dialog then owns the keys.
  const [modelSelect, setModelSelect] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [diff, setDiff] = useState<DiffStat | undefined>(undefined);
  // 変更差分サマリは既定で畳んでおき（ログの縦幅を優先）、`/diff` でトグルする。
  const [showChanges, setShowChanges] = useState(false);
  // 確認/実行中/エラー + マージ・破棄の実行は共有フックへ。成功時は入力パネルへ戻す。
  const { confirm, setConfirm, busy, actionError, setActionError, run } = useLifecycleAction(
    manager,
    id,
    (ok) => {
      if (ok) {
        setPanel('input');
      }
    },
  );

  const pending = session?.pendingPermission;
  const status = session?.status;
  const isTerminal = status !== undefined && isTerminalStatus(status);

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

  // `/diff` は詳細ビュー固有（変更差分サマリのトグル）。他は両ビュー共通。
  const runCommandInput = useCommandRunner(
    {
      exit: onQuit,
      help: () => setShowHelp(true),
      // `/model` opens the picker; the pick applies to THIS session only.
      model: () => setModelSelect(true),
      // `/diff` toggles the changes summary (hidden by default for log room).
      diff: () => setShowChanges((v) => !v),
    },
    setActionError,
    m.command.unknown,
  );

  // Expand entries into physical rows once per (messages, width) — the scroll
  // model (anchor/steps/hidden counts) works in rows, so multi-line messages
  // scroll smoothly instead of jumping an entry at a time. Width accounts for
  // the view's horizontal padding (1 cell each side).
  const messages = session?.messages;
  const lines = useMemo<DisplayLine[]>(
    () =>
      messages ? logLines(messages, Math.max(1, columns - 2), (kind) => LOG_PREFIX[kind]) : [],
    [messages, columns],
  );
  const total = lines.length;

  /** Caret index for a mouse point inside the composer, or undefined if outside. */
  const composerCaretAt = (x: number, y: number): number | undefined => {
    if (!composerBox) {
      return undefined;
    }
    return caretIndexAtClick(
      bufferRef.current,
      y - (composerBox.top + 1),
      x - composerBox.left - 2,
      INPUT_MAX_ROWS,
    );
  };

  useInput((rawInput, rawKey) => {
    // SGR マウスレポートはキー入力より先に解釈する。これをしないと（マウス有効時に）
    // ホイールスクロールのエスケープ列が生テキストとして editText に流れ込み、
    // 「スクロールしようとすると文字が入力される」バグになる（一覧の useInput と同じ対策）。
    const mouse = parseSgrMouse(rawInput);
    if (mouse) {
      if (mouse.kind === 'wheel') {
        setAnchor((a) =>
          mouse.dir === 'up'
            ? scrollUp(a, total, WHEEL_SCROLL_ROWS)
            : scrollDown(a, total, WHEEL_SCROLL_ROWS),
        );
      } else if (mouse.kind === 'press') {
        // コンポーザ内のクリックはキャレット移動 + 選択アンカー。欄外は選択解除。
        const index = composerCaretAt(mouse.x, mouse.y);
        if (index !== undefined) {
          updateBuffer(bufferOf(bufferRef.current.value, index));
          sel.begin(index);
        } else {
          sel.clear();
        }
      } else if (mouse.kind === 'drag') {
        if (sel.dragging()) {
          const index = composerCaretAt(mouse.x, mouse.y);
          if (index !== undefined) {
            updateBuffer(bufferOf(bufferRef.current.value, index));
            sel.extend(index);
          }
        }
      } else if (mouse.kind === 'release') {
        sel.end(bufferRef.current.value); // 離した時点で 1 回だけコピー
      }
      return;
    }
    // Shift+Enter 等の修飾キーは modifyOtherKeys / CSI-u エスケープで届き、Ink は
    // 生テキストとして渡す。一覧と同じ共通ヘルパーで実キーへ復号し、Enter/改行/
    // Tab/Esc の挙動を両画面で揃える（詳細で Shift+Enter が改行にならない不具合対策）。
    const { input, key } = normalizeChord(rawInput, rawKey);
    // 何かキーが来たらマウス選択のハイライトは消す。
    sel.clear();
    // The model picker is modal: its own useInput owns arrows/Enter/Esc. Swallow
    // everything here so nothing leaks through to the composer underneath.
    if (modelSelect) {
      return;
    }
    // The /help overlay is dismissed by any key (swallowed so it doesn't also
    // edit/navigate underneath).
    if (showHelp) {
      setShowHelp(false);
      return;
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
      // A leading `/` is a command (e.g. /model), not a follow-up instruction.
      if (isCommandInput(enter.text)) {
        runCommandInput(enter.text);
        updateBuffer(emptyBuffer());
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

  const footerHint = modelSelect
    ? m.model.help
    : pending
      ? m.detail.helpPending
      : panel === 'actions'
        ? m.detail.helpActions
        : m.detail.helpInput;
  const win = logWindow(lines, rows, anchor);
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
        {win.entries.map((line) => (
          <LogLine key={line.key} line={line} />
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
          <Text color={theme.warn} dimColor>
            {m.detail.scrollHint(win.hiddenBelow)}
          </Text>
        </Box>
      ) : null}

      <Box flexDirection="column" marginTop={1} flexShrink={0}>
        {isTerminal && diff && showChanges ? (
          <Box flexDirection="column" marginBottom={1}>
            <Text dimColor>{m.detail.changesTitle(session.branch)}</Text>
            {diff.committed ? (
              <Text>{diff.committed}</Text>
            ) : (
              <Text dimColor>{m.detail.noCommittedChanges}</Text>
            )}
            {diff.uncommitted.length > 0 ? (
              <Text color={theme.warn}>{m.detail.uncommitted(diff.uncommitted.length)}</Text>
            ) : null}
          </Box>
        ) : null}

        {actionError ? (
          <Text color={statusColor.failed}>
            {m.action.actionErrorLabel}: {actionError}
          </Text>
        ) : null}
        {showHelp && !pending ? (
          <CommandPalette title={m.command.helpTitle} commands={COMMANDS} />
        ) : null}

        {modelSelect ? (
          <ModelSelect
            // The session's live (resolved) model — pre-selects the current row.
            current={session.model}
            onSelect={(model) => {
              manager.setSessionModel(session.id, model);
              setModelSelect(false);
              setAnchor('bottom');
            }}
            onCancel={() => setModelSelect(false)}
          />
        ) : pending ? (
          <PermissionDialog
            request={pending}
            onAnswer={(answers) => manager.answer(session.id, answers)}
            onAllow={() => manager.allow(session.id)}
            onDeny={(message) => manager.deny(session.id, message)}
          />
        ) : panel === 'actions' ? (
          <DialogBox flexDirection="column">
            {confirm ? (
              <ConfirmPrompt kind={confirm} busy={busy} />
            ) : (
              <>
                <Text color={theme.accent} bold>
                  {m.detail.actionsTitle}
                </Text>
                <Text>
                  <Text color={theme.yes}>m</Text>: {m.detail.mergeAction} ・{' '}
                  <Text color={theme.no}>d</Text>: {m.detail.discardAction}
                </Text>
              </>
            )}
          </DialogBox>
        ) : (
          <Box ref={composerRef} flexDirection="column">
            {isCommandInput(buffer.value) ? (
              <CommandPalette
                title={m.command.paletteTitle}
                commands={matchCommands(buffer.value)}
              />
            ) : null}
            <PromptInput
              buffer={buffer}
              focused
              placeholder={m.detail.followupPlaceholder}
              selection={sel.selection}
            />
          </Box>
        )}

        <StatusFooter mode={mode} hint={footerHint} />
      </Box>
    </Box>
  );
};
