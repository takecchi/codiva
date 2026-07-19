import { Box, type DOMElement, Text, useInput } from 'ink';
import { type FC, useRef, useState } from 'react';
import {
  bufferLines,
  bufferOf,
  COMMANDS,
  cursorRowCol,
  emptyBuffer,
  INPUT_MAX_ROWS,
  indexAtRowCol,
  isCommandInput,
  matchCommands,
  parseSgrMouse,
  runCommand,
  type SessionManager,
  type TextBuffer,
  totalCostUsd,
  visibleLineRange,
} from '@/core';
import { Banner } from './banner';
import { CommandPalette } from './command-palette';
import { useAbsolutePosition, useClock, useRunMode, useSessions } from './hooks';
import { useMessages } from './i18n-context';
import { caretIndexForColumn, editText, formatElapsed, resolveEnter } from './input';
import { PermissionDialog } from './permission-dialog';
import { ProgressBadge } from './progress-badge';
import { PromptInput } from './prompt-input';
import { StatusFooter } from './status-footer';
import { glyph, theme } from './theme';

/** Launch the selected session in the claude CLI; resolves when the user returns. */
export type OpenExternal = (id: string) => Promise<{ ok: boolean; error?: string }>;

/**
 * The single screen: composer (new-session prompt) + session rows. Two focus
 * zones — 'composer' (default: typing + full caret movement) and 'list'
 * (↑↓ selection, Enter → open in claude, m/d → merge/discard). Tab toggles.
 * When the selected session is blocked on a permission/question, the dialog
 * takes the composer's place and owns the keys while the list is focused.
 */
