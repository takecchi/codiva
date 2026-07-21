import { Box, type DOMElement, Text, useInput, useWindowSize } from 'ink';
import { type FC, useEffect, useRef, useState } from 'react';
import {
  activeElapsedMs,
  bufferOf,
  COMMANDS,
  caretIndexAtClick,
  emptyBuffer,
  formatDuration,
  formatModel,
  INPUT_MAX_ROWS,
  isCommandInput,
  isFullscreenViewport,
  isPrCellHit,
  isResumable,
  listView,
  listViewportRows,
  matchCommands,
  needsAttention,
  type PrMergeStatus,
  parseSgrMouse,
  rowLineAtPoint,
  type SessionManager,
  showsBranchColumn,
  totalCostUsd,
} from '@/core';
import { Banner } from './banner';
import { CommandPalette } from './command-palette';
import { ConfirmPrompt } from './confirm-prompt';
import { DialogBox } from './dialog-box';
import {
  useAbsolutePosition,
  useBoxHeight,
  useClock,
  useCommandRunner,
  useLifecycleAction,
  useRateLimit,
  useRunMode,
  useSessions,
  useTextBufferRef,
} from './hooks';
import { useMessages } from './i18n-context';
import { editText, normalizeChord, resolveEnter } from './input';
import { ModelSelect } from './model-select';
import { PermissionDialog } from './permission-dialog';
import { ProgressBadge } from './progress-badge';
import { PromptInput } from './prompt-input';
import { RepoPromptEditor } from './repo-prompt-editor';
import { StatusFooter } from './status-footer';
import { glyph, statusColor, theme } from './theme';

/** Open a PR web URL in the browser (fire-and-forget). */
export type OpenPr = (url: string) => void;

/**
 * Display width of the trailing `#<n>` PR cell. It's the row's last column, so it
 * sits flush at the right edge regardless of the responsive title/branch widths —
 * which lets mouse hit-testing locate it from the terminal width alone.
 */
const PR_CELL_WIDTH = 10;

/**
 * Glyph + color shown before `#<number>` for a PR's merge state (⑂ = merged,
 * check = mergeable, cross = conflicting). GitHub-conventional colors: merged is
 * violet, clean is green, conflicting is red. `unknown` (GitHub still computing)
 * shows no glyph so the row stays quiet until the state is real.
 */
function prStatusBadge(status: PrMergeStatus): { char: string; color: string } | undefined {
  switch (status) {
    case 'merged':
      return { char: glyph.merged, color: statusColor.external };
    case 'mergeable':
      return { char: glyph.mergeable, color: statusColor.completed };
    case 'conflicting':
      return { char: glyph.conflicting, color: statusColor.failed };
    default:
      return undefined;
  }
}

