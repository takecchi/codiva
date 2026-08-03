import { Box, type DOMElement, Text, useInput, useWindowSize } from 'ink';
import { type FC, useEffect, useRef, useState } from 'react';
import {
  activeElapsedMs,
  atFirstComposerRow,
  atLastComposerRow,
  type BannerLine,
  bannerCaretAt,
  bannerLines,
  bannerText,
  bufferOf,
  COMMANDS,
  COMPOSER_PREFIX_CELLS,
  canSelfUpdate,
  caretIndexAtClick,
  emptyBuffer,
  errorMessage,
  formatDuration,
  formatModel,
  INPUT_MAX_ROWS,
  type InputHistory,
  isActiveStatus,
  isFullscreenViewport,
  isPrCellHit,
  isResumable,
  listView,
  listViewportRows,
  type ModelOption,
  matchCommands,
  needsAttention,
  type PrLookupState,
  type PrRef,
  type PrStatus,
  parseSgrMouse,
  recoverableSessions,
  resumableSessions,
  resumeInstruction,
  rowLineAtPoint,
  type SessionManager,
  showsBranchColumn,
  type TrainingOptIn,
  totalCostUsd,
  type UpdateCheck,
  type UpdateInfo,
  type UpdateRun,
  type UpdateService,
  type UpdateViewState,
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
  useComposerWidth,
  useDragSelection,
  useInputHistory,
  useLifecycleAction,
  useRateLimit,
  useRecovery,
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
import { UpdateDialog } from './update-dialog';

/** Open a PR web URL in the browser (fire-and-forget). */
export type OpenPr = (url: string) => void;

/**
 * Display width of the trailing `#<n>` PR cell. It's the row's last column, so it
 * sits flush at the right edge regardless of the responsive title/branch widths —
 * which lets mouse hit-testing locate it from the terminal width alone.
 */
const PR_CELL_WIDTH = 10;

/**
 * Glyph + color shown before `#<number>`. The cell is one column wide, so a single
 * glyph has to carry both the merge state and the CI state; the priority is "what
 * would make me look": merged → failing checks → running checks → conflict → clean.
 * GitHub-conventional colors (merged violet, clean green, broken red, running amber).
 * `unknown` (GitHub still computing, no checks configured) shows no glyph so the row
 * stays quiet until the state is real.
 */
function prStatusBadge(status: PrStatus): { char: string; color: string } | undefined {
  if (status.mergeStatus === 'merged') {
    return { char: glyph.merged, color: statusColor.external };
  }
  if (status.checks === 'failing') {
    return { char: glyph.conflicting, color: statusColor.failed };
  }
  if (status.checks === 'pending') {
    return { char: glyph.checksPending, color: statusColor.awaitingPermission };
  }
  if (status.mergeStatus === 'conflicting') {
    return { char: glyph.conflicting, color: statusColor.failed };
  }
  if (status.mergeStatus === 'mergeable') {
    return { char: glyph.mergeable, color: statusColor.completed };
  }
  return undefined;
}

/**
 * The row's trailing PR cell, drawn from whatever is known so far — the two halves
 * arrive (and expire) independently:
 *
 *  - `pr` (number/url) is stable and cached across restarts, so `#<n>` renders as
 *    soon as it's known and never waits on the status.
 *  - `status` is polled; until it lands the number stands alone without a glyph.
 *
 * An *empty* cell therefore means exactly one thing — "this branch has no PR" — and
 * the two "don't know yet" cases get their own marks: `⋯` while the first lookup is
 * in flight, `?` when the last one failed (rate limit / offline / not logged in).
 * A draft PR's number is dimmed (still underlined — it's clickable either way).
 */
const PrCell: FC<{ pr?: PrRef; status?: PrStatus; lookup?: PrLookupState }> = ({
  pr,
  status,
  lookup,
}) => {
  if (pr) {
    const badge = status ? prStatusBadge(status) : undefined;
    return (
      <Text>
        {badge ? <Text color={badge.color}>{badge.char} </Text> : null}
        <Text color={status?.isDraft ? theme.dim : theme.accent} underline>
          #{pr.number}
        </Text>
      </Text>
    );
  }
  if (lookup === 'loading') {
    return <Text dimColor>{glyph.prLoading}</Text>;
  }
  if (lookup === 'error') {
    return <Text color={theme.warn}>{glyph.prUnknown}</Text>;
  }
  return null;
};

/**
 * 復元・報告する一覧の表示状態（選択行 = スクロール状態 + フォーカスゾーン + 入力履歴）。
 * 履歴を含めるのは、詳細ビューへ入って戻ってくるだけで ↑ の履歴が消えないようにするため
 * （一覧はビュー切替でアンマウントされる）。
 */
export type ListViewState = {
  selected: number;
  focus: 'composer' | 'list';
  history: InputHistory;
};

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
  /**
   * 対象リポジトリの現在ブランチ（ヘッダに出す）。取得と定期更新は親（`app.tsx` の
   * `useBranch`）が持ち、ここは受け渡すだけ。undefined（detached HEAD / 取得失敗 /
   * 未解決）なら表示しない。
   */
  branch?: string;
  model?: string;
  /** `/model` の選択肢（Claude Code のカタログ）。undefined は取得中。 */
  models?: readonly ModelOption[];
  version?: string;
  /**
   * 起動時チェックで見つかった新しいバージョン。バナーの 1 行だけに使う
   * （`undefined` = 最新 / 未確認 / チェック無効。いずれも何も出さない）。
   */
  updateInfo?: UpdateInfo;
  /**
   * アップデート機能の実装（合成ルートが注入）。未注入なら `/update` は
   * 「確認できませんでした」を出すだけで、ネットワークにも npm にも触らない。
   */
  updater?: UpdateService;
  /**
   * 更新の適用に成功したとき（= 次回起動から新版）に呼ぶ。バナーの「更新できます」を
   * 引っ込めるために親が使う。
   */
  onUpdateApplied?: () => void;
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
  branch,
  model,
  models,
  version,
  updateInfo,
  updater,
  onUpdateApplied,
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
  // 送信済み指示の履歴（↑↓ で呼び出す）。再マウントしても引き継ぐ。
  const history = useInputHistory(initialViewState?.history);
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
  // 一括立て直し（Ctrl+F）の確認中フラグ。一括再開と同じ理由で y/n を挟む
  // （詰まっている全セッションへ同時に指示を投げる = 誤爆が課金に直結する）。
  const [confirmRecoverAll, setConfirmRecoverAll] = useState(false);
  // Open when the user runs `/model`; the ModelSelect dialog then owns the keys.
  const [modelSelect, setModelSelect] = useState(false);
  // Open when the user runs `/prompt`; the RepoPromptEditor then owns the keys.
  const [promptEdit, setPromptEdit] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  // `/update` のダイアログ状態（null = 閉じている）。非同期の決着が「閉じた後」や
  // 「開き直した後」に届いても勝手に再表示しないよう、世代カウンタで無効化する。
  const [update, setUpdate] = useState<UpdateViewState | null>(null);
  const updateGen = useRef(0);
  const rowsRef = useRef<DOMElement>(null);
  const rowsBox = useAbsolutePosition(rowsRef);
  const composerRef = useRef<DOMElement>(null);
  const composerBox = useAbsolutePosition(composerRef);
  // 入力欄の折り返し幅（実測）。PromptInput が描いた折り返しと同じ値でクリック位置の
  // 逆算・↑↓ のキャレット移動を行う（食い違うと別の文字を選ぶ）。
  const composerWidth = useComposerWidth(composerRef);
  // ヘッダのテキスト欄（マスコットの右）。左上を実測してマウス座標から文字位置を逆算する。
  // 高さも測るのは、低い端末で欄が潰れたときに当たり判定をやめるため（下記 headerCaretAt）。
  const headerRef = useRef<DOMElement>(null);
  const headerBox = useAbsolutePosition(headerRef);
  const headerHeight = useBoxHeight(headerRef);

  // 一覧は常に作成順（上が古い・下が新しい）。archived になっても位置は動かさない。
  const selected = Math.min(sel, Math.max(0, sessions.length - 1));
  const target = sessions[selected];
  // 確認/実行中/エラー + マージ・破棄の実行は共有フックへ（選択セッションが対象）。
  const { confirm, setConfirm, busy, actionError, setActionError, run } = useLifecycleAction(
    manager,
    target?.id,
  );
  // `/sync` · `/fix-ci` · `/recover`（PR の立て直し）。エラーはマージ/破棄と同じ欄へ。
  const recovery = useRecovery(manager, m, setActionError);
  // **`recovery.busy` を全キーを飲む `busy` に混ぜない。** 一括立て直しは N 件ぶんの
  // `git fetch`+`merge`+`push` を直列に回すので数分に及びうる。その間すべてのキーを
  // 飲むと、Ctrl+C を拾わない（`exitOnCtrlC: false`）この TUI では `/exit` すら打てず
  // 操作不能になる（`/update` の installing で同じ罠を踏んで Esc だけ通した）。
  // 代わりに「もう一度立て直しを始める」入口だけを塞ぐ。
  const recovering = recovery.busy;

  // PR が詰まっている（ベースと競合 / CI が赤い）セッション。件数は案内と確認文に、
  // 集合はそのまま一括実行に使う（`manager.recoverable()` と同じ純関数を通す）。
  const stuck = recoverableSessions(sessions);
  const stuckSync = stuck.filter((s) => s.kind === 'sync').length;
  /** ダイアログを閉じる（進行中の非同期結果は世代を進めて捨てる）。 */
  const closeUpdate = () => {
    updateGen.current += 1;
    setUpdate(null);
  };

  /**
   * 世代を進めてから状態を差し替える更新器を作る。返された `settle` は、その間に
   * 閉じられた/開き直されたら何もしない（stale な結果でダイアログが蘇らない）。
   */
  const beginUpdateStep = (initial: UpdateViewState): ((next: UpdateViewState) => void) => {
    updateGen.current += 1;
    const gen = updateGen.current;
    setUpdate(initial);
    return (next) => {
      if (updateGen.current === gen) {
        setUpdate(next);
      }
    };
  };

  /** `/update`: 毎回レジストリへ問い合わせ直す（起動時の結果はキャッシュしない）。 */
  const checkUpdate = () => {
    const settle = beginUpdateStep({ kind: 'checking' });
    const pending: Promise<UpdateCheck> = updater
      ? updater.check()
      : // 未注入（テスト・機能を切っているホスト）では通信せず「確認できなかった」。
        Promise.resolve({ kind: 'unavailable' });
    pending
      .then((check) => settle({ kind: 'result', check }))
      .catch(() => settle({ kind: 'result', check: { kind: 'unavailable' } }));
  };

  /** 更新コマンドを実行する（y で確認済み。`canSelfUpdate` な経路のときだけ来る）。 */
  const installUpdate = (info: UpdateInfo) => {
    const settle = beginUpdateStep({ kind: 'installing', info });
    // detail は空文字なら「理由不明」としてカタログの文言で出す（ここで英語の
    // 固定文を作らない。npm の stderr は外部由来なのでそのまま見せる）。
    const pending: Promise<UpdateRun> = updater
      ? updater.install(info)
      : Promise.resolve({ ok: false, detail: '' });
    pending
      .then((run) => {
        if (run.ok) {
          settle({ kind: 'installed', info });
          // バナーの「更新できます」を消す（実行中プロセスは旧版のままなので、
          // 案内はダイアログの「再起動してください」に一本化する）。
          onUpdateApplied?.();
          return;
        }
        settle({ kind: 'failed', detail: run.detail });
      })
      .catch((err) => settle({ kind: 'failed', detail: errorMessage(err) }));
  };

  // 稼働中セッション数。更新は codiva 自身のファイルを置き換えるので、走っている
  // セッション（= SDK サブプロセス）がある間の適用は避けたい。ブロックはせず
  // 確認ダイアログで件数を警告する。
  const activeSessions = sessions.filter((s) => isActiveStatus(s.status)).length;

  /** ダイアログが y/n を待っているときの対象（それ以外は undefined = 任意キーで閉じる）。 */
  const updatePrompt =
    update?.kind === 'result' &&
    update.check.kind === 'available' &&
    canSelfUpdate(update.check.info.install)
      ? update.check.info
      : undefined;

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
      // `/update` は npm レジストリを見て、更新があれば y/n を挟んで適用する。
      update: checkUpdate,
      // `/sync` は選択中セッションの worktree へベースブランチを取り込む。競合したら
      // 競合を残したままセッションへ解決を依頼する（PR の状態を待たずに実行できる）。
      sync: () => {
        if (target && !recovering) {
          recovery.run(target.id, 'sync');
        }
      },
      // `/fix-ci` は選択中セッションへ CI の修正を依頼する。
      fixCi: () => {
        if (target && !recovering) {
          recovery.run(target.id, 'ci');
        }
      },
      // `/recover` は詰まっている全セッションをまとめて立て直す（Ctrl+F と同じ）。
      // 対象 0 件で「0 件を立て直します」と聞かないよう、Ctrl+F と同じ条件で門を張る。
      recover: () => {
        if (stuck.length > 0 && !recovering) {
          setConfirmRecoverAll(true);
        } else {
          recovery.setNotice(m.recover.skipped);
        }
      },
    },
    setActionError,
    m.command.unknown,
  );
  // 表示状態（クランプ後の選択行 + フォーカス + 入力履歴）を親へ報告し、ビュー切替で
  // アンマウントされても復元できるようにする。ref 書き込みなので再描画は起きない。
  useEffect(() => {
    onViewStateChange?.({ selected, focus, history: history.history });
  }, [selected, focus, history.history, onViewStateChange]);
  // The dialog owns the keys only while the list side has focus, so the
  // composer is never hijacked mid-typing by a session that starts asking.
  //
  // `!update` は必須のガード: `PermissionDialog` は**自前の `useInput`** を持ち、Ink は
  // 1 つの入力チャンクを**マウント中の全ハンドラへ配る**。アップデートダイアログと
  // 同時にマウントされると、更新確認の `y` が未読のツール実行の許可も兼ねてしまう
  // （このビューがキーを飲んでも、相手のハンドラは独立に反応する）。モーダルは
  // 相互排他にしておく（規約: ink-components.md）。
  const pending = focus === 'list' && !update ? target?.pendingPermission : undefined;

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
    branch,
    model,
    version,
    sessionCount: sessions.length,
    totalCostUsd: totalCostUsd(sessions),
    account,
    updateLatest: updateInfo?.latest,
  });
  const headerText = bannerText(headerLines);

  // 選択を始めた時点のヘッダ内容を固定して持つ。選択範囲は「このテキストへの caret
  // index」なので、途中でヘッダの文言が変わると（合計コストの増加・セッション数・モデルの
  // 切替）行の長さがズレて別の文字を指してしまう。固定しておけばコピー結果は常に
  // 「選択した瞬間の文字列」になる（毎秒動く使用状況のカウントダウンはこのテキストの外）。
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
   *
   * 実測高さが行数より小さいとき（低い端末でヘッダが縮み、縦中央寄せの都合で**上端の行から**
   * 落ちる）は当たり判定そのものをやめる。「行 index = 表示行」が崩れているので、そのまま
   * 逆算すると押した行とは別の行の文字を選んでしまう（黙って間違うより選べないほうがよい）。
   */
  const headerCaretAt = (
    lines: readonly BannerLine[],
    x: number,
    y: number,
    beyondEnd: 'reject' | 'clamp' = 'reject',
  ): number | undefined => {
    if (!headerBox || (headerHeight !== undefined && headerHeight < lines.length)) {
      return undefined;
    }
    return bannerCaretAt(lines, y - headerBox.top, x - headerBox.left, beyondEnd);
  };

  /**
   * Caret index for a mouse point inside the composer, or undefined if the point
   * is outside it. `contentTop` skips the top border; the prefix width drops the
   * `❯ ` / continuation glyph so `x` becomes the display column within the text.
   * The wrap width must be the one the composer rendered with — clicks on a
   * soft-wrapped row resolve through the same layout.
   */
  const composerCaretAt = (x: number, y: number): number | undefined => {
    if (!composerBox) {
      return undefined;
    }
    return caretIndexAtClick(
      bufferRef.current,
      y - (composerBox.top + 1),
      x - composerBox.left - COMPOSER_PREFIX_CELLS,
      INPUT_MAX_ROWS,
      composerWidth,
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
      // モーダル表示中はマウスも飲む。クリックを通すと `setFocus('list')` で背後の
      // 許可ダイアログが立ち上がり（`pending` の条件が focus 依存）、モーダルの
      // 相互排他が崩れる。ホイールでの選択移動も同じ経路なので一律で無視する。
      // `/prompt` のエディタは自前でドラッグ範囲選択を持つので、ここで飲まないと
      // 同じレポートが兄弟の useInput にも届き、ヘッダや一覧の選択まで動いてしまう。
      if (update || modelSelect || promptEdit) {
        return;
      }
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
    // 立て直しの結果表示も次の操作で引っ込める（エラーと違い一過性の通知）。
    recovery.setNotice(undefined);
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
    // `/update` のダイアログはモーダル扱い（キーを一切下へ漏らさない）。独立した
    // useInput は持たず、y/n 確認と同じくここで処理する（1画面 1 useInput）。
    if (update) {
      // `npm install` 中は Esc だけ通す。ここで全キーを飲むと、Ctrl+C を拾わない
      // （`exitOnCtrlC: false`）この TUI では `/exit` すら打てず、最長
      // `INSTALL_TIMEOUT_MS` のあいだ操作不能になる。Esc はダイアログを閉じるだけで
      // npm 自体は走り続ける（世代カウンタで結果表示だけを捨てる）。y の取り違えで
      // 二重実行しないよう、y/n は受け付けない。
      if (update.kind === 'installing') {
        if (key.escape) {
          closeUpdate();
        }
        return;
      }
      if (updatePrompt) {
        if (input === 'y' || input === 'Y') {
          installUpdate(updatePrompt);
        } else if (input === 'n' || input === 'N' || key.escape) {
          closeUpdate();
        }
        return;
      }
      // 確認を伴わない表示（確認中・最新・失敗・完了・手動案内）は任意キーで閉じる。
      closeUpdate();
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
    if (confirmRecoverAll) {
      if (input === 'y' || input === 'Y') {
        recovery.runAll();
        setConfirmRecoverAll(false);
      } else if (input === 'n' || input === 'N' || key.escape) {
        setConfirmRecoverAll(false);
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
    // 一括立て直し。再開と同じくフォーカス横断の chord にする（詰まりに気づくのは
    // 一覧の PR 列を眺めているときなので、入力欄にいても 1 手で打てる必要がある）。
    // 1 件のときも出すのは、再開と違って「選択して押す」代替キーを用意していないため。
    if (key.ctrl && (input === 'f' || input === 'F') && stuck.length > 0 && !recovering) {
      setConfirmRecoverAll(true);
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
      // 送信したものは（コマンドも含めて）履歴へ積む。コマンドも積むのは shell と
      // 同じ発想で、`/model` の打ち直しにも ↑ が効く方が自然だから。
      history.record(enter.text);
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
    // ↑↓ は「表示行の端でさらに押したら入力履歴」— shell / readline と同じ一般的な
    // 仕組み。空の入力欄や1行の書きかけでは即座に履歴を呼び出し、複数行を編集している
    // 途中ではキャレット移動を優先する（行の途中で書きかけが history に化けない）。
    // 履歴が無い / 最古に到達 / 辿っていないのに ↓ のときは undefined が返るので、
    // そのまま下の editText（= 従来のキャレット移動）に落ちる。
    if (key.upArrow || key.downArrow) {
      const atEdge = key.upArrow
        ? atFirstComposerRow(bufferRef.current, composerWidth)
        : atLastComposerRow(bufferRef.current, composerWidth);
      const recalled = atEdge
        ? history.recall(key.upArrow ? 'prev' : 'next', bufferRef.current.value)
        : undefined;
      if (recalled !== undefined) {
        // キャレットは末尾へ（呼び出した指示をそのまま送る/続けて直せる位置）。
        updateBuffer(bufferOf(recalled));
        return;
      }
    }
    // ↑↓ は折り返し後の**表示行**で動かす（wrapWidth）。論理行だと長い1行の途中から
    // 一気に先頭へ飛び、見えている行と操作が食い違う。
    const edit = editText(bufferRef.current, input, key, {
      arrows: true,
      vertical: true,
      wrapWidth: composerWidth,
    });
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
        usage={rateLimits}
        now={now}
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
                    <PrCell pr={s.pr} status={s.prStatus} lookup={s.prLookup} />
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
        {/* PR が詰まっている行があるあいだ常時出す。Ctrl+F もフォーカス横断なので、
            再開の案内と同じくフッタではなく独立した行に置く。 */}
        {stuck.length > 0 ? (
          <Text color={statusColor.failed}>{m.recover.allHint(stuck.length)}</Text>
        ) : null}
        {recovering ? (
          <Text color={statusColor.running}>{m.recover.running}</Text>
        ) : recovery.notice ? (
          <Text color={statusColor.completed}>{recovery.notice}</Text>
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
        ) : confirmRecoverAll ? (
          <DialogBox>
            <ConfirmPrompt
              kind="recoverAll"
              busy={busy}
              syncCount={stuckSync}
              ciCount={stuck.length - stuckSync}
            />
          </DialogBox>
        ) : null}
        {/* `/update` は確認ダイアログと同じ位置（コンポーザ直上）に出す。
            マージ/破棄の確認とは排他ではないが、キーはモーダルとして先に飲むので
            同時に両方が操作されることはない。 */}
        {update ? <UpdateDialog state={update} activeSessions={activeSessions} /> : null}
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
          onCopy={onCopy}
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
      <StatusFooter mode={mode} hint={footerHint} />
    </Box>
  );
};