export const SessionList: FC<{
  manager: SessionManager;
  onOpenExternal?: OpenExternal;
  onQuit: () => void;
  cwd?: string;
  model?: string;
}> = ({ manager, onOpenExternal, onQuit, cwd, model }) => {
  const m = useMessages();
  const sessions = useSessions(manager);
  const mode = useRunMode(manager);
  const now = useClock(1000);
  const [buffer, setBuffer] = useState<TextBuffer>(emptyBuffer());
  // 同一チャンクで複数キーイベントが連続すると（連打・エスケープ列のまとめ読み）、
  // React の state はイベント間で更新されず stale closure になる。編集は必ず
  // この ref を経由して逐次適用し、描画用 state へ反映する。
  const bufferRef = useRef<TextBuffer>(buffer);
  const updateBuffer = (next: TextBuffer | ((prev: TextBuffer) => TextBuffer)) => {
    bufferRef.current = typeof next === 'function' ? next(bufferRef.current) : next;
    setBuffer(bufferRef.current);
  };
  const [focus, setFocus] = useState<'composer' | 'list'>('composer');
  const [sel, setSel] = useState(0);
  const [confirm, setConfirm] = useState<'merge' | 'discard' | null>(null);
  const [showHelp, setShowHelp] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | undefined>(undefined);
  const rowsRef = useRef<DOMElement>(null);
  const rowsBox = useAbsolutePosition(rowsRef);
  const composerRef = useRef<DOMElement>(null);
  const composerBox = useAbsolutePosition(composerRef);

  // Archived sessions sink to the bottom; Array.sort is stable so the rest keep
  // their creation order.
  const sorted = [...sessions].sort(
    (a, b) => (a.status === 'archived' ? 1 : 0) - (b.status === 'archived' ? 1 : 0),
  );
  const selected = Math.min(sel, Math.max(0, sorted.length - 1));
  const target = sorted[selected];
  // The dialog owns the keys only while the list side has focus, so the
  // composer is never hijacked mid-typing by a session that starts asking.
  const pending = focus === 'list' ? target?.pendingPermission : undefined;

  const moveSel = (delta: number) => {
    setSel((s) => Math.min(Math.max(0, s + delta), Math.max(0, sorted.length - 1)));
  };

  const openInClaude = () => {
    if (!target || busy) {
      return;
    }
    if (target.status === 'archived' || !target.sdkSessionId) {
      setActionError(m.list.openNotReady);
      return;
    }
    setBusy(true);
    onOpenExternal?.(target.id).then((result) => {
      setBusy(false);
      setActionError(result.ok ? undefined : result.error);
    });
  };

  /** Resolve a `/command` and perform its effect. Unknown names surface as errors. */
  const runCommandInput = (text: string) => {
    const result = runCommand(text);
    if (result.kind === 'unknown') {
      setActionError(m.command.unknown(result.name));
      return;
    }
    setActionError(undefined);
    switch (result.command.action) {
      case 'quit':
        onQuit();
        return;
      case 'help':
        setShowHelp(true);
        return;
    }
  };

  const runAction = (action: 'merge' | 'discard') => {
    if (!target) {
      return;
    }
    setBusy(true);
    const promise =
      action === 'merge' ? manager.merge(target.id) : manager.discard(target.id, { force: true });
    promise.then((result) => {
      setBusy(false);
      setConfirm(null);
      setActionError(result.ok ? undefined : result.error);
    });
  };

  /** Route a mouse press to the composer caret or a session row. */
  const handlePress = (x: number, y: number) => {
    if (composerBox) {
      const buf = bufferRef.current;
      const lines = bufferLines(buf.value);
      const caret = cursorRowCol(buf);
      const { start, end } = visibleLineRange(lines.length, caret.row, INPUT_MAX_ROWS);
      const contentTop = composerBox.top + 1; // +1 = 上ボーダー
      const clickedRow = start + (y - contentTop);
      if (clickedRow >= start && clickedRow < end) {
        const line = lines[clickedRow] ?? '';
        // プレフィックス（`❯ ` / 続き行の2スペース）ぶんの2セルを引いた表示列。
        const cells = x - composerBox.left - 2;
        const index = indexAtRowCol(buf.value, clickedRow, caretIndexForColumn(line, cells));
        updateBuffer(bufferOf(buf.value, index));
        setFocus('composer');
        return;
      }
    }
    if (rowsBox && y >= rowsBox.top && y < rowsBox.top + sorted.length) {
      setSel(y - rowsBox.top);
      setFocus('list');
    }
  };

  useInput((input, key) => {
    // SGR マウスレポートはキー入力より先に解釈する（バッファへ混入させない）。
    const mouse = parseSgrMouse(input);
    if (mouse) {
      if (mouse.kind === 'press') {
        handlePress(mouse.x, mouse.y);
      }
      return;
    }
    if (key.ctrl && input === 'c') {
      onQuit();
      return;
    }
    if (key.tab && key.shift) {
      manager.cycleMode();
      return;
    }
    // The /help overlay is modal-lite: any key dismisses it (and is swallowed so
    // it doesn't also edit/navigate underneath).
    if (showHelp) {
      setShowHelp(false);
      return;
    }
    if (busy) {
      return;
    }
    if (pending) {
      // PermissionDialog owns the keys. Selection still moves via PgUp/PgDn
      // (and ↑↓ for y/n tool prompts, which don't use arrows themselves).
      if (key.pageUp || (pending.kind === 'tool' && key.upArrow)) {
        moveSel(-1);
        return;
      }
      if (key.pageDown || (pending.kind === 'tool' && key.downArrow)) {
        moveSel(1);
        return;
      }
      if (key.tab || key.escape) {
        setFocus('composer');
      }
      return;
    }
    if (confirm) {
      if (input === 'y' || input === 'Y') {
        runAction(confirm);
      } else if (input === 'n' || input === 'N' || key.escape) {
        setConfirm(null);
      }
      return;
    }
    if (key.tab) {
      setFocus((f) => (f === 'composer' ? 'list' : 'composer'));
      return;
    }

    if (focus === 'list') {
      if (key.upArrow) {
        moveSel(-1);
        return;
      }
      if (key.downArrow) {
        moveSel(1);
        return;
      }
      if (key.return || key.rightArrow) {
        openInClaude();
        return;
      }
      if (input === 'm' || input === 'M') {
        setConfirm('merge');
        return;
      }
      if (input === 'd' || input === 'D') {
        setConfirm('discard');
        return;
      }
      if (key.escape) {
        setFocus('composer');
        return;
      }
      // 印字キーはそのまま入力欄へ — フォーカスを戻して打ち始められるように。
      if (input.length > 0 && !key.ctrl && !key.meta) {
        const edit = editText(bufferRef.current, input, key);
        if (edit.changed) {
          updateBuffer(edit.buffer);
          setFocus('composer');
        }
      }
      return;
    }

    // composer focus: full caret movement, Enter submits / breaks lines.
    if (key.return) {
      const enter = resolveEnter(bufferRef.current, key);
      if (enter.kind === 'newline') {
        updateBuffer(enter.buffer);
        return;
      }
      if (enter.text === '') {
        // 空 Enter は一覧へフォーカス（誤爆で claude を開かない）。
        setFocus('list');
        return;
      }
      // 先頭が `/` はコマンド。通常の指示（manager.create）と分岐する。
      if (isCommandInput(enter.text)) {
        runCommandInput(enter.text);
        updateBuffer(emptyBuffer());
        return;
      }
      manager.create(enter.text);
      updateBuffer(emptyBuffer());
      return;
    }
    const edit = editText(bufferRef.current, input, key, { arrows: true, vertical: true });
    if (edit.changed) {
      updateBuffer(edit.buffer);
    }
  });

  const footerHint = pending
    ? m.list.helpPending
    : focus === 'list'
      ? m.list.helpList
      : m.list.helpComposer;

  return (
    <Box flexDirection="column" flexGrow={1} padding={1}>
      <Banner
        cwd={cwd}
        model={model}
        sessionCount={sessions.length}
        totalCostUsd={totalCostUsd(sessions)}
      />

      {/* flexGrow で残り高さを占め、入力欄とフッタを画面最下部へ押し下げる */}
      <Box ref={rowsRef} flexDirection="column" marginY={1} flexGrow={1} overflowY="hidden">
        {sorted.length === 0 ? (
          <Text dimColor>{m.list.emptyHint}</Text>
        ) : (
          sorted.map((s, i) => {
            const attention = s.status === 'awaiting_input' || s.status === 'awaiting_permission';
            const archived = s.status === 'archived';
            const isSel = i === selected;
            return (
              <Box key={s.id}>
                <Text color={focus === 'list' ? theme.accent : theme.dim}>
                  {isSel ? `${glyph.caret} ` : '  '}
                </Text>
                <Box width={2}>
                  <Text color={s.status === 'awaiting_input' ? 'magenta' : 'yellow'}>
                    {attention ? glyph.attention : ' '}
                  </Text>
                </Box>
                {/* title/branch は固定幅だと広い端末でも切り詰められる。flexGrow で
                    残り幅を title:branch = 3:2 で分配し、狭いときは minWidth まで縮む。 */}
                <Box flexGrow={3} flexBasis={0} minWidth={20} marginRight={1}>
                  <Text bold={isSel || attention} dimColor={archived} wrap="truncate-end">
                    {s.title}
                  </Text>
                </Box>
                <Box width={12}>
                  <ProgressBadge state={s} />
                </Box>
                <Box flexGrow={2} flexBasis={0} minWidth={16} marginRight={1}>
                  <Text dimColor wrap="truncate-end">
                    {s.branch}
                  </Text>
                </Box>
                <Text dimColor>{formatElapsed(s.startedAt, s.finishedAt ?? now)}</Text>
              </Box>
            );
          })
        )}
      </Box>

      {actionError ? (
        <Text color="red">
          {m.list.actionErrorLabel}: {actionError}
        </Text>
      ) : null}
      {confirm ? (
        <Box borderStyle="round" borderColor="blue" paddingX={1}>
          <Text>
            {confirm === 'merge' ? m.list.mergePrompt : m.list.discardPrompt} {m.list.confirmRun}{' '}
            <Text color="green">y</Text> / <Text color="red">n</Text>
            {busy ? <Text dimColor> {m.list.busySuffix}</Text> : null}
          </Text>
        </Box>
      ) : null}

      {showHelp && !pending ? (
        <CommandPalette title={m.command.helpTitle} commands={COMMANDS} />
      ) : null}

      {pending && target ? (
        <PermissionDialog
          request={pending}
          onAnswer={(answers) => manager.answer(target.id, answers)}
          onAllow={() => manager.allow(target.id)}
          onDeny={(message) => manager.deny(target.id, message)}
        />
      ) : (
        <Box ref={composerRef} flexDirection="column">
          {focus === 'composer' && isCommandInput(buffer.value) ? (
            <CommandPalette title={m.command.paletteTitle} commands={matchCommands(buffer.value)} />
          ) : null}
          <PromptInput
            buffer={buffer}
            focused={focus === 'composer'}
            placeholder={m.list.promptPlaceholder}
          />
        </Box>
      )}
      <StatusFooter mode={mode} hint={footerHint} />
    </Box>
  );
};