/** 復元・報告する一覧の表示状態（選択行 = スクロール状態 + フォーカスゾーン）。 */
export type ListViewState = { selected: number; focus: 'composer' | 'list' };

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
  version?: string;
  /**
   * 前回この一覧を離れたときの表示状態。詳細ビュー等から戻ったときに選択行
   * （= スクロール位置）とフォーカスを復元する。未指定（初回起動）なら選択は
   * 末尾（最新セッション）に置き、一番下までスクロールされた状態で開く。
   */
  initialViewState?: ListViewState;
  /** 選択行・フォーカスが変わるたびに親へ報告する（再マウント時の復元用）。 */
  onViewStateChange?: (state: ListViewState) => void;
}> = ({
  manager,
  onOpen,
  onOpenPr,
  onQuit,
  cwd,
  model,
  version,
  initialViewState,
  onViewStateChange,
}) => {
  const m = useMessages();
  const sessions = useSessions(manager);
  const mode = useRunMode(manager);
  const rateLimits = useRateLimit(manager);
  const now = useClock(1000);
  // 端末幅は PR セル（行末の固定幅列）のクリック当たり判定に、端末高は一覧の
  // 内部スクロール（収まる行数の算出）に使う。いずれもリサイズ追従。
  const { columns, rows: termRows } = useWindowSize();
  const { buffer, bufferRef, updateBuffer } = useTextBufferRef();
  const [focus, setFocus] = useState<'composer' | 'list'>(initialViewState?.focus ?? 'composer');
  // 初回は末尾（最新）を選択して一番下までスクロールした状態で開く。戻ってきた
  // ときは前回の選択行を復元する（選択行から listView がスクロール窓を導くため、
  // 選択を戻せばスクロール状態も戻る）。
  const [sel, setSel] = useState(
    () => initialViewState?.selected ?? Math.max(0, sessions.length - 1),
  );
  // Open when the user runs `/model`; the ModelSelect dialog then owns the keys.
  const [modelSelect, setModelSelect] = useState(false);
  // Open when the user runs `/prompt`; the RepoPromptEditor then owns the keys.
  const [promptEdit, setPromptEdit] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const rowsRef = useRef<DOMElement>(null);
  const rowsBox = useAbsolutePosition(rowsRef);
  const composerRef = useRef<DOMElement>(null);
  const composerBox = useAbsolutePosition(composerRef);

  // 一覧は常に作成順（上が古い・下が新しい）。archived になっても位置は動かさない。
  const selected = Math.min(sel, Math.max(0, sessions.length - 1));
  const target = sessions[selected];
  // 確認/実行中/エラー + マージ・破棄の実行は共有フックへ（選択セッションが対象）。
  const { confirm, setConfirm, busy, actionError, setActionError, run } = useLifecycleAction(
    manager,
    target?.id,
  );
  // `/command` の解決・実行も共有フックへ。一覧は exit/help/model/prompt を扱う。
  const runCommandInput = useCommandRunner(
    {
      exit: onQuit,
      help: () => setShowHelp(true),
      // `/model` はセッションを作らずモデル選択ダイアログを開く。
      model: () => setModelSelect(true),
      // `/prompt` はリポジトリ追加指示（.codiva/prompt.md）のエディタを開く。
      prompt: () => setPromptEdit(true),
      // `/clear` は完了したセッションを一覧から消去する（worktree/履歴は残す）。
      // 実行中セッションは残るため確認は不要（core 側で終端状態のみ対象にする）。
      clear: () => manager.clear(),
    },
    setActionError,
    m.command.unknown,
  );
  // 表示状態（クランプ後の選択行 + フォーカス）を親へ報告し、ビュー切替で
  // アンマウントされても復元できるようにする。ref 書き込みなので再描画は起きない。
  useEffect(() => {
    onViewStateChange?.({ selected, focus });
  }, [selected, focus, onViewStateChange]);
  // The dialog owns the keys only while the list side has focus, so the
  // composer is never hijacked mid-typing by a session that starts asking.
  const pending = focus === 'list' ? target?.pendingPermission : undefined;

  // 一覧の内部スクロール: rows ボックスは flexGrow で残り高さを占めるので、その
  // 実測高さぶんだけ項目を描画し、選択が常に見えるようウィンドウを動かす。全画面
  // でないインライン描画時はクリップされないため全件描画（端末側スクロールに任せる）。
  const fullscreen = isFullscreenViewport(termRows);
  // 端末が狭いときは worktree（ブランチ）名の列を省き、title に幅を譲る。
  const showBranch = showsBranchColumn(columns);
  const listHeight = useBoxHeight(rowsRef);
  const listCap = fullscreen
    ? Math.max(1, listHeight ?? listViewportRows(termRows))
    : Math.max(1, sessions.length);
  const view = listView(sessions.length, selected, listCap);

  const moveSel = (delta: number) => {
    setSel((s) => Math.min(Math.max(0, s + delta), Math.max(0, sessions.length - 1)));
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

  /** Route a mouse press to the composer caret or a session row. */
  const handlePress = (x: number, y: number) => {
    if (composerBox) {
      const buf = bufferRef.current;
      const contentTop = composerBox.top + 1; // +1 = 上ボーダー
      // プレフィックス（`❯ ` / 続き行の2スペース）ぶんの2セルを引いた表示列。
      const index = caretIndexAtClick(
        buf,
        y - contentTop,
        x - composerBox.left - 2,
        INPUT_MAX_ROWS,
      );
      if (index !== undefined) {
        updateBuffer(bufferOf(buf.value, index));
        setFocus('composer');
        return;
      }
    }
    if (rowsBox) {
      // rows ボックス内の行 → セッションインデックス（可視ウィンドウ view.start.. へ写像）。
      const rowLine = rowLineAtPoint(y, rowsBox.top, view.showAbove, view.end - view.start);
      if (rowLine !== undefined) {
        const idx = view.start + rowLine;
        setSel(idx);
        setFocus('list');
        // A click inside the trailing `#<n>` cell of a row with a PR opens it in the
        // browser (the cell is right-anchored — see isPrCellHit).
        const s = sessions[idx];
        if (s?.pr && onOpenPr && isPrCellHit(x, columns, rowsBox.left, PR_CELL_WIDTH)) {
          onOpenPr(s.pr.url);
        }
      }
    }
  };

  useInput((rawInput, rawKey) => {
    // SGR マウスレポートはキー入力より先に解釈する（バッファへ混入させない）。
    const mouse = parseSgrMouse(rawInput);
    if (mouse) {
      if (mouse.kind === 'wheel') {
        // 一覧はスクロール窓を選択行から導く（別途スクロール位置を持たない）ので、
        // ホイールは選択を 1 行ずつ動かして窓をスクロールさせる（矢印キーと同義）。
        // 端末は 1 ノッチで複数レポートを出すため、1 件/回でも十分な速度になる。
        moveSel(mouse.dir === 'up' ? -1 : 1);
      } else if (mouse.kind === 'press') {
        handlePress(mouse.x, mouse.y);
      }
      return;
    }
    // Shift+Enter 等の修飾キーは modifyOtherKeys / CSI-u エスケープ（`[27;2;13~`）
    // で届く。Ink はこれを解釈できず生テキストとして渡すため、共通ヘルパーで
    // 実キーへ復号して以降の処理（resolveEnter / editText）に正しい chord を渡す。
    const { input, key } = normalizeChord(rawInput, rawKey);
    // The model picker and repo-prompt editor are modal: each owns the keys (its
    // own useInput). Ignore everything here so nothing leaks through to the list.
    if (modelSelect || promptEdit) {
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
        run(confirm);
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
      // Resume a session that was cut off (connection interrupted / rate limited):
      // sends a "continue" instruction, which restarts the SDK query with `resume`
      // so Claude picks up where it left off. Only meaningful for resumable rows.
      if ((input === 'r' || input === 'R') && target && isResumable(target.status)) {
        manager.send(target.id, m.resume.instruction);
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
    : promptEdit
      ? m.prompt.help
      : pending
        ? m.list.helpPending
        : focus === 'list'
          ? // 中断された（再開可能な）行を選択中は再開キー（r）を含むヒントに切り替える。
            target && isResumable(target.status)
            ? m.resume.listHint
            : m.list.helpList
          : m.list.helpComposer;

  return (
    <Box flexDirection="column" flexGrow={1} padding={1}>
      <Banner
        cwd={cwd}
        model={model}
        version={version}
        sessionCount={sessions.length}
        totalCostUsd={totalCostUsd(sessions)}
        rateLimits={rateLimits}
        now={now}
      />

      {/* flexGrow で残り高さを占め、入力欄とフッタを画面最下部へ押し下げる。
          高さを実測し、その行数に収まるぶんだけ内部スクロールして描画する。 */}
      <Box ref={rowsRef} flexDirection="column" marginY={1} flexGrow={1} overflowY="hidden">
        {sessions.length === 0 ? (
          <Text dimColor>{m.list.emptyHint}</Text>
        ) : (
          <>
            {view.showAbove ? <Text dimColor>{m.list.moreAbove(view.hiddenAbove)}</Text> : null}
            {sessions.slice(view.start, view.end).map((s, i) => {
              const idx = view.start + i;
              const attention = needsAttention(s.status);
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
                  {showBranch ? (
                    <Box flexGrow={2} flexBasis={0} minWidth={16} marginRight={1}>
                      <Text dimColor wrap="truncate-end">
                        {s.branch}
                      </Text>
                    </Box>
                  ) : null}
                  <Text dimColor>{formatDuration(activeElapsedMs(s, now))}</Text>
                  {/* PR バッジは行末の固定幅列。右端に揃うので幅可変の title/branch に
                      左右されず、端末幅からクリック位置を逆算できる（handlePress）。 */}
                  <Box width={PR_CELL_WIDTH} justifyContent="flex-end">
                    {s.pr ? (
                      <Text>
                        {(() => {
                          const badge = prStatusBadge(s.pr.mergeStatus);
                          return badge ? <Text color={badge.color}>{badge.char} </Text> : null;
                        })()}
                        <Text color={theme.accent} underline>
                          #{s.pr.number}
                        </Text>
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
          {m.action.actionErrorLabel}: {actionError}
        </Text>
      ) : null}
      {confirm ? (
        <DialogBox>
          <ConfirmPrompt kind={confirm} busy={busy} />
        </DialogBox>
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
      ) : promptEdit ? (
        <RepoPromptEditor
          initial={manager.getRepoPrompt()}
          onSave={(text) => {
            manager.setRepoPrompt(text);
            setPromptEdit(false);
          }}
          onCancel={() => setPromptEdit(false)}
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
