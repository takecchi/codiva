import { Box, type DOMElement, Text, useInput, useWindowSize } from 'ink';
import { type FC, useEffect, useRef, useState } from 'react';
import {
  activeElapsedMs,
  type BannerLine,
  bannerCaretAt,
  bannerLines,
  bannerText,
  bufferOf,
  COMMANDS,
  caretIndexAtClick,
  emptyBuffer,
  formatDuration,
  formatModel,
  INPUT_MAX_ROWS,
  isFullscreenViewport,
  isPrCellHit,
  isResumable,
  listView,
  listViewportRows,
  type ModelOption,
  matchCommands,
  needsAttention,
  type PrMergeStatus,
  parseSgrMouse,
  resumableSessions,
  resumeInstruction,
  rowLineAtPoint,
  type SessionManager,
  showsBranchColumn,
  type TrainingOptIn,
  totalCostUsd,
} from '@/core';
import { Banner } from './banner';
import { CommandPalette } from './command-palette';
import { ConfirmPrompt } from './confirm-prompt';
import { DialogBox } from './dialog-box';
import {
  useAbsolutePosition,
  useAccount,
  useBoxHeight,
  useClock,
  useCommandRunner,
  useDragSelection,
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
import { badgeFor, ProgressBadge } from './progress-badge';
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
  /** `/model` の選択肢（Claude Code のカタログ）。undefined は取得中。 */
  models?: readonly ModelOption[];
  version?: string;
  /**
   * 前回この一覧を離れたときの表示状態。詳細ビュー等から戻ったときに選択行
   * （= スクロール位置）とフォーカスを復元する。未指定（初回起動）なら選択は
   * 末尾（最新セッション）に置き、一番下までスクロールされた状態で開く。
   */
  initialViewState?: ListViewState;
  /** 選択行・フォーカスが変わるたびに親へ報告する（再マウント時の復元用）。 */
  onViewStateChange?: (state: ListViewState) => void;
  /** コンポーザのマウス選択をクリップボードへコピーする（index.tsx が OSC 52 を注入）。 */
  onCopy?: (text: string) => void;
  /**
   * 学習データ利用の状態。`'on'` のときだけバナーに注意行が出る（`ui/banner.tsx`）。
   * 判定は合成ルートで行い、ここは受け渡すだけ。
   */
  trainingOptIn?: TrainingOptIn;
}> = ({
  manager,
  onOpen,
  onOpenPr,
  onQuit,
  cwd,
  model,
  models,
  version,
  initialViewState,
  onViewStateChange,
  onCopy,
  trainingOptIn,
}) => {
  const m = useMessages();
  const sessions = useSessions(manager);
  const mode = useRunMode(manager);
  const rateLimits = useRateLimit(manager);
  const account = useAccount(manager);
  const now = useClock(1000);
  // 端末幅は PR セル（行末の固定幅列）のクリック当たり判定に、端末高は一覧の
  // 内部スクロール（収まる行数の算出）に使う。いずれもリサイズ追従。
  const { columns, rows: termRows } = useWindowSize();
  const { buffer, bufferRef, updateBuffer } = useTextBufferRef();
  // コンポーザのマウス範囲選択（ドラッグで選択→離すとクリップボードへコピー）。
  const composerSel = useDragSelection(onCopy);
  // ヘッダ（バナー）のマウス範囲選択。cwd の絶対パスをコピーしたいケースが主目的。
  // コンポーザとは別インスタンスにする（caret index の基準テキストが違う）。
  const headerSel = useDragSelection(onCopy);
  const [focus, setFocus] = useState<'composer' | 'list'>(initialViewState?.focus ?? 'composer');
  // 初回は末尾（最新）を選択して一番下までスクロールした状態で開く。戻ってきた
  // ときは前回の選択行を復元する（選択行から listView がスクロール窓を導くため、
  // 選択を戻せばスクロール状態も戻る）。
  const [sel, setSel] = useState(
    () => initialViewState?.selected ?? Math.max(0, sessions.length - 1),
  );
  // 一括再開（Ctrl+A）の確認中フラグ。単体の再開（Ctrl+R）は1件だけなので確認なしで
  // 即送るが、一括は全中断セッションへ同時に指示を投げる = 誤爆が課金に直結するため
  // y/n を挟む。
  const [confirmResumeAll, setConfirmResumeAll] = useState(false);
  // Open when the user runs `/model`; the ModelSelect dialog then owns the keys.
  const [modelSelect, setModelSelect] = useState(false);
  // Open when the user runs `/prompt`; the RepoPromptEditor then owns the keys.
  const [promptEdit, setPromptEdit] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const rowsRef = useRef<DOMElement>(null);
  const rowsBox = useAbsolutePosition(rowsRef);
  const composerRef = useRef<DOMElement>(null);
  const composerBox = useAbsolutePosition(composerRef);
  // ヘッダのテキスト欄（マスコットの右）。左上を実測してマウス座標から文字位置を逆算する。
  const headerRef = useRef<DOMElement>(null);
  const headerBox = useAbsolutePosition(headerRef);

  // 一覧は常に作成順（上が古い・下が新しい）。archived になっても位置は動かさない。
  const selected = Math.min(sel, Math.max(0, sessions.length - 1));
  const target = sessions[selected];
  // 確認/実行中/エラー + マージ・破棄の実行は共有フックへ（選択セッションが対象）。
  const { confirm, setConfirm, busy, actionError, setActionError, run } = useLifecycleAction(
    manager,
    target?.id,
  );
  // `/command` の解決・実行も共有フックへ。一覧は exit/help/model/prompt を扱う。
  const commands = useCommandRunner(
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

  // 中断されて再開待ちのセッション（通信断 / レート制限 / 認証切れ）。件数はヒントと
  // 一括再開の確認文に、集合はそのまま一括送信に使う。
  const resumables = resumableSessions(sessions);
  // 認証切れは別ターミナルでのログインが前提なので、一括再開の確認文で件数を明示する
  // （「ログインし直した」という指示文を、まだログアウトのままのセッションへ黙って
  // 投げると transcript に嘘が残る）。
  const authStalled = resumables.filter((s) => s.status === 'needs_login').length;
  const targetResumable = target !== undefined && isResumable(target.status);

  /**
   * 選択中のセッションを中断箇所から再開する。フォーカスに関係なく効く Ctrl+R と、
   * 一覧フォーカスの `r` の共通実装。多重送信の防止は `manager.resume`（ストアの
   * 現在値で判定）に任せる — ここの `target` はスロットルされた購読値なので、
   * キーの連打を弾く判断には使えない。
   */
  const resumeSelected = () => {
    if (target) {
      manager.resume(target.id, resumeInstruction(target.status, m));
    }
  };

  /** 再開待ちの全セッションをまとめて再開する（Ctrl+A → y の確認後）。 */
  const resumeAll = () => {
    for (const s of resumables) {
      manager.resume(s.id, resumeInstruction(s.status, m));
    }
  };

  /** Open the selected session's PR in the browser, if it has one. */
  const openPr = () => {
    if (target?.pr && onOpenPr) {
      onOpenPr(target.pr.url);
    }
  };

  // ヘッダの表示行。描画（Banner）と当たり判定（bannerCaretAt）で同じ配列を使う —
  // 行 index = 表示行という前提を共有しているので、片方だけ差し替えると選択がズレる。
  const headerLines = bannerLines(m, {
    cwd,
    model,
    version,
    sessionCount: sessions.length,
    totalCostUsd: totalCostUsd(sessions),
    rateLimits,
    account,
    now,
  });
  const headerText = bannerText(headerLines);

  // 選択を始めた時点のヘッダ内容を固定して持つ。選択範囲は「このテキストへの caret
  // index」なので、途中でヘッダの文言が変わると（合計コストの増加・セッション数・
  // 使用状況のカウントダウン）行の長さがズレて別の文字を指してしまう。固定しておけば
  // コピー結果は常に「選択した瞬間の文字列」になる。
  const headerSnapRef = useRef<{ lines: readonly BannerLine[]; text: string } | undefined>(
    undefined,
  );
  // 現在のヘッダと食い違ったらハイライトを捨てる（ズレた位置を光らせ続けない）。
  // ドラッグ中は触らない（アンカーを失うと選択が中断する）。deps 配列を付けずに毎描画で
  // 比較するのは、`headerSel` の参照が描画ごとに変わり deps に載せると即クリアされてしまうため。
  useEffect(() => {
    const snap = headerSnapRef.current;
    if (snap && snap.text !== headerText && !headerSel.dragging()) {
      headerSnapRef.current = undefined;
      headerSel.clear();
    }
  });

  /**
   * Caret index for a mouse point inside the header's text block, or undefined when
   * it's outside: the mascot, a row above/below the text, or — for a press — right of
   * that row's last character (an empty area must not silently swallow clicks).
   * Drags pass `'clamp'` instead, so overshooting the end still selects to the end.
   */
  const headerCaretAt = (
    lines: readonly BannerLine[],
    x: number,
    y: number,
    beyondEnd: 'reject' | 'clamp' = 'reject',
  ): number | undefined => {
    if (!headerBox) {
      return undefined;
    }
    return bannerCaretAt(lines, y - headerBox.top, x - headerBox.left, beyondEnd);
  };

  /**
   * Caret index for a mouse point inside the composer, or undefined if the point
   * is outside it. `contentTop` skips the top border; the `-2` drops the `❯ ` /
   * continuation prefix so `x` becomes the display column within the text.
   */
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

  /**
   * Route a mouse press to the composer caret (starting a selection), the header
   * text (starting a header selection), or a session row.
   */
  const handlePress = (x: number, y: number) => {
    const index = composerCaretAt(x, y);
    if (index !== undefined) {
      updateBuffer(bufferOf(bufferRef.current.value, index));
      setFocus('composer');
      composerSel.begin(index); // anchor a possible drag-selection at the click
      headerSnapRef.current = undefined;
      headerSel.clear();
      return;
    }
    composerSel.clear(); // a press outside the composer drops any highlight
    // ヘッダは装飾なので一覧より弱い: 低い端末でヘッダが潰れてテキストが一覧の行に
    // 重なった場合、その行のクリックは行選択（と PR セル）に渡す。ヘッダの選択が
    // 行クリックを黙って食う方が体感の害が大きい。
    const headerIndex = rowsBox && y >= rowsBox.top ? undefined : headerCaretAt(headerLines, x, y);
    if (headerIndex !== undefined) {
      // ヘッダのドラッグはフォーカスも選択行も動かさない — パス（cwd）をコピーしたい
      // だけの操作で、タイピング位置や一覧の選択を奪われると邪魔になる。
      headerSnapRef.current = { lines: headerLines, text: headerText };
      headerSel.begin(headerIndex);
      return;
    }
    headerSnapRef.current = undefined;
    headerSel.clear();
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

  /**
   * Drag extends whichever selection the press anchored (live highlight). Only one
   * can be active at a time, so the press decides which region owns the drag.
   */
  const handleDrag = (x: number, y: number) => {
    if (composerSel.dragging()) {
      const index = composerCaretAt(x, y);
      if (index !== undefined) {
        updateBuffer(bufferOf(bufferRef.current.value, index));
        composerSel.extend(index);
      }
      return;
    }
    if (headerSel.dragging()) {
      // 当たり判定はドラッグ開始時に固定した行で行う（途中で文言が変わっても、
      // アンカーと終点が同じテキストの index として揃う）。
      const snap = headerSnapRef.current;
      const index = snap ? headerCaretAt(snap.lines, x, y, 'clamp') : undefined;
      if (index !== undefined) {
        headerSel.extend(index);
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
      } else if (mouse.kind === 'drag') {
        handleDrag(mouse.x, mouse.y);
      } else if (mouse.kind === 'release') {
        // 離した時点で 1 回だけコピー（ドラッグごとに送らない）。ハイライトは残す。
        // アンカーの無い側は no-op なので、両方に release を渡して構わない。
        composerSel.end(bufferRef.current.value);
        // ヘッダはドラッグ開始時に固定したテキストからコピーする。表示が変わっていた
        // ならハイライトは残さない（ズレた位置を光らせたままにしない）。
        const snap = headerSnapRef.current;
        if (snap) {
          headerSel.end(snap.text);
          if (snap.text !== headerText) {
            headerSnapRef.current = undefined;
            headerSel.clear();
          }
        }
      }
      return;
    }
    // Shift+Enter 等の修飾キーは modifyOtherKeys / CSI-u エスケープ（`[27;2;13~`）
    // で届く。Ink はこれを解釈できず生テキストとして渡すため、共通ヘルパーで
    // 実キーへ復号して以降の処理（resolveEnter / editText）に正しい chord を渡す。
    const { input, key } = normalizeChord(rawInput, rawKey);
    // 何かキーが来たらマウス選択のハイライトは消す（タイピング/カーソル移動で解除）。
    composerSel.clear();
    headerSel.clear();
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
    if (confirmResumeAll) {
      if (input === 'y' || input === 'Y') {
        resumeAll();
        setConfirmResumeAll(false);
      } else if (input === 'n' || input === 'N' || key.escape) {
        setConfirmResumeAll(false);
      }
      return;
    }
    // 一押し再開。フォーカスゾーンに関係なく効く chord にしてあるのが要点で、
    // 中断されたセッションを復帰させるのに「Tab で一覧へ → r」の2手を踏ませない
    // （入力欄は既定フォーカスなので、そこから直接復帰できる必要がある）。印字キーを
    // 潰さずに済むので入力中に打っても文字が化けない。
    if (key.ctrl && (input === 'r' || input === 'R')) {
      resumeSelected();
      return;
    }
    // 一括再開。回線が落ちる・蓋を閉じると走っていたセッションが揃って中断されるため、
    // 1件ずつ選び直させない。件数を見せて y/n で確認する。1件だけのときは Ctrl+R で
    // 済むので出さない（案内 `resume.allHint` の条件と必ず一致させる）。
    if (key.ctrl && (input === 'a' || input === 'A') && resumables.length > 1) {
      setConfirmResumeAll(true);
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
      // Resume a session that was cut off (connection interrupted / rate limited /
      // login expired): sends a "continue" instruction, which restarts the SDK
      // query with `resume` so Claude picks up where it left off. Only meaningful
      // for resumable rows.
      if ((input === 'r' || input === 'R') && targetResumable) {
        resumeSelected();
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
      // 先頭が `/`、またはコマンド名そのもの（`exit` 等）はコマンド。通常の指示
      // （manager.create）と分岐する。`/model` はコマンドレジストリ経由でモデル
      // 選択ダイアログを開く。判定と実行は useCommandRunner に集約。
      if (commands.run(enter.text)) {
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

  // 入力がコマンドとして解決されるか（`/` 付き、または `exit` のような完全一致）。
  // null なら通常の指示。Enter と同じ判定を使うのでパレットの内容が実行結果と一致する。
  const commandPreview = commands.preview(buffer.value);

  const footerHint = modelSelect
    ? m.model.help
    : promptEdit
      ? m.prompt.help
      : pending
        ? m.list.helpPending
        : focus === 'list'
          ? // 認証切れの行はまず「別ターミナルで claude にログイン」を促す（r だけ
            // 見せても再開できないため）。それ以外の再開可能な行は再開キー（r）を
            // 含むヒントに切り替える。
            target?.status === 'needs_login'
            ? m.auth.listHint
            : target && isResumable(target.status)
              ? m.resume.listHint
              : m.list.helpList
          : m.list.helpComposer;

  return (
    <Box flexDirection="column" flexGrow={1} padding={1}>
      <Banner
        lines={headerLines}
        selection={headerSel.selection}
        textRef={headerRef}
        trainingOptIn={trainingOptIn}
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
                    {/* 注意グリフはその状態のバッジ色で塗る（許可待ち=amber、質問=pink、
                        ログイン必要=lemon）。状態を増やしても色分岐を足さなくて済む。 */}
                    <Text color={badgeFor(s, m).color}>{attention ? glyph.attention : ' '}</Text>
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

      {/* 再開キーの案内はフッタではなく独立した行に出す — Ctrl+R/Ctrl+A はフォーカスに
          関係なく効くので、フォーカス依存のフッタヒントに混ぜると入力欄にいる間だけ
          消えてしまい「中断したのにどう戻すか分からない」状態になる。認証切れは
          「別ターミナルでログイン → Ctrl+R」の手順そのものを出す（詳細ビューと同じ）。
          `flexShrink={0}` は必須: Yoga は溢れた子を縮小するので、付けないと低い端末で
          この案内自体が高さ0に潰れて消える（入力欄の枠も巻き込まれる）。縮む役は
          flexGrow のセッション一覧（内部スクロールで収まる）に任せる。 */}
      <Box flexDirection="column" flexShrink={0}>
        {target?.status === 'needs_login' ? (
          <Text color={statusColor.needsLogin}>{m.auth.hint}</Text>
        ) : targetResumable ? (
          <Text color={statusColor.interrupted}>{m.resume.oneKeyHint}</Text>
        ) : null}
        {resumables.length > 1 ? (
          <Text color={statusColor.interrupted}>{m.resume.allHint(resumables.length)}</Text>
        ) : null}
        {actionError ? (
          <Text color={statusColor.failed}>
            {m.action.actionErrorLabel}: {actionError}
          </Text>
        ) : null}
        {confirm ? (
          <DialogBox>
            <ConfirmPrompt kind={confirm} busy={busy} />
          </DialogBox>
        ) : confirmResumeAll ? (
          <DialogBox>
            <ConfirmPrompt
              kind="resumeAll"
              busy={false}
              count={resumables.length}
              authCount={authStalled}
            />
          </DialogBox>
        ) : null}
      </Box>

      {showHelp && !pending ? (
        <CommandPalette title={m.command.helpTitle} commands={COMMANDS} />
      ) : null}

      {modelSelect ? (
        <ModelSelect
          current={manager.getModel()}
          models={models}
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
          {/* パレットの出す条件は Enter の判定と同じ（`toCommandInput`）にする。
              スラッシュ無しの `exit` が無言で終了しないよう、確定前に何が起きるかを見せる。 */}
          {focus === 'composer' && commandPreview !== null ? (
            <CommandPalette
              title={m.command.paletteTitle}
              commands={matchCommands(commandPreview)}
            />
          ) : null}
          <PromptInput
            buffer={buffer}
            focused={focus === 'composer'}
            placeholder={m.list.promptPlaceholder}
            selection={composerSel.selection}
          />
        </Box>
      )}
      <StatusFooter mode={mode} hint={footerHint} account={account} usage={rateLimits} now={now} />
    </Box>
  );
};
