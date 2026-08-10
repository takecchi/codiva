import { Box, type DOMElement, Text, useInput, useWindowSize } from 'ink';
import { type FC, useEffect, useMemo, useRef, useState } from 'react';
import {
  ARROW_SCROLL_LINES,
  agentLabelOf,
  COMMANDS,
  composerRowCount,
  type DiffStat,
  type DisplayLine,
  isFullscreenViewport,
  isInterruptible,
  isResumable,
  isTerminalStatus,
  LOG_EDGE_SCROLL_MS,
  type LogEdge,
  type LogPoint,
  type LogViewport,
  logCaretAt,
  logEdgeAt,
  logEdgePoint,
  logLines,
  logLinkAt,
  logRowSelection,
  logStatusRow,
  logViewportRows,
  logWindow,
  type ModelOption,
  matchCommands,
  parseSgrMouse,
  resumeInstruction,
  type ScrollAnchor,
  type SessionManager,
  scrollDown,
  scrollUp,
  streamTail,
  WHEEL_SCROLL_LINES,
} from '@/core';
import { AgentSelect } from './agent-select';
import { CommandPalette } from './command-palette';
import { Composer, useComposer } from './composer';
import { ConfirmPrompt } from './confirm-prompt';
import { DialogBox } from './dialog-box';
import {
  useAbsolutePosition,
  useAgentAvailability,
  useBoxHeight,
  useCommandRunner,
  useLifecycleAction,
  useLogDragSelection,
  useRecovery,
  useRunMode,
  useSessions,
} from './hooks';
import { useMessages } from './i18n-context';
import { normalizeChord } from './input';
import { BLANK_ROW, LOG_PREFIX, LogLine } from './log-line';
import { ModelSelect } from './model-select';
import { PermissionDialog } from './permission-dialog';
import { PrSummary } from './pr-cell';
import { StatusFooter } from './status-footer';
import { statusColor, theme } from './theme';

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
   * Codex セッションの `/model` の選択肢（`codex debug models`）。Claude とは
   * まったく別のモデル群なので、駆動中のエージェントで出し分ける。
   */
  codexModels?: readonly ModelOption[];
  /**
   * 一覧へ戻る。Esc と `/exit` の両方がここへ来る（詳細ビューの `/exit` は
   * アプリ終了ではなく「このセッションを閉じる」。終了は一覧の `/exit`）。
   */
  onBack: () => void;
  /** マウス選択（コンポーザ・ログ）をクリップボードへコピーする（main.tsx が OSC 52 を注入）。 */
  onCopy?: (text: string) => void;
  /**
   * ログ内の URL をブラウザで開く（main.tsx が `openUrl` を注入）。
   *
   * 端末任せ（Cmd+click）にできないのは、主端末の Ghostty がマウス捕捉中はリンク検出
   * そのものを止めるため。SGR マウスレポートに Cmd/Super のビットも無いので、
   * **codiva 自身がクリックを取って開く**のが全端末で唯一同じに動く経路になる
   * （OSC 8 は対応端末向けの上乗せ。`ui/log-line.tsx`）。
   */
  onOpenUrl?: (url: string) => void;
}> = ({ manager, id, models, codexModels, onBack, onCopy, onOpenUrl }) => {
  const m = useMessages();
  const sessions = useSessions(manager);
  const mode = useRunMode(manager);
  const { rows, columns } = useWindowSize();
  const session = sessions.find((s) => s.id === id);
  // フォローアップ入力欄。一覧・`/prompt`・質問の自由記述と同じ共通コンポーザを使う
  // （バッファ・折り返し幅・ドラッグ範囲選択・キー操作が 1 実装に揃う）。
  const composer = useComposer({ onCopy });
  const { buffer, bufferRef } = composer;
  const composerWidth = composer.wrapWidth;
  // ログの範囲選択。コンポーザとは別インスタンス（位置の基準が「文書の行 + 桁」で違う）。
  const logSel = useLogDragSelection(onCopy);
  // ドラッグが可視域の外へ出ている向き。ここにあるあいだ自動スクロールし続ける。
  const [edge, setEdge] = useState<LogEdge | undefined>(undefined);
  /**
   * press した位置にあった URL。**離すまで開かない**ための保留で、途中で drag が
   * 来たら取り消す（範囲選択のつもりの操作でブラウザを開かないため）。state ではなく
   * ref なのは、同一 tick に複数のマウスレポートがまとまって届いても順に読めるように
   * するため（`bufferRef` / `anchorRef` と同じ理由）。
   */
  const pendingLinkRef = useRef<string | undefined>(undefined);
  // ログ表示域の実測高さ。ここに描く行数の上限であり、スクロール1回の移動量の基準
  // でもある。見積り（logViewportRows）より実測を優先するのは、可視域より多く描くと
  // Yoga が溢れた行を「上でクリップ」せず「縮小」してしまい、ログの途中の行が
  // 虫食いで欠落するため（= 上へスクロールしても読めない状態になっていた）。
  const logRef = useRef<DOMElement>(null);
  const measuredLogRows = useBoxHeight(logRef);
  // ログ可視域の絶対位置（マウス当たり判定の原点）。
  const logBox = useAbsolutePosition(logRef);
  // Log scroll position; 'bottom' follows the newest line (see core/scroll.ts).
  const [anchor, setAnchor] = useState<ScrollAnchor>('bottom');
  // スクロール位置は ref にも持つ。理由は**同期的に読む必要がある**こと: 自動スクロールの
  // 1 tick は「次のアンカー」から選択の終点（`logEdgePoint`）を組み、さらに「動かなかったか」で
  // タイマーを止める判定をするので、setState の関数形（次の描画まで値が見えない）では書けない。
  // ref なら 1 チャンクにまとまって届いた複数レポートも順に積める。
  const anchorRef = useRef<ScrollAnchor>('bottom');
  const applyAnchor = (next: ScrollAnchor) => {
    anchorRef.current = next;
    setAnchor(next);
  };
  const [panel, setPanel] = useState<'input' | 'actions'>('input');
  // Open when the user runs `/model`; the ModelSelect dialog then owns the keys.
  const [modelSelect, setModelSelect] = useState(false);
  // Open when the user runs `/agent`; the AgentSelect dialog then owns the keys.
  const [agentSelect, setAgentSelect] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [diff, setDiff] = useState<DiffStat | undefined>(undefined);
  // 変更差分サマリは既定で畳んでおき（ログの縦幅を優先）、`/diff` でトグルする。
  const [showChanges, setShowChanges] = useState(false);
  // 確認/実行中/エラー + マージ・破棄・削除の実行は共有フックへ。成功時は入力パネルへ戻す。
  const { confirm, setConfirm, busy, actionError, setActionError, run } = useLifecycleAction(
    manager,
    id,
    (ok, action) => {
      if (!ok) {
        return;
      }
      // 削除すると開いている当のセッションが store から消える（= このビューは
      // 「セッションが見つかりません」になる）ので一覧へ戻す。マージ/破棄は行が
      // 残るので詳細に留まる。
      if (action === 'remove') {
        onBack();
        return;
      }
      setPanel('input');
    },
  );
  // `/sync` · `/fix-ci`（このセッションの PR の立て直し）。エラー欄は共有する。
  // 一覧と同じ理由で `busy`（全キーを飲む）には混ぜず、再実行の入口だけ塞ぐ。
  const recovery = useRecovery(manager, m, setActionError);
  const recovering = recovery.busy;

  const pending = session?.pendingPermission;
  const status = session?.status;
  const isTerminal = status !== undefined && isTerminalStatus(status);
  // このセッションを駆動しているエージェントと、その capability。UI は「持たない機能の
  // キー操作・ヒントを出さない」ために見る（`core/agent-ports.ts`）。`session.agent` は
  // 状態に載っていて `agent_switched` で更新されるので、切替の直後から正しく縮退する。
  const agent = manager.getSessionAgent(id);
  const caps = agent?.capabilities;
  // `/agent` の選択肢。登録されているアダプタだけなので、未対応の provider は出ない。
  // `/agent` を開いている間だけ導入・ログイン状態を検出する（開くまで叩かない）。
  const agentAvailability = useAgentAvailability(manager, agentSelect);
  const agentChoices = manager.listAgents().map((a) => ({
    id: a.id,
    displayName: a.displayName,
    command: a.loginCommand,
    availability: agentAvailability.get(a.id),
  }));
  // 進行中のターンがあるか（= Ctrl+C で中断できるか）。許可/質問待ちも対象
  // （ターンは生きていて回答待ちで止まっているだけ）。中断を持たない provider では
  // そもそも出さない。
  const interruptible =
    status !== undefined && isInterruptible(status) && caps?.interrupt !== false;
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
      applyAnchor('bottom');
    }
  };

  /**
   * 実行中のターンを中断する（`Ctrl+C`）。Claude Code の Ctrl+C と同じ「いま走っている
   * 作業をやめる」操作で、セッションは `interrupted`（再開可能）として残る（破棄ではない）。
   *
   * 対象判定（= 連打の吸収）は `manager.interrupt` に任せる — ここの `status` は
   * スロットルされた購読値なので「もう中断済み」を同期的には知らない（`resume` と同じ）。
   */
  const cancel = () => {
    if (!session || !interruptible) {
      return;
    }
    // 中断のログ行は末尾に付くので、過去ログを見ていても結果が見えるところへ戻す。
    applyAnchor('bottom');
    // interrupt は SDK の control request（await で返る）。サブプロセスがもう居ない等で
    // reject し得るので裸で投げない（unhandled rejection = TUI の死。git-and-io.md）。
    void manager.interrupt(session.id).catch(() => undefined);
  };

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
      // モデル切替を持たない provider では開かずに理由を出す（黙って無反応にしない）。
      model: () => {
        if (caps && !caps.setModel) {
          setActionError(m.agent.unsupported(agent?.displayName ?? ''));
          return;
        }
        setModelSelect(true);
      },
      // `/agent` はこのセッションを駆動する provider を切り替える。
      agent: () => setAgentSelect(true),
      // `/diff` toggles the changes summary (hidden by default for log room).
      diff: () => setShowChanges((v) => !v),
      // `/sync` merges the base branch into THIS session's worktree; a conflict is
      // left in place and handed to this very session to resolve.
      sync: () => {
        if (recovering) {
          return;
        }
        recovery.run(id, 'sync');
        applyAnchor('bottom'); // the instruction lands at the tail — follow it
      },
      // `/fix-ci` asks this session to fix its PR's red checks.
      fixCi: () => {
        if (recovering) {
          return;
        }
        recovery.run(id, 'ci');
        applyAnchor('bottom');
      },
      // `/remove` はこのセッションを記録ごと削除する（操作パネルの `x` と同じ確認へ）。
      remove: () => setConfirm('remove'),
      // `/recover` と `/clear` は複数セッションが対象なので詳細ビューには置かない
      // （ハンドラの無いコマンドは昇格しないので、打っても通常の指示として流れる）。
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
  // ログ行の折返し幅。状態行のプレビューも**同じ幅**で切る（食い違うと 1 行に
  // 収まらず、状態行が 2 行になってログの高さを削ってしまう）。
  const logWidth = Math.max(1, columns - 2);
  const lines = useMemo<DisplayLine[]>(
    () => (messages ? logLines(messages, logWidth, (kind) => LOG_PREFIX[kind]) : []),
    [messages, logWidth],
  );
  const total = lines.length;
  // ログを描く行数 = スクロール1回の移動量の基準 = アンカーの下限。`logWindow` と
  // スクロール（移動量・アンカーの下限）で必ずこの同じ値を使う — 食い違うと最上部で
  // アンカーが 1 行手前で止まり、先頭行に到達できなくなる。
  // 全画面時は実測した可視高さに収める（実測が入るまでの1フレームだけ見積りで代用）。
  // インライン描画時（端末が低くて全画面化しない）はクリップされず端末スクロールに
  // 任せるため実測は使わず（高さ=内容なので測っても自分自身になる）、再描画コストの
  // 上限として端末 rows を使う。
  // **スクロール位置にもストリーミングにも依存しない**のが要点: プレビュー行も
  // スクロール案内もログ枠の外の状態行（常に 1 行）へ出す（`logStatusRow`）。
  // ここを可変にすると見えているログ全体が 1 行跳ねる（= ガクガクする）。
  const logCap = isFullscreenViewport(rows)
    ? Math.max(1, Math.floor(measuredLogRows ?? logViewportRows(rows)))
    : Math.max(1, rows);
  // ライブ入力中のプレビュー。幅で切ってから渡す — Ink は測った文字列をプロセス
  // グローバルな上限なしキャッシュへ永久に積むので、デルタごとに変わる長い行を
  // そのまま渡すとヒープが単調増加する（`streamTail` の注記参照）。
  const preview = session?.streamingText ? streamTail(session.streamingText, logWidth) : '';
  // 実際に描くウィンドウ。当たり判定（どの行をクリックしたか）と描画で**同じ結果**を使う。
  const win = logWindow(lines, logCap, anchor);
  // ログ直下に必ず 1 行描く状態行（プレビュー / スクロール案内 / 空行）。
  const logStatus = logStatusRow(win, preview);
  /**
   * ログ可視域の幾何。すべて描画に使った実測値・同じウィンドウから組むので、クリック位置の
   * 逆算が別の行に当たらない。実測前とインライン描画時（低い端末＝マウス捕捉もしない）は
   * undefined にして、当たり判定そのものをやめる（黙って別の行を選ぶより選べないほうがよい）。
   */
  const logView: LogViewport | undefined =
    logBox && measuredLogRows !== undefined && isFullscreenViewport(rows)
      ? {
          top: logBox.top,
          left: logBox.left,
          height: Math.max(1, Math.floor(measuredLogRows)),
          firstRow: win.hiddenAbove,
          rows: win.entries.length,
        }
      : undefined;

  /** ログの選択を捨てる（端の自動スクロールも止める）。 */
  const clearLogSelection = () => {
    logSel.clear();
    setEdge(undefined);
  };

  /**
   * 端でのドラッグ 1 tick: 1 行スクロールし、選択の終点を**スクロール後の**端の行へ伸ばす。
   * これで新しく現れた行がそのまま選択に入り、「画面の上端／下端までドラッグすると、
   * そのままスクロールしながら選択が続く」になる。
   */
  const edgeStep = (dir: LogEdge) => {
    const current = anchorRef.current;
    const next =
      dir === 'up'
        ? scrollUp(current, total, logCap, ARROW_SCROLL_LINES)
        : scrollDown(current, total, logCap, ARROW_SCROLL_LINES);
    applyAnchor(next);
    // 終点は**次に描かれる**ウィンドウの端の行。行数（`logCap`）はスクロール位置に
    // 依存しないので、そのまま次のアンカーで数え直せばよい。
    logSel.extend(logEdgePoint(logWindow(lines, logCap, next), dir));
    if (next === current) {
      // 文書の端まで来た（もう動かない）: タイマーを止める。release のレポートを取り逃した
      // ときに永久にスクロールし続けないための保険にもなっている。
      setEdge(undefined);
    }
  };

  // 端で押さえたまま静止していてもスクロールを続けるためのタイマー。SGR ?1002 は
  // **セルが変わったときだけ**移動を報告するので、レポート駆動だけでは端で止まってしまう。
  // 最新の edgeStep は ref 経由で渡し、タイマーは向きが変わったときだけ張り替える
  // （ログの追記や再描画ごとにタイマーを作り直すと 1 tick も進まないことがある）。
  const edgeStepRef = useRef(edgeStep);
  useEffect(() => {
    edgeStepRef.current = edgeStep;
  });
  useEffect(() => {
    if (!edge) {
      return undefined;
    }
    const timer = setInterval(() => edgeStepRef.current(edge), LOG_EDGE_SCROLL_MS);
    return () => clearInterval(timer);
  }, [edge]);

  // 端末幅が変わるとログを再折り返すため、行 index の指す文字が変わる。ズレた位置を
  // 光らせ続けない（deps を付けられないのは logSel の参照が毎描画で変わるため）。
  // ログが上限に達して**古いエントリが落ちた**ときも同じ理由で捨てる（選択は文書先頭
  // からの表示行 index なので、先頭が消えると別の行を指す = 触っていない行がコピーされる）。
  const widthRef = useRef(columns);
  const firstSeqRef = useRef(messages?.[0]?.seq);
  useEffect(() => {
    const firstSeq = messages?.[0]?.seq;
    if (widthRef.current !== columns || firstSeqRef.current !== firstSeq) {
      widthRef.current = columns;
      firstSeqRef.current = firstSeq;
      clearLogSelection();
    }
  });

  /**
   * ログ選択のアンカー（press）。行の上ならその文字、**行より上の余白**（ログが可視域に
   * 満たないときの末尾寄せの隙間・上パディング）なら先頭行の行頭にする — 「画面のいちばん
   * 上から下へ」というドラッグを受けたいので、ここでクリックを捨てない。行より下
   * （プレビュー行・操作パネル側）は当たりにしない（ログ以外の要素があるので黙って食わない）。
   */
  const logAnchorAt = (x: number, y: number): LogPoint | undefined => {
    if (!logView) {
      return undefined;
    }
    const point = logCaretAt(lines, logView, x, y);
    if (point) {
      return point;
    }
    return logEdgeAt(logView, y) === 'up' ? logEdgePoint(win, 'up') : undefined;
  };

  /**
   * ログ上のドラッグ。可視域の外へ出たらその向きへ自動スクロールしながら選択を伸ばし
   * （`edgeStep` + タイマー）、内側なら指している文字まで終点を動かす。
   */
  const handleLogDrag = (x: number, y: number) => {
    if (!logView) {
      return;
    }
    const dir = logEdgeAt(logView, y);
    if (dir) {
      setEdge(dir);
      edgeStep(dir); // レポートが来た時点で 1 行進めておく（タイマーを待たない）
      return;
    }
    setEdge(undefined);
    const point = logCaretAt(lines, logView, x, y);
    if (point) {
      logSel.extend(point);
    }
  };

  useInput((rawInput, rawKey) => {
    // SGR マウスレポートはキー入力より先に解釈する（レポート断片が生テキストとして
    // editText に流れ込み「スクロールしようとすると文字が入力される」のを防ぐ）。
    const mouse = parseSgrMouse(rawInput);
    if (mouse) {
      // モーダル表示中はマウスも飲む（一覧の `session-list.tsx` と同じ方針）。
      // `parseSgrMouse` で弾くのは自分のハンドラを守るだけで、同じ生入力は兄弟の
      // useInput にも届く。飲まないとダイアログ上の 1 クリックで背後のログの選択が
      // 動き、URL の上ならブラウザまで開いてしまう（許可待ちの最中に）。
      if (modelSelect || agentSelect || pending) {
        return;
      }
      if (mouse.kind === 'wheel') {
        applyAnchor(
          mouse.dir === 'up'
            ? scrollUp(anchorRef.current, total, logCap, WHEEL_SCROLL_LINES)
            : scrollDown(anchorRef.current, total, logCap, WHEEL_SCROLL_LINES),
        );
      } else if (mouse.kind === 'press') {
        // コンポーザ内のクリックはキャレット移動 + 選択アンカー（当たり判定と選択の機械は
        // 共通の `useComposer`）。ログ行の上ならログの範囲選択を始める（どちらでもなければ
        // 両方のハイライトを解除）。
        if (composer.handleMouse(mouse)) {
          pendingLinkRef.current = undefined;
          clearLogSelection();
        } else {
          setEdge(undefined);
          // URL の上で押したら「離すまでドラッグしなければ開く」候補として覚える。
          // 押した時点では開かない — ドラッグで範囲選択を始めた場合に開いてしまう。
          // **左ボタンだけ**: 右クリック（端末のコンテキストメニューを期待した操作）や
          // 中クリック（貼り付け）でブラウザを開くのは意図しない副作用になる。
          pendingLinkRef.current =
            logView && mouse.button === 'left'
              ? logLinkAt(lines, logView, mouse.x, mouse.y)
              : undefined;
          const point = logAnchorAt(mouse.x, mouse.y);
          if (point) {
            logSel.begin(point);
          } else {
            logSel.clear();
          }
        }
      } else if (mouse.kind === 'drag') {
        // ドラッグになった = 範囲選択なので、リンクを開く候補は取り消す。
        pendingLinkRef.current = undefined;
        if (!composer.handleMouse(mouse) && logSel.dragging()) {
          handleLogDrag(mouse.x, mouse.y);
        }
      } else if (mouse.kind === 'release') {
        // 離した時点で 1 回だけコピー（ドラッグごとに送らない）。ハイライトは残す。
        // アンカーの無い側は no-op なので、両方に release を渡して構わない。
        composer.handleMouse(mouse);
        logSel.end(lines);
        setEdge(undefined);
        // ドラッグにならずに URL の上で離した = 単なるクリック → ブラウザで開く。
        const url = pendingLinkRef.current;
        pendingLinkRef.current = undefined;
        if (url !== undefined && onOpenUrl) {
          onOpenUrl(url);
        }
      }
      return;
    }
    // Shift+Enter 等の修飾キーは modifyOtherKeys / CSI-u エスケープで届き、Ink は
    // 生テキストとして渡す。一覧と同じ共通ヘルパーで実キーへ復号し、Enter/改行/
    // Tab/Esc の挙動を両画面で揃える（詳細で Shift+Enter が改行にならない不具合対策）。
    const { input, key } = normalizeChord(rawInput, rawKey);
    // 何かキーが来たらマウス選択のハイライトは消す（自動スクロールも止める）。
    composer.clearSelection();
    clearLogSelection();
    // press の release が届かないまま（端末外で離した等）保留が残るのを防ぐ。
    pendingLinkRef.current = undefined;
    // 立て直しの結果表示は次の操作で引っ込める（エラーと違い一過性の通知）。
    recovery.setNotice(undefined);
    // The model picker is modal: its own useInput owns arrows/Enter/Esc. Swallow
    // everything here so nothing leaks through to the composer underneath.
    if (modelSelect || agentSelect) {
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
    // Ctrl+C = 実行中のターンを中断（Claude Code の Ctrl+C と同じ操作）。Ink は
    // `exitOnCtrlC: false` で起動しているので、このキーはアプリ終了ではなくここへ届く。
    //
    // **`pending` ガードより前**に置く: 許可/質問ダイアログが出ている間も中断したい
    // （回答したくない作業をやめる唯一の出口。deny は「その1ツールを断る」だけで
    // ターンは続く）。ダイアログ側の useInput は ctrl chord を無視するので競合しない。
    if (key.ctrl && (input === 'c' || input === 'C')) {
      cancel();
      return;
    }
    if (pending) {
      return; // PermissionDialog owns the keys
    }
    // Log scroll (terminal scrollback is disabled under the alt screen). The
    // step is derived from the *visible* log height, not the full terminal, so a
    // page never jumps past unseen lines.
    if (key.pageUp) {
      applyAnchor(scrollUp(anchorRef.current, total, logCap));
      return;
    }
    if (key.pageDown) {
      applyAnchor(scrollDown(anchorRef.current, total, logCap));
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
    // ↑/↓ でログを1行スクロールする。マウス無効環境（設定 `"mouse": false` / 非 TTY）では
    // alt screen の端末がホイールを ↑/↓ に変換して送ってくる（alternate scroll mode）ので、
    // これがホイールの受け口も兼ねる。
    // 複数行を編集している最中だけはキャレット移動を優先する（ログは PgUp/PgDn で辿れる）。
    // 「複数行」は**折り返し後の表示行**で数える — 長い1行も画面上は複数行なので、
    // ↑↓ がログスクロールに吸われるとその行の中を移動できなくなる。
    if (
      (key.upArrow || key.downArrow) &&
      (panel === 'actions' || composerRowCount(bufferRef.current.value, composerWidth) <= 1)
    ) {
      applyAnchor(
        key.upArrow
          ? scrollUp(anchorRef.current, total, logCap, ARROW_SCROLL_LINES)
          : scrollDown(anchorRef.current, total, logCap, ARROW_SCROLL_LINES),
      );
      return;
    }
    if (panel === 'actions') {
      if (input === 'm' || input === 'M') {
        setConfirm('merge');
      } else if (input === 'd' || input === 'D') {
        setConfirm('discard');
      } else if (input === 'x' || input === 'X') {
        setConfirm('remove');
      } else if ((input === 'r' || input === 'R') && resumable) {
        resume();
      }
      return;
    }
    // input panel（複数行コンポーザ。Enter で送信 / Shift+Enter で改行、矢印はキャレット
    // 移動、Esc で戻る）。判定は一覧と共通の `handleKey`。
    const result = composer.handleKey(input, key);
    if (result.kind !== 'submit') {
      return;
    }
    // A leading `/` is a command (e.g. /model), not a follow-up instruction — and
    // so is a bare word that exactly matches a command this view implements.
    if (commands.run(result.text)) {
      composer.reset();
      return;
    }
    if (result.text && session) {
      manager.send(session.id, result.text);
      composer.reset();
      applyAnchor('bottom'); // jump back to the tail to watch the new turn
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
    : agentSelect
      ? m.agent.help
      : pending
        ? m.detail.helpPending
        : panel === 'actions'
          ? m.detail.helpActions
          : m.detail.helpInput;
  // コマンドとして解決される入力か（`/` 付き、または詳細で使える名前と完全一致）。
  const commandPreview = commands.preview(buffer.value);

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
          {/* 選択のハイライトは**文書の行 index**で引く（win.hiddenAbove + 表示位置）。
              スクロールしても同じ文字が光り続けるのがこのビューの選択の要件。 */}
          {win.entries.map((line, i) => (
            <LogLine
              key={line.key}
              line={line}
              sel={
                logSel.selection
                  ? logRowSelection(logSel.selection, win.hiddenAbove + i, line.text.length)
                  : undefined
              }
            />
          ))}
        </Box>
      </Box>

      {/*
       * ログ直下の状態行。**常に 1 行**を占める（中身が無いときは空行）。ここを
       * 条件付きで出し入れすると、その上のログビューポートの高さが 1 行変わって
       * 見えているログ全体が跳ねる（= スクロールがガクガクする）。詳細は
       * `core/scroll.ts` の `LogStatusRow`。この行がフッタとの間の余白も兼ねるので、
       * 下のブロックに `marginTop` は付けない（付けると空行が 2 行並ぶ）。
       */}
      <Box flexShrink={0}>
        {logStatus.kind === 'preview' ? (
          <Text color={theme.accent} dimColor wrap="truncate-end">
            {logStatus.text}
          </Text>
        ) : logStatus.kind === 'scrollback' ? (
          <Text color={theme.warn} dimColor wrap="truncate-end">
            {m.detail.scrollHint(logStatus.hiddenBelow)}
          </Text>
        ) : (
          <Text>{BLANK_ROW}</Text>
        )}
      </Box>

      <Box flexDirection="column" flexShrink={0}>
        {/* 複数 PR を出したセッションだけ、全件の番号をここに出す（一覧の行末セルは
            `#12 +1` としか書けないので、`+1` の中身を確かめられる唯一の場所）。
            1 本しか無いセッションでは何も描かない = ログの縦幅を削らない。 */}
        <PrSummary state={session} />

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
            開かずに効くので、パネル内の `r` だけでは気づけない。まだ走っている（中断できる）
            セッションでは同じ位置に Ctrl+C の案内を出す（1行を状態で使い分ける）。 */}
        {/* `flexShrink={0}`: Yoga は溢れた子を縮小するので、付けないと低い端末で案内が
            高さ0に潰れて消える。縮む役は flexGrow のログ領域（内部スクロールで収まる）。
            ログ直下の状態行と同じ理由で**常に 1 行**にする（該当なしのときも空行）。
            ここはターンが終わるたびに出入りするので、条件付きにするとログが 1 行跳ねる。 */}
        <Box flexShrink={0}>
          {status === 'needs_login' ? (
            <Text color={statusColor.needsLogin}>{m.auth.hint(agentLabelOf(agent))}</Text>
          ) : resumable ? (
            <Text color={statusColor.interrupted}>{m.resume.oneKeyHint}</Text>
          ) : interruptible ? (
            // 中断も Ctrl+R と同じフォーカス横断の chord なので、フッタではなく独立した
            // 行で案内する（フッタヒントは入力欄/操作パネルで切り替わってしまう）。
            <Text dimColor>{m.detail.cancelHint}</Text>
          ) : (
            <Text>{BLANK_ROW}</Text>
          )}
        </Box>
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
        {showHelp && !pending ? (
          <CommandPalette
            title={m.command.helpTitle}
            commands={COMMANDS}
            describeOverrides={commandDescribes}
          />
        ) : null}

        {agentSelect ? (
          <AgentSelect
            mode="session"
            current={session.agent}
            agents={agentChoices}
            onSelect={(next) => {
              setAgentSelect(false);
              if (manager.setSessionAgent(session.id, next)) {
                const name = manager.getSessionAgent(session.id)?.displayName ?? '';
                recovery.setNotice(m.agent.switched(name));
              } else {
                setActionError(m.agent.unavailable);
              }
              applyAnchor('bottom');
            }}
            onCancel={() => setAgentSelect(false)}
          />
        ) : modelSelect ? (
          <ModelSelect
            // The session's live (resolved) model — pre-selects the current row.
            current={session.model}
            models={session.agent === 'codex' ? codexModels : models}
            onSelect={(model) => {
              manager.setSessionModel(session.id, model);
              setModelSelect(false);
              applyAnchor('bottom');
            }}
            onCancel={() => setModelSelect(false)}
          />
        ) : pending ? (
          <PermissionDialog
            request={pending}
            onAnswer={(answers) => manager.answer(session.id, answers)}
            onAllow={() => manager.allow(session.id)}
            onDeny={(message) => manager.deny(session.id, message)}
            onCopy={onCopy}
          />
        ) : panel === 'actions' ? (
          <DialogBox flexDirection="column">
            {/* `clear` は一覧ビュー専用（件数付きの variant）。詳細では立てないが、
                共有フックの型に含まれるのでここで除外して narrowing する。 */}
            {confirm && confirm !== 'clear' ? (
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
                <Text>
                  <Text color={theme.no}>x</Text>: {m.detail.removeAction}
                </Text>
              </>
            )}
          </DialogBox>
        ) : (
          <Box flexDirection="column">
            {/* Enter の判定（`commands.preview`）と同じ条件で出す。スラッシュ無しの
                `exit` でも確定前に何が起きるか見えるようにするため。**入力欄の計測 Box の
                外**に置く（中に入れると実測した上端がずれてクリックが別の文字に当たる）。 */}
            {commandPreview !== null ? (
              <CommandPalette
                title={m.command.paletteTitle}
                commands={matchCommands(commandPreview)}
                describeOverrides={commandDescribes}
              />
            ) : null}
            <Composer composer={composer} focused placeholder={m.detail.followupPlaceholder} />
          </Box>
        )}

        <StatusFooter mode={mode} hint={footerHint} />
      </Box>
    </Box>
  );
};
