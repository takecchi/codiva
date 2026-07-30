import { Box, type DOMElement, Text, useInput, useWindowSize } from 'ink';
import { type FC, useEffect, useMemo, useRef, useState } from 'react';
import {
  ARROW_SCROLL_LINES,
  bufferOf,
  COMMANDS,
  caretIndexAtClick,
  type DiffStat,
  type DisplayLine,
  emptyBuffer,
  INPUT_MAX_ROWS,
  isFullscreenViewport,
  isResumable,
  isTerminalStatus,
  type LogEntry,
  logLines,
  logViewportRows,
  logWindow,
  type ModelOption,
  type MouseControl,
  matchCommands,
  parseSgrMouse,
  type RichSpan,
  resumeInstruction,
  type ScrollAnchor,
  type SessionManager,
  scrollDown,
  scrollUp,
  streamTail,
  WHEEL_SCROLL_LINES,
} from '@/core';
import { CommandPalette } from './command-palette';
import { ConfirmPrompt } from './confirm-prompt';
import { DialogBox } from './dialog-box';
import {
  useAbsolutePosition,
  useBoxHeight,
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
import { glyph, logColor, markdownColor, statusColor, theme } from './theme';

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

// Styled Markdown row: assistant text is rendered to per-span styling in core
// (bold/italic/code/heading color …). Each span becomes a nested <Text>; the
// `tone` maps to a theme color, everything else is a boolean Ink text prop.
const RichLogLine: FC<{ spans: RichSpan[] }> = ({ spans }) => (
  <Text wrap="truncate-end">
    {spans.map((s, i) => (
      <Text
        // Spans are positional within one already-wrapped row (no identity of
        // their own); the row rebuilds wholesale on any change, so the index is a
        // stable, correct key here.
        // biome-ignore lint/suspicious/noArrayIndexKey: positional spans, whole row re-derived per render
        key={i}
        color={s.tone ? markdownColor[s.tone] : undefined}
        bold={s.bold}
        italic={s.italic}
        dimColor={s.dim}
        underline={s.underline}
        strikethrough={s.strikethrough}
      >
        {s.text}
      </Text>
    ))}
  </Text>
);

/**
 * 空行を描くための最小の中身。Ink の `measureText('')` は **高さ 0** を返すため、
 * 空文字の `<Text>` は行として一切場所を取らない。ログの空行（Markdown の段落間・
 * コードブロック内の空行など）がこれに当たり、そのままだと
 *
 * 1. 段落の区切りが消えて行が詰まって見える
 * 2. スクロール計算（`core/scroll.ts` は空行も 1 物理行として数える）が確保した高さ
 *    より実際の描画が短くなり、末尾寄せ（justifyContent="flex-end"）の分だけ
 *    **可視域の上端に隙間が生まれる**（表示できる行があるのに空白のままになる）
 *
 * という不具合になる。半角スペース 1 つを描いて必ず 1 行ぶんの高さを確保する。
 */
const BLANK_ROW = ' ';

// One physical row of the log. `line.text` already carries the kind's prefix /
// continuation indent (built by core's logLines); truncate is only a safety net
// against width drift — wrapping happened in core at the exact content width.
// Markdown-rendered rows carry `spans` and take the styled path instead.
// 空行（`text` が空）はどちらの経路でも高さ 0 になるので BLANK_ROW で埋める。
const LogLine: FC<{ line: DisplayLine }> = ({ line }) =>
  line.text.length === 0 ? (
    <Text>{BLANK_ROW}</Text>
  ) : line.spans && line.spans.length > 0 ? (
    <RichLogLine spans={line.spans} />
  ) : (
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
  /** `/model` の選択肢（Claude Code のカタログ）。undefined は取得中。 */
  models?: readonly ModelOption[];
  /**
   * 一覧へ戻る。Esc と `/exit` の両方がここへ来る（詳細ビューの `/exit` は
   * アプリ終了ではなく「このセッションを閉じる」。終了は一覧の `/exit`）。
   */
  onBack: () => void;
  /** コンポーザのマウス選択をクリップボードへコピーする（index.tsx が OSC 52 を注入）。 */
  onCopy?: (text: string) => void;
  /**
   * マウスレポート制御（マウス有効環境でのみ渡る）。詳細ビューを開いている間は
   * 捕捉を解除し、端末ネイティブのドラッグ選択でログをコピペできるようにする。
   * 戻る（アンマウント）と再度有効化する。
   */
  mouse?: MouseControl;
}> = ({ manager, id, models, onBack, onCopy, mouse }) => {
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
  // ログ表示域の実測高さ。ここに描く行数の上限であり、スクロール1回の移動量の基準
  // でもある。見積り（logViewportRows）より実測を優先するのは、可視域より多く描くと
  // Yoga が溢れた行を「上でクリップ」せず「縮小」してしまい、ログの途中の行が
  // 虫食いで欠落するため（= 上へスクロールしても読めない状態になっていた）。
  const logRef = useRef<DOMElement>(null);
  const measuredLogRows = useBoxHeight(logRef);
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
  // A session cut off by a dropped connection (a rate limit, an expired login)
  // can be resumed: sending a follow-up restarts the SDK query with `resume`.
  // Surfaced as an explicit action so the user can continue without typing.
  const resumable = status !== undefined && isResumable(status);
  const resume = () => {
    if (!session || status === undefined) {
      return;
    }
    // 多重送信の防止は `manager.resume`（ストアの現在値で判定）に任せる — ここの
    // `status` はスロットルされた購読値なので、送信直後の連打を弾けない。
    if (manager.resume(session.id, resumeInstruction(status, m))) {
      setPanel('input');
      setAnchor('bottom');
    }
  };

  // 詳細ビューにいる間はマウス捕捉を解除し、端末ネイティブのドラッグ選択で
  // ログをそのままコピペできるようにする。一覧へ戻る（アンマウント）と再度有効化して
  // 一覧のクリック/ホイール操作を復帰させる。マウス無効環境では `mouse` が undefined。
  useEffect(() => {
    mouse?.disable();
    return () => mouse?.enable();
  }, [mouse]);

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

  // 詳細ビューでは `/exit`（+ Esc）は「セッションを閉じて一覧へ戻る」。ここでアプリを
  // 終了させないのは、詳細画面はセッション1件の作業空間であり、抜けたい先が一覧である
  // ことがほとんどだから（アプリ終了は一覧の `/exit`）。説明文も下の describeOverrides で
  // 差し替える。`/diff` は詳細ビュー固有（変更差分サマリのトグル）。他は両ビュー共通。
  const commands = useCommandRunner(
    {
      exit: onBack,
      help: () => setShowHelp(true),
      // `/model` opens the picker; the pick applies to THIS session only.
      model: () => setModelSelect(true),
      // `/diff` toggles the changes summary (hidden by default for log room).
      diff: () => setShowChanges((v) => !v),
    },
    setActionError,
    m.command.unknown,
  );
  // 詳細ビューの `/exit` は一覧へ戻る動作なので、パレット/ヘルプの説明も差し替える
  // （既定は「codiva を終了」= 一覧ビューの意味）。
  const commandDescribes = useMemo(() => ({ exit: m.command.exitDetail }), [m.command.exitDetail]);

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
  // ログを描く行数 = スクロール1回の移動量の基準 = アンカーの下限。
  // 全画面時は実測した可視高さに収める（実測が入るまでの1フレームだけ見積りで代用）。
  // インライン描画時（端末が低くて全画面化しない）はクリップされず端末スクロールに
  // 任せるため実測は使わず（高さ=内容なので測っても自分自身になる）、再描画コストの
  // 上限として端末 rows を使う。
  const viewport = isFullscreenViewport(rows)
    ? Math.max(1, Math.floor(measuredLogRows ?? logViewportRows(rows)))
    : Math.max(1, rows);
  // ライブ入力中のプレビュー行はログと同じビューポートを共有するので、**実際に描く
  // ときだけ** 1 行を差し引く（末尾追従中のみ描画する）。スクロール中も差し引くと
  // 描かない行を予約してしまい、可視域の上端に 1 行の隙間が残る。
  const preview = session?.streamingText ? streamTail(session.streamingText) : '';
  const showPreview = preview.length > 0 && anchor === 'bottom';
  // ログを描ける行数。logWindow とスクロール（移動量・アンカーの下限）で必ず同じ値を
  // 使う — 食い違うと最上部でアンカーが 1 行手前で止まり、先頭行に到達できなくなる。
  const logCap = Math.max(1, viewport - (showPreview ? 1 : 0));

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
    // 詳細ビューでは（コピペのため）マウス捕捉を解除しているので通常マウスレポートは
    // 届かない。ただし解除の境界で端末が送り残したレポート断片が生テキストとして
    // editText に流れ込む（「スクロールしようとすると文字が入力される」）のを防ぐため、
    // キー入力より先に SGR レポートを解釈して握り潰す（一覧の useInput と同じ防御）。
    // スクロールは PgUp/PgDn を使う。捕捉が生きている隙間ではホイールも一応効かせる。
    const mouse = parseSgrMouse(rawInput);
    if (mouse) {
      if (mouse.kind === 'wheel') {
        setAnchor((a) =>
          mouse.dir === 'up'
            ? scrollUp(a, total, logCap, WHEEL_SCROLL_LINES)
            : scrollDown(a, total, logCap, WHEEL_SCROLL_LINES),
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
      setAnchor((a) => scrollUp(a, total, logCap));
      return;
    }
    if (key.pageDown) {
      setAnchor((a) => scrollDown(a, total, logCap));
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
    // 一押し再開。操作パネル（Tab）の `r` と違い、入力欄にフォーカスがあるままでも
    // 効く chord にしてある — 中断されたセッションを開いてすぐ復帰させられるように。
    if (key.ctrl && (input === 'r' || input === 'R')) {
      resume();
      return;
    }
    if (key.tab) {
      setPanel((p) => (p === 'input' ? 'actions' : 'input'));
      return;
    }
    // ↑/↓ でログを1行スクロールする。詳細ビューはログのコピペのためマウス捕捉を
    // 解除しており（上の useEffect）、その状態の alt screen ではホイールが端末側で
    // ↑/↓ に変換されて届く（alternate scroll mode）。これを拾わないとホイールが
    // キャレット移動になるだけで「ログが上へスクロールできない」状態になる。
    // 複数行を編集している最中だけはキャレット移動を優先する（ログは PgUp/PgDn で辿れる）。
    if (
      (key.upArrow || key.downArrow) &&
      (panel === 'actions' || !bufferRef.current.value.includes('\n'))
    ) {
      setAnchor((a) =>
        key.upArrow
          ? scrollUp(a, total, logCap, ARROW_SCROLL_LINES)
          : scrollDown(a, total, logCap, ARROW_SCROLL_LINES),
      );
      return;
    }
    if (panel === 'actions') {
      if (input === 'm' || input === 'M') {
        setConfirm('merge');
      } else if (input === 'd' || input === 'D') {
        setConfirm('discard');
      } else if ((input === 'r' || input === 'R') && resumable) {
        resume();
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
      // A leading `/` is a command (e.g. /model), not a follow-up instruction — and
      // so is a bare word that exactly matches a command this view implements.
      if (commands.run(enter.text)) {
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
  // コマンドとして解決される入力か（`/` 付き、または詳細で使える名前と完全一致）。
  const commandPreview = commands.preview(buffer.value);
  const win = logWindow(lines, logCap, anchor);

  return (
    <Box flexDirection="column" flexGrow={1} padding={1}>
      {/*
       * ヘッダは持たない（要件: セッション詳細はコンテンツ + フッタのみ）。
       * メッセージログの末尾ビューポートが上端いっぱいまで残り高さを占める。
       * flexGrow で残りを占め、justifyContent="flex-end" + overflowY="hidden" で
       * 「最新行が下端、溢れた古い行は上へクリップ」にする。<Static> はスクロール
       * バック側に書くため全画面レイアウトでは画面外に消えてしまい使えない。
       */}
      <Box
        ref={logRef}
        flexDirection="column"
        flexGrow={1}
        overflowY="hidden"
        justifyContent="flex-end"
      >
        {/*
         * 行の入れ物は flexShrink={0} が必須。Ink/Yoga は溢れた子を「クリップ」せず
         * 「縮小」するため、これが無いと可視域より1行でも多く描いた瞬間にログの途中の
         * 行が虫食いで落ちる（上へスクロールしても読めなくなる）。縮小させなければ
         * flex-end の溢れは上端で正しくクリップされる。行数自体は logWindow が
         * 実測した可視高さに収めている（二重の保険）。
         */}
        <Box flexDirection="column" flexShrink={0}>
          {win.entries.map((line) => (
            <LogLine key={line.key} line={line} />
          ))}
          {/* Live streaming preview, only while following the tail. */}
          {showPreview ? (
            <Text color={theme.accent} dimColor wrap="truncate-end">
              {preview}
            </Text>
          ) : null}
        </Box>
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

        {/* 認証切れはアプリ内では解決できない（別ターミナルでの再ログインが必要）ので、
            操作パネルを開いているかに関係なく手順を常に出す。それ以外の中断状態
            （通信断・レート制限）は一押し再開キーを同じ位置に出す — Ctrl+R は操作パネルを
            開かずに効くので、パネル内の `r` だけでは気づけない。 */}
        {/* `flexShrink={0}`: Yoga は溢れた子を縮小するので、付けないと低い端末で案内が
            高さ0に潰れて消える。縮む役は flexGrow のログ領域（内部スクロールで収まる）。 */}
        <Box flexShrink={0}>
          {status === 'needs_login' ? (
            <Text color={statusColor.needsLogin}>{m.auth.hint}</Text>
          ) : resumable ? (
            <Text color={statusColor.interrupted}>{m.resume.oneKeyHint}</Text>
          ) : null}
        </Box>
        {actionError ? (
          <Text color={statusColor.failed}>
            {m.action.actionErrorLabel}: {actionError}
          </Text>
        ) : null}
        {showHelp && !pending ? (
          <CommandPalette
            title={m.command.helpTitle}
            commands={COMMANDS}
            describeOverrides={commandDescribes}
          />
        ) : null}

        {modelSelect ? (
          <ModelSelect
            // The session's live (resolved) model — pre-selects the current row.
            current={session.model}
            models={models}
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
                {resumable ? (
                  <Text>
                    <Text color={statusColor.interrupted}>r</Text>: {m.resume.action}
                  </Text>
                ) : null}
                <Text>
                  <Text color={theme.yes}>m</Text>: {m.detail.mergeAction} ・{' '}
                  <Text color={theme.no}>d</Text>: {m.detail.discardAction}
                </Text>
              </>
            )}
          </DialogBox>
        ) : (
          <Box ref={composerRef} flexDirection="column">
            {/* Enter の判定（`commands.preview`）と同じ条件で出す。スラッシュ無しの
                `exit` でも確定前に何が起きるか見えるようにするため。 */}
            {commandPreview !== null ? (
              <CommandPalette
                title={m.command.paletteTitle}
                commands={matchCommands(commandPreview)}
                describeOverrides={commandDescribes}
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
