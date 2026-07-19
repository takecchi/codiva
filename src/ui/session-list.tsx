import { Box, type DOMElement, type Key, Text, useInput, useWindowSize } from 'ink';
import { type FC, useRef, useState } from 'react';
import {
  bufferLines,
  bufferOf,
  COMMANDS,
  cursorRowCol,
  decodeKeySequence,
  emptyBuffer,
  formatModel,
  INPUT_MAX_ROWS,
  indexAtRowCol,
  isCommandInput,
  isFullscreenViewport,
  listView,
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
import { useAbsolutePosition, useBoxHeight, useClock, useRunMode, useSessions } from './hooks';
import { useMessages } from './i18n-context';
import { caretIndexForColumn, editText, formatElapsed, resolveEnter } from './input';
import { ModelSelect } from './model-select';
import { PermissionDialog } from './permission-dialog';
import { ProgressBadge } from './progress-badge';
import { PromptInput } from './prompt-input';
import { StatusFooter } from './status-footer';
import { glyph, statusColor, theme } from './theme';

/** Open a PR web URL in the browser (fire-and-forget). */
export type OpenPr = (url: string) => void;

/**
 * Display width of the trailing `#<n>` PR cell. It's the row's last column, so it
 * sits flush at the right edge regardless of the responsive title/branch widths —
 * which lets mouse hit-testing locate it from the terminal width alone.
 */
const PR_CELL_WIDTH = 8;

/**
 * The single screen: composer (new-session prompt) + session rows. Two focus
 * zones — 'composer' (default: typing + full caret movement) and 'list'
 * (↑↓ selection, Enter/→ → open the in-app detail view, m/d → merge/discard).
 * Tab toggles. When the selected session is blocked on a permission/question,
 * the dialog takes the composer's place and owns the keys while the list is
 * focused.
 */
export const SessionList: FC<{
  manager: SessionManager;
  onOpen: (id: string) => void;
  onOpenPr?: OpenPr;
  onQuit: () => void;
  cwd?: string;
  model?: string;
}> = ({ manager, onOpen, onOpenPr, onQuit, cwd, model }) => {
  const m = useMessages();
  const sessions = useSessions(manager);
  const mode = useRunMode(manager);
  const now = useClock(1000);
  // 端末幅は PR セル（行末の固定幅列）のクリック当たり判定に、端末高は一覧の
  // 内部スクロール（収まる行数の算出）に使う。いずれもリサイズ追従。
  const { columns, rows: termRows } = useWindowSize();
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
  // Open when the user runs `/model`; the ModelSelect dialog then owns the keys.
  const [modelSelect, setModelSelect] = useState(false);
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

  // 一覧の内部スクロール: rows ボックスは flexGrow で残り高さを占めるので、その
  // 実測高さぶんだけ項目を描画し、選択が常に見えるようウィンドウを動かす。全画面
  // でないインライン描画時はクリップされないため全件描画（端末側スクロールに任せる）。
  const fullscreen = isFullscreenViewport(termRows);
  const listHeight = useBoxHeight(rowsRef);
  const listCap = fullscreen
    ? Math.max(1, listHeight ?? Math.max(1, termRows - 15))
    : Math.max(1, sorted.length);
  const view = listView(sorted.length, selected, listCap);

  const moveSel = (delta: number) => {
    setSel((s) => Math.min(Math.max(0, s + delta), Math.max(0, sorted.length - 1)));
  };

  const openDetail = () => {
    if (!target || busy) {
      return;
    }
    onOpen(target.id);
  };

  /** Open the selected session's PR in the browser, if it has one. */
  const openPr = () => {
    if (target?.pr && onOpenPr) {
      onOpenPr(target.pr.url);
    }
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
      case 'model':
        // `/model` はセッションを作らずモデル選択ダイアログを開く。
        setModelSelect(true);
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
    if (rowsBox) {
      // rows ボックス内の行 → セッションインデックス。上インジケータ行があれば
      // その 1 行ぶんずらし、可視ウィンドウ（view.start..end）へ写像する。
      const rowLine = y - rowsBox.top - (view.showAbove ? 1 : 0);
      const visibleCount = view.end - view.start;
      if (rowLine >= 0 && rowLine < visibleCount) {
        const idx = view.start + rowLine;
        setSel(idx);
        setFocus('list');
        // A click inside the trailing `#<n>` cell of a row with a PR opens it in the
        // browser. The cell is right-anchored, so derive its x-range from the terminal
        // width (outer padding is symmetric, so the right pad equals rowsBox.left).
        const s = sorted[idx];
        if (s?.pr && onOpenPr) {
          const cellLeft = columns - rowsBox.left - PR_CELL_WIDTH;
          if (x >= cellLeft && x < cellLeft + PR_CELL_WIDTH) {
            onOpenPr(s.pr.url);
          }
        }
      }
    }
  };

  useInput((rawInput, rawKey) => {
    // SGR マウスレポートはキー入力より先に解釈する（バッファへ混入させない）。
    const mouse = parseSgrMouse(rawInput);
    if (mouse) {
      if (mouse.kind === 'press') {
        handlePress(mouse.x, mouse.y);
      }
      return;
    }
    // Shift+Enter 等の修飾キーは modifyOtherKeys / CSI-u エスケープ（`[27;2;13~`）
    // で届く。Ink はこれを解釈できず生テキストとして渡すため、ここで実キーへ
    // 復号して以降の処理（resolveEnter / editText）に正しい chord を渡す。
    const chord = decodeKeySequence(rawInput);
    const key: Key = chord
      ? {
          ...rawKey,
          shift: chord.shift,
          ctrl: chord.ctrl,
          meta: chord.meta,
          return: chord.kind === 'return',
          tab: chord.kind === 'tab',
          escape: chord.kind === 'escape',
          backspace: chord.kind === 'backspace',
        }
      : rawKey;
    const input = chord ? (chord.kind === 'text' ? chord.text : '') : rawInput;
    if (key.ctrl && input === 'c') {
      onQuit();
      return;
    }
    // The model picker is modal: it owns the keys (its own useInput handles
    // arrows/Enter/Esc). Ignore everything else here so nothing leaks through.
    if (modelSelect) {
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
        openDetail();
        return;
      }
      if (input === 'p' || input === 'P') {
        openPr();
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
        // 空 Enter は一覧へフォーカス（誤爆で詳細ビューを開かない）。
        setFocus('list');
        return;
      }
      // 先頭が `/` はコマンド。通常の指示（manager.create）と分岐する。
      // `/model` はコマンドレジストリ経由でモデル選択ダイアログを開く。
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

  const footerHint = modelSelect
    ? m.model.help
    : pending
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

      {/* flexGrow で残り高さを占め、入力欄とフッタを画面最下部へ押し下げる。
          高さを実測し、その行数に収まるぶんだけ内部スクロールして描画する。 */}
      <Box ref={rowsRef} flexDirection="column" marginY={1} flexGrow={1} overflowY="hidden">
        {sorted.length === 0 ? (
          <Text dimColor>{m.list.emptyHint}</Text>
        ) : (
          <>
            {view.showAbove ? <Text dimColor>{m.list.moreAbove(view.hiddenAbove)}</Text> : null}
            {sorted.slice(view.start, view.end).map((s, i) => {
              const idx = view.start + i;
              const attention = s.status === 'awaiting_input' || s.status === 'awaiting_permission';
              const archived = s.status === 'archived';
              const isSel = idx === selected;
              return (
                <Box key={s.id}>
                  <Text color={focus === 'list' ? theme.accent : theme.dim}>
                    {isSel ? `${glyph.caret} ` : '  '}
                  </Text>
                  <Box width={2}>
                    <Text
                      color={
                        s.status === 'awaiting_input'
                          ? statusColor.awaitingInput
                          : statusColor.awaitingPermission
                      }
                    >
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
                  {/* 各セッションが実際に走っているモデル（SDK 由来の解決済み値）。
                      バナーの設定モデルと異なりうる。未取得なら空欄。 */}
                  <Box width={11} marginRight={1}>
                    <Text dimColor wrap="truncate-end">
                      {formatModel(s.model) ?? ''}
                    </Text>
                  </Box>
                  <Box flexGrow={2} flexBasis={0} minWidth={16} marginRight={1}>
                    <Text dimColor wrap="truncate-end">
                      {s.branch}
                    </Text>
                  </Box>
                  <Text dimColor>{formatElapsed(s.startedAt, s.finishedAt ?? now)}</Text>
                  {/* PR バッジは行末の固定幅列。右端に揃うので幅可変の title/branch に
                      左右されず、端末幅からクリック位置を逆算できる（handlePress）。 */}
                  <Box width={PR_CELL_WIDTH} justifyContent="flex-end">
                    {s.pr ? (
                      <Text color={theme.accent} underline>
                        #{s.pr.number}
                      </Text>
                    ) : null}
                  </Box>
                </Box>
              );
            })}
            {view.showBelow ? <Text dimColor>{m.list.moreBelow(view.hiddenBelow)}</Text> : null}
          </>
        )}
      </Box>

      {actionError ? (
        <Text color={statusColor.failed}>
          {m.list.actionErrorLabel}: {actionError}
        </Text>
      ) : null}
      {confirm ? (
        <Box borderStyle="round" borderColor={theme.accent} paddingX={1}>
          <Text>
            {confirm === 'merge' ? m.list.mergePrompt : m.list.discardPrompt} {m.list.confirmRun}{' '}
            <Text color={theme.yes}>y</Text> / <Text color={theme.no}>n</Text>
            {busy ? <Text dimColor> {m.list.busySuffix}</Text> : null}
          </Text>
        </Box>
      ) : null}

      {showHelp && !pending ? (
        <CommandPalette title={m.command.helpTitle} commands={COMMANDS} />
      ) : null}

      {modelSelect ? (
        <ModelSelect
          current={manager.getModel()}
          onSelect={(model) => {
            manager.setModel(model);
            setModelSelect(false);
          }}
          onCancel={() => setModelSelect(false)}
        />
      ) : pending && target ? (
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
