import { Box, type DOMElement, Text, useInput, useWindowSize } from 'ink';
import { type FC, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  type AgentId,
  agentLabelOf,
  COMMANDS,
  choiceIndexAtRow,
  choiceRowHeights,
  choiceView,
  composerRowCount,
  type DiffStat,
  dialogContentWidth,
  dialogMaxRows,
  isInterruptible,
  isResumable,
  isTerminalStatus,
  type LogCollapse,
  logViewportRows,
  type ModelOption,
  paletteMaxRows,
  parseSgrMouse,
  resumeInstruction,
  type SessionManager,
  subagentChoices,
  subagentRow,
  subagentRowHit,
  subagentRowLabel,
  type ToolRun,
  toolRunLabel,
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
  useClock,
  useCommandRunner,
  useLifecycleAction,
  useRecovery,
  useRunMode,
  useSessions,
} from './hooks';
import { useMessages } from './i18n-context';
import { normalizeChord } from './input';
import { BLANK_ROW } from './log-line';
import { LogPane, useLogPane } from './log-pane';
import { LoginDialog } from './login-dialog';
import { ModelSelect } from './model-select';
import { PermissionDialog } from './permission-dialog';
import { PrSummary } from './pr-cell';
import { StatusFooter } from './status-footer';
import { SubagentPicker } from './subagent-picker';
import { glyph, statusColor, theme } from './theme';

/**
 * 許可/質問ダイアログが出ているあいだのフォーカスゾーン（Tab で往復）。
 *
 * - `dialog`（既定）… `PermissionDialog` がキーを持つ。view 側は出口の Tab だけを処理する。
 * - `log` … ↑↓ / PgUp / PgDn が**会話ログのスクロール**に戻る。ダイアログは
 *   `active={false}` で表示のまま残す（回答の途中経過は内部 state なのでアンマウントしない）。
 *
 * ゾーンを分ける理由は一覧の `ListFocus` と同じ「↑↓ が指す対象を一意にする」こと。
 * かつては `pending` のあいだキーを全部ダイアログへ委譲していたため、**質問の背景
 * （何をしようとしているのか）を読み返せないまま回答させられていた**。
 */
type DetailFocus = 'dialog' | 'log';

/**
 * The in-app detail view: live log of a single session plus a follow-up
 * composer. Reconnects to the running SDK session (no external CLI) — send
 * routes straight to `manager.send`, and merge/discard live in an actions panel.
 *
 * A single `useInput` runs a small state machine (panel = input | actions) so
 * typing and command keys never collide (see .claude/rules/ink-components.md).
 * When the session is blocked on a permission/question, the dialog owns the keys
 * unless the user tabs over to the log ({@link DetailFocus}).
 */
export const SessionDetail: FC<{
  manager: SessionManager;
  id: string;
  /** `/model` の選択肢（Claude Code のカタログ）。undefined は取得中。 */
  models?: readonly ModelOption[];
  /**
   * エージェントごとの `/model` の選択肢。Claude / Codex / Grok は選べるモデルが
   * まったく別なので、このセッションを駆動しているエージェントで引く。
   * 表に無いエージェントは {@link models}（Claude 側）へフォールバックする。
   */
  modelsByAgent?: Partial<Record<AgentId, readonly ModelOption[]>>;
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
  /**
   * 連続したツール実行を既定で畳むか（`~/.codiva/config.json` の `collapseToolLogs`。
   * 未指定は畳む）。ここが決めるのは**開いた直後の状態**だけで、`Ctrl+O` / `/tools`
   * でいつでも一括の開閉ができる。
   */
  collapseTools?: boolean;
  /**
   * サブエージェント専用のログ画面を開く（ログ下段の行をクリック / `/subagents`）。
   * 渡されなければその導線を出さない（合成ルートが View を持たない構成でも壊れない）。
   */
  onOpenSubagent?: (taskId: string) => void;
}> = ({
  manager,
  id,
  models,
  modelsByAgent,
  onBack,
  onCopy,
  onOpenUrl,
  collapseTools,
  onOpenSubagent,
}) => {
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
  /**
   * 連続したツール実行を畳むか（`Ctrl+O` / `/tools` で一括切替）。false のあいだは
   * まとめ行そのものを出さない = 従来どおりの全部入りのログになる。
   */
  const [grouping, setGrouping] = useState(collapseTools !== false);
  /** 個別に開いてあるまとまりの key（`ToolRun.key` = 先頭エントリの seq）。 */
  const [openRuns, setOpenRuns] = useState<ReadonlySet<number>>(() => new Set());
  const [panel, setPanel] = useState<'input' | 'actions'>('input');
  // 許可/質問ダイアログが出ているあいだのゾーン（`pending` のときだけ意味を持つ）。
  // 既定は `dialog`: 回答は待たせている用事なので、そこへ辿り着くのに Tab を踏ませない
  // （一覧の `zoneForRow` と同じ方針）。
  const [dialogFocus, setDialogFocus] = useState<DetailFocus>('dialog');
  // Open when the user runs `/model`; the ModelSelect dialog then owns the keys.
  const [modelSelect, setModelSelect] = useState(false);
  // Open when the user runs `/agent`; the AgentSelect dialog then owns the keys.
  const [agentSelect, setAgentSelect] = useState(false);
  // codiva 内ログイン中のエージェント（null = 閉じている）。開くと LoginDialog がキーを持つ。
  const [loginAgent, setLoginAgent] = useState<AgentId | null>(null);
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
  // ダイアログがキーを持っているか。`log` ゾーンでは表示だけになり、↑↓ はログへ戻る。
  const dialogActive = pending !== undefined && dialogFocus === 'dialog';
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
  // 表示名は provider ごとの固有名詞なのでアダプタから引く（カタログには置かない）。
  const agentNames = useMemo(
    () => new Map(manager.listAgents().map((a) => [a.id, a.displayName])),
    [manager],
  );
  // 会話ログの中の切替の区切り行。`logLines` のメモ化の依存に入るので、毎描画で
  // 作り直さないよう useCallback で固定する（作り直すと全行を再展開してしまう）。
  const agentDivider = useCallback(
    (agentId: AgentId) => m.agent.logDivider(agentNames.get(agentId) ?? agentId),
    [m, agentNames],
  );
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
      pane.toBottom();
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
    pane.toBottom();
    // interrupt は SDK の control request（await で返る）。サブプロセスがもう居ない等で
    // reject し得るので裸で投げない（unhandled rejection = TUI の死。git-and-io.md）。
    void manager.interrupt(session.id).catch(() => undefined);
  };

  // 決着が付いたら（回答した / ターンが先へ進んだ）ゾーンを既定へ畳む。宙に浮かせたまま
  // にすると、同じセッションが次に質問した瞬間にキーの意味が変わる（一覧が composer へ
  // 畳むのと同じ理由）。
  useEffect(() => {
    if (!pending && dialogFocus !== 'dialog') {
      setDialogFocus('dialog');
    }
  }, [pending, dialogFocus]);

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
      // `/login` はこのセッションの provider に codiva 内でサインインする。
      login: () => {
        const id = session?.agent;
        if (id && manager.canLogin(id)) {
          setLoginAgent(id);
        } else {
          setActionError(m.login.unsupported(agent?.displayName ?? ''));
        }
      },
      // `/diff` toggles the changes summary (hidden by default for log room).
      diff: () => setShowChanges((v) => !v),
      // `/tools` は Ctrl+O と同じ（キーを知らなくてもパレットから辿れるように置く）。
      tools: () => toggleTools(),
      // `/subagents` はサブエージェントの専用ログへ入る。**マウスを無効にしている
      // 環境ではログ下段の行をクリックできない**ので、これがキーボードからの唯一の経路。
      subagents: () => openSubagents(),
      // `/sync` merges the base branch into THIS session's worktree; a conflict is
      // left in place and handed to this very session to resolve.
      sync: () => {
        if (recovering) {
          return;
        }
        recovery.run(id, 'sync');
        pane.toBottom(); // the instruction lands at the tail — follow it
      },
      // `/fix-ci` asks this session to fix its PR's red checks.
      fixCi: () => {
        if (recovering) {
          return;
        }
        recovery.run(id, 'ci');
        pane.toBottom();
      },
      // `/remove` はこのセッションを記録ごと削除する（操作パネルの `x` と同じ確認へ）。
      remove: () => setConfirm('remove'),
      // `/recover` と `/clear` は複数セッションが対象なので詳細ビューには置かない
      // （ハンドラの無いコマンドは昇格しないので、打っても通常の指示として流れる）。
    },
    setActionError,
  );
  // 詳細ビューの `/exit` は一覧へ戻る動作なので、パレット/ヘルプの説明も差し替える
  // （既定は「codiva を終了」= 一覧ビューの意味）。
  const commandDescribes = useMemo(() => ({ exit: m.command.exitDetail }), [m.command.exitDetail]);

  // まとめ行の文言。グリフ（▸/▾）は theme、語はカタログ、並べ方は純粋な
  // `toolRunLabel` が持つ。`logLines` のメモ化の依存に入るので useCallback で固定する。
  const runLabel = useCallback(
    (run: ToolRun, expanded: boolean) =>
      `${expanded ? glyph.expanded : glyph.collapsed} ${toolRunLabel(run.counts, m)}`,
    [m],
  );
  const collapse = useMemo<LogCollapse | undefined>(
    () => (grouping ? { label: runLabel, isExpanded: (key) => openRuns.has(key) } : undefined),
    [grouping, runLabel, openRuns],
  );
  /**
   * 会話ログのビューポート 1 面ぶん（実測・スクロール・範囲選択・URL クリック・
   * まとめ行の開閉・端の自動スクロール）。サブエージェント詳細と**同じ** `useLogPane` を
   * 通すので、「触っていない行がコピーされる」類の不具合が片方の画面だけで再発しない。
   *
   * 折返し幅はこのビューの横パディング（左右 1 セルずつ）を引いた値。ストリーミング中の
   * 本文も同じ幅で折り返す（食い違うと確定した瞬間に行の割れ方が変わって画面が組み変わる）。
   *
   * 畳み込みの**state はここ（view）が持ち**、機械（press で保留 → drag で取消 →
   * release で開閉、アンカーの固定）は pane が持つ。
   */
  const pane = useLogPane({
    entries: session?.messages,
    streamingText: session?.streamingText,
    width: Math.max(1, columns - 2),
    fallbackRows: logViewportRows,
    divider: agentDivider,
    collapse,
    onToggleGroup: (key) =>
      setOpenRuns((prev) => {
        const next = new Set(prev);
        if (!next.delete(key)) {
          next.add(key);
        }
        return next;
      }),
    onCopy,
    onOpenUrl,
  });

  /**
   * ツール実行のまとめを一括で切り替える（`Ctrl+O` / `/tools`）。個別に開いてあった
   * ぶんは捨てる — 「全部たたむ / 全部ひらく」の結果が押すたびに変わらないようにする。
   */
  const toggleTools = () => {
    pane.beforeToggle();
    setGrouping((on) => !on);
    setOpenRuns(new Set());
  };

  // ── サブエージェント（ログ下段の 1 行 + 複数件の選択ダイアログ）─────────────
  const subagents = session?.subagents;
  // 走っているサブエージェントがある間だけ 1 秒ごとに再描画する（経過時間の表示）。
  // provider が所要時間を報告していれば `subagentElapsedMs` がそれを使うので、
  // 決着後は時計が止まる = 無条件の 1s タイマーを詳細ビューに持ち込まない。
  const ticking = (subagents ?? []).some((run) => run.status === 'running');
  const now = useClock(1000, ticking);
  const subagentState = useMemo(() => subagentRow(subagents), [subagents]);
  // ラベルは**表示幅に切って**受け取る（毎秒変わる文字列を切らずに `<Text>` へ渡すと
  // Ink の上限なしキャッシュに積まれ続ける）。`width` はクリック当たり判定の右端。
  const subagentLabel = useMemo(
    () =>
      subagentRowLabel(
        subagentState,
        m,
        `${glyph.bullet} `,
        Math.max(1, columns - 2),
        ticking ? now : undefined,
      ),
    [subagentState, m, columns, ticking, now],
  );
  const subagentRef = useRef<DOMElement>(null);
  const subagentBox = useAbsolutePosition(subagentRef);
  const subagentHeight = useBoxHeight(subagentRef);
  /**
   * press した位置にあったサブエージェントの task id（`'pick'` = 複数件なので
   * ダイアログを出す）。**離すまで開かない**ための保留で、drag が来たら取り消す
   * （行の上からドラッグを始めただけで画面が変わらないように。URL と完全同型）。
   */
  const pendingSubagentRef = useRef<string | undefined>(undefined);
  /**
   * 複数件の選択ダイアログ。カーソルは index ではなく **task id** で持つ —
   * 開いている最中に新しいサブエージェントが append されても、指している対象が
   * 別物に化けない。
   */
  const [pick, setPick] = useState<string | undefined>(undefined);
  const pickItems = useMemo(
    () => subagentChoices(subagents ?? [], m, ticking ? now : undefined),
    [subagents, m, ticking, now],
  );
  const pickIndex = Math.max(
    0,
    (subagents ?? []).findIndex((run) => run.id === pick),
  );
  const pickRef = useRef<DOMElement>(null);
  const pickBox = useAbsolutePosition(pickRef);
  const pickHeight = useBoxHeight(pickRef);
  const picking = pick !== undefined;
  // 折返し幅と表示ウィンドウは**ここで 1 度だけ**組み、描画（`SubagentPicker`）と
  // クリックの逆算の両方に同じものを渡す。別々に計算すると押した行と当たった
  // 選択肢がズレる（許可ダイアログと同じ約束）。
  const pickWidth = dialogContentWidth(columns);
  const pickHeights = useMemo(() => choiceRowHeights(pickItems, pickWidth), [pickItems, pickWidth]);
  const pickView = useMemo(
    // 見出し + ヒントの 2 行を残して選択肢に割り当てる。
    () => choiceView(pickHeights, pickIndex, Math.max(1, dialogMaxRows(rows, 'detail') - 2)),
    [pickHeights, pickIndex, rows],
  );

  /**
   * サブエージェント行が**実際に描かれているか**。あの 1 行は認証・再開の案内と
   * 同居していて、そちらが優先されると出ない（描いていない行のクリックを拾わない）。
   *
   * 関数にしてあるのは `resumable` の宣言がこれより下にあるため（呼ばれるのは
   * マウスイベントの時点なので初期化済み）。
   */
  const showsSubagentRow = (): boolean =>
    status !== 'needs_login' && !resumable && subagentLabel !== undefined;

  /**
   * その 1 行に当たったか。実測できていない・行が出ていないあいだは判定しない
   * （黙って別の場所を押したことにするより、押せないほうがよい）。
   */
  const subagentHit = (x: number, y: number): boolean =>
    showsSubagentRow() &&
    subagentBox !== undefined &&
    subagentHeight !== undefined &&
    subagentLabel !== undefined &&
    subagentRowHit({ x, y }, subagentBox, subagentHeight, subagentLabel.width);

  /**
   * 選択ダイアログのクリック位置 → 選択肢 index。判定は**描いたウィンドウ**で行い、
   * 上端のインジケータ 1 行ぶんずらす。縦に潰れている（実測 < 描いた行数）あいだは
   * 当たり判定そのものをやめる。
   */
  const pickRowAt = (y: number): number | undefined => {
    if (!pickBox) {
      return undefined;
    }
    const visible = pickHeights.slice(pickView.start, pickView.end);
    const drawn =
      visible.reduce((sum, height) => sum + height, 0) +
      (pickView.showAbove ? 1 : 0) +
      (pickView.showBelow ? 1 : 0);
    if (pickHeight !== undefined && pickHeight < drawn) {
      return undefined;
    }
    const hit = choiceIndexAtRow(visible, y - pickBox.top - (pickView.showAbove ? 1 : 0));
    return hit === undefined ? undefined : pickView.start + hit;
  };

  /** サブエージェントを開く（1 件なら直行、複数件なら選択ダイアログ）。 */
  const openSubagents = () => {
    const list = subagents ?? [];
    if (!onOpenSubagent || list.length === 0) {
      // 0 件は一過性の通知で伝える（黙って無反応にしない）。
      recovery.setNotice(m.subagent.empty);
      return;
    }
    const only = list.length === 1 ? list[0] : undefined;
    if (only) {
      onOpenSubagent(only.id);
      return;
    }
    // 1 択のダイアログは出さない。複数件は代表を初期カーソルにして選ばせる。
    setPick(subagentState.kind === 'idle' ? list.at(-1)?.id : subagentState.run.id);
  };

  // 対象が全部消えたらダイアログを閉じる（宙に浮いたカーソルを残さない）。
  // 許可/質問が来たときも畳む — 回答は待たせている用事なので優先する（一覧・詳細が
  // ゾーンを既定へ戻すのと同じ方針）。
  useEffect(() => {
    if (pick !== undefined && ((subagents ?? []).length === 0 || pending)) {
      setPick(undefined);
    }
  }, [pick, subagents, pending]);
  useInput((rawInput, rawKey) => {
    // SGR マウスレポートはキー入力より先に解釈する（レポート断片が生テキストとして
    // editText に流れ込み「スクロールしようとすると文字が入力される」のを防ぐ）。
    const mouse = parseSgrMouse(rawInput);
    if (mouse) {
      // 画面を占有するモーダル表示中はマウスも飲む（一覧の `session-list.tsx` と同じ方針）。
      // `parseSgrMouse` で弾くのは自分のハンドラを守るだけで、同じ生入力は兄弟の
      // useInput にも届く。飲まないとダイアログ上の 1 クリックで背後のログの選択が
      // 動き、URL の上ならブラウザまで開いてしまう。
      if (modelSelect || agentSelect || loginAgent !== null) {
        return;
      }
      // 許可/質問ダイアログにキーがあるあいだ（`dialog` ゾーン）は**押下系だけ**飲む。
      // ホイールは通す — スクロールは押下と違って副作用が無く、質問の背景を読み返す
      // 第一の手段なので、ここで奪うと「ログが見えないまま回答」に戻ってしまう。
      // `log` ゾーンではユーザーが明示的にログを触ると選んだ状態なので、範囲選択・
      // URL のクリックもそのまま通す。
      if (dialogActive && mouse.kind !== 'wheel') {
        return;
      }
      // 選択ダイアログ表示中はホイールだけ通す（スクロールは副作用が無く、ログを
      // 読み返す手段。許可ダイアログと同じ例外）。押下は下のカーソル移動で扱う。
      if (picking && mouse.kind === 'wheel') {
        pane.handleMouse(mouse);
        return;
      }
      // 押下の裁定順は**この view が持つ**（コンポーザ → サブエージェント行 → ログ）。
      // ログ側の機械（選択・URL とまとめ行の保留・端の自動スクロール）は `useLogPane`
      // の中で、サブエージェント詳細とまったく同じものが動く。
      if (mouse.kind === 'wheel') {
        pane.handleMouse(mouse);
      } else if (mouse.kind === 'press') {
        // コンポーザ内のクリックはキャレット移動 + 選択アンカー（当たり判定と選択の機械は
        // 共通の `useComposer`）。ログ行の上ならログの範囲選択を始める（どちらでもなければ
        // 両方のハイライトを解除）。
        if (composer.handleMouse(mouse)) {
          pane.clearPendingLink();
          pane.clearSelection();
        } else if (picking) {
          // ダイアログ内の押下は選択肢のカーソル移動だけ（**決定は Enter**）。
          // 枠の外なら閉じる。どちらでも背後のログの選択は始めない。
          const index = pickRowAt(mouse.y);
          const target = index === undefined ? undefined : (subagents ?? [])[index];
          if (target) {
            setPick(target.id);
          } else if (pickBox && mouse.y < pickBox.top) {
            setPick(undefined);
          }
        } else if (
          mouse.button === 'left' &&
          !pending &&
          subagentHit(mouse.x, mouse.y) &&
          onOpenSubagent
        ) {
          // **押した時点では開かない**（drag で範囲選択を始めるつもりの操作で画面が
          // 変わらないように）。左ボタン限定 = 右クリック（端末メニュー）・中クリック
          // （貼り付け）で遷移しない。許可/質問待ちの間も遷移しない — アンマウントすると
          // ダイアログの内部 state（何問目か・書きかけの自由記述）が捨てられる。
          const list = subagents ?? [];
          pendingSubagentRef.current = list.length === 1 ? list[0]?.id : 'pick';
          pane.clearPendingLink();
          pane.clearSelection();
        } else {
          pane.handleMouse(mouse);
        }
      } else if (mouse.kind === 'drag') {
        // ドラッグになった = 範囲選択なので、開く候補は取り消す。
        pendingSubagentRef.current = undefined;
        if (picking) {
          return;
        }
        if (composer.handleMouse(mouse)) {
          pane.clearPendingLink();
        } else {
          pane.handleMouse(mouse);
        }
      } else if (mouse.kind === 'release') {
        // ドラッグにならずに離した = 単なるクリック → ここで開く（URL と同型）。
        const target = pendingSubagentRef.current;
        pendingSubagentRef.current = undefined;
        if (target !== undefined) {
          if (target === 'pick') {
            openSubagents();
          } else if (onOpenSubagent) {
            onOpenSubagent(target);
          }
          return;
        }
        if (picking) {
          return;
        }
        // 離した時点で 1 回だけコピー（ドラッグごとに送らない）。ハイライトは残す。
        // アンカーの無い側は no-op なので、両方に release を渡して構わない。
        composer.handleMouse(mouse);
        pane.handleMouse(mouse);
      }
      return;
    }
    // Shift+Enter 等の修飾キーは modifyOtherKeys / CSI-u エスケープで届き、Ink は
    // 生テキストとして渡す。一覧と同じ共通ヘルパーで実キーへ復号し、Enter/改行/
    // Tab/Esc の挙動を両画面で揃える（詳細で Shift+Enter が改行にならない不具合対策）。
    const { input, key } = normalizeChord(rawInput, rawKey);
    // 何かキーが来たらマウス選択のハイライトは消す（自動スクロールも止める）。
    composer.clearSelection();
    pane.clearSelection();
    // press の release が届かないまま（端末外で離した等）保留が残るのを防ぐ。
    pane.clearPendingLink();
    // 立て直しの結果表示は次の操作で引っ込める（エラーと違い一過性の通知）。
    recovery.setNotice(undefined);
    // The model picker is modal: its own useInput owns arrows/Enter/Esc. Swallow
    // everything here so nothing leaks through to the composer underneath.
    if (modelSelect || agentSelect || loginAgent !== null) {
      return;
    }
    // The /help overlay is dismissed by any key (swallowed so it doesn't also
    // edit/navigate underneath).
    if (showHelp) {
      setShowHelp(false);
      return;
    }
    if (key.escape) {
      // サブエージェントの選択ダイアログが最優先の出口（開いたものから順に閉じる）。
      if (picking) {
        setPick(undefined);
        return;
      }
      if (confirm) {
        setConfirm(null);
        return;
      }
      // ログを遡っていたなら、まず回答（ダイアログ）へ戻す。一覧の Esc がどのゾーンからも
      // 既定ゾーンへ戻るのと同じで、待たせている質問を素通りして画面を離れさせない。
      if (pending && !dialogActive) {
        setDialogFocus('dialog');
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
    // Ctrl+O = ツール実行のまとめを一括で開閉（Claude Code と同じキー）。`Ctrl+C` と
    // 同じくフォーカス横断の chord にしてある — 許可待ちでログを読み返している最中こそ
    // 「実際に何をしたのか」を開きたいので、ダイアログのゾーンでも効かせる
    // （ダイアログ側の useInput は ctrl chord を無視するので競合しない）。
    if (key.ctrl && (input === 'o' || input === 'O')) {
      toggleTools();
      return;
    }
    // サブエージェントの選択ダイアログ。**`pending` ガードより前**に置き、印字キーも
    // 含めて**全部飲む**（背後のコンポーザに文字が入らない = キーを持つモーダルを
    // 増やさずに同じ効果を得る）。Esc は上で、Ctrl+C / Ctrl+O はさらに前で処理済み。
    if (picking) {
      const list = subagents ?? [];
      if (key.upArrow || key.downArrow) {
        const next = Math.min(
          Math.max(0, pickIndex + (key.upArrow ? -1 : 1)),
          Math.max(0, list.length - 1),
        );
        setPick(list[next]?.id);
        return;
      }
      if (key.return) {
        const target = list[pickIndex];
        setPick(undefined);
        if (target && onOpenSubagent) {
          onOpenSubagent(target.id);
        }
        return;
      }
      return;
    }
    if (pending) {
      // 許可/質問待ちのあいだは 2 ゾーン（`DetailFocus`）を Tab で往復する。
      // ここに ↑↓ を両ゾーンで持たせないのが要点 — 一覧と同じで、混ぜるとダイアログの
      // 選択肢移動に食われてログを 1 行も遡れなくなる（= 質問の背景が読めない）。
      if (key.tab) {
        setDialogFocus(dialogActive ? 'log' : 'dialog');
        return;
      }
      if (dialogActive) {
        return; // PermissionDialog owns the keys（出口の Tab は上で処理した）
      }
      // `log` ゾーン: ログのスクロールだけを受ける（回答は Tab / クリックで戻ってから）。
      pane.handleScrollKey(key);
      // 印字キーはここでは何もしない（コンポーザはダイアログに場所を譲っていて出ていない）。
      return;
    }
    // Log scroll (terminal scrollback is disabled under the alt screen). The
    // step is derived from the *visible* log height, not the full terminal, so a
    // page never jumps past unseen lines.
    if (key.pageUp || key.pageDown) {
      pane.handleScrollKey(key);
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
      pane.handleScrollKey(key);
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
      pane.toBottom(); // jump back to the tail to watch the new turn
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
    : // ログインダイアログは Esc しか効かないので、ヒントもそれに合わせる。
      loginAgent !== null
      ? m.login.help
      : agentSelect
        ? m.agent.help
        : pending
          ? dialogActive
            ? m.detail.helpPending
            : m.detail.helpLog
          : panel === 'actions'
            ? m.detail.helpActions
            : m.detail.helpInput;
  // パレットに出す候補（`/` 付きなら前方一致、裸の名前は詳細で実行できるときだけ）。
  const paletteCommands = commands.palette(buffer.value);

  return (
    <Box flexDirection="column" flexGrow={1} padding={1}>
      {/*
       * ヘッダは持たない（要件: セッション詳細はコンテンツ + フッタのみ）。
       * 会話ログ + その直下の状態行（**常に 1 行**）。状態行が `<LogPane>` の中に
       * あるのは、あれが「ログの高さを状態で変えない」ための予約行だから — 離すと
       * 片方の画面で条件付きに戻されうる。この行がフッタとの間の余白も兼ねるので、
       * 下のブロックに `marginTop` は付けない（付けると空行が 2 行並ぶ）。
       */}
      <LogPane pane={pane} statusHint={m.detail.scrollHint} />

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
        {/* サブエージェントの実行状況もこの 1 行に**同居**させる（独立した行にすると
            `DETAIL_CHROME_ROWS` の引き算が 1 増え、24 行の端末で質問ダイアログの選択肢が
            窓に入らなくなる。`core/layout.ts`）。
            優先順位: 認証 → 再開 → サブエージェント → Ctrl+C → 空行。
            Ctrl+C より優先してよいのは、あれがフォーカス横断の chord で案内が無くても
            効くのに対し、「何が走っているか」はここでしか分からないから。逆に認証・再開は
            行動を促す案内なので譲る（そのときサブエージェントは走っていない）。
            計測 Box はこの 1 行だけを包む（クリック位置の逆算の原点）。
            押せることは下線で示す（ログ内リンクと同じアフォーダンス）。 */}
        <Box ref={subagentRef} flexShrink={0}>
          {status === 'needs_login' ? (
            <Text color={statusColor.needsLogin}>{m.auth.hint(agentLabelOf(agent))}</Text>
          ) : resumable ? (
            <Text color={statusColor.interrupted}>{m.resume.oneKeyHint}</Text>
          ) : subagentLabel ? (
            <Text
              color={statusColor.running}
              underline={onOpenSubagent !== undefined}
              wrap="truncate-end"
            >
              {subagentLabel.text}
            </Text>
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
            maxRows={paletteMaxRows(rows, 'detail')}
          />
        ) : null}

        {loginAgent !== null ? (
          <LoginDialog
            agentName={manager.listAgents().find((a) => a.id === loginAgent)?.displayName ?? ''}
            start={() => manager.startLogin(loginAgent)}
            onOpenUrl={onOpenUrl}
            onClose={(succeeded) => {
              setLoginAgent(null);
              if (succeeded) {
                void manager.refreshAgents().catch(() => undefined);
              }
            }}
          />
        ) : agentSelect ? (
          <AgentSelect
            mode="session"
            current={session.agent}
            agents={agentChoices}
            onSelect={(next) => {
              setAgentSelect(false);
              // 「今と同じ」かはマネージャに聞く（`session.agent` はスロットルされた
              // 購読値で、切替対応より前のセッションでは undefined にもなる）。
              const unchanged = manager.getSessionAgent(session.id)?.id === next;
              if (manager.setSessionAgent(session.id, next)) {
                const name = manager.getSessionAgent(session.id)?.displayName ?? '';
                recovery.setNotice(m.agent.switched(name));
              } else if (!unchanged) {
                // **同じエージェントを選び直したのはエラーではない**（カーソルは
                // 今のエージェントから始まるので `/agent` → Enter が最も打ちやすい）。
                // 一覧側の `setDefaultAgent` も同じ false を「何もしない」と扱っている。
                setActionError(m.agent.unavailable);
              }
              pane.toBottom();
            }}
            onLogin={(id2) => {
              if (manager.canLogin(id2)) {
                setAgentSelect(false);
                setLoginAgent(id2);
              }
            }}
            onCancel={() => setAgentSelect(false)}
          />
        ) : modelSelect ? (
          <ModelSelect
            // The session's live (resolved) model — pre-selects the current row.
            current={session.model}
            models={(session.agent && modelsByAgent?.[session.agent]) ?? models}
            onSelect={(model) => {
              manager.setSessionModel(session.id, model);
              setModelSelect(false);
              pane.toBottom();
            }}
            onCancel={() => setModelSelect(false)}
          />
        ) : picking ? (
          // 入力欄の位置に出す（許可ダイアログと同じ）= ログの席を削らない。
          // キーは view の単一ハンドラが処理する（このコンポーネントは描くだけ）。
          <SubagentPicker
            items={pickItems}
            view={pickView}
            cursor={pickIndex}
            width={pickWidth}
            listRef={pickRef}
          />
        ) : pending ? (
          // `log` ゾーンでも**描いたまま**にする（質問文を読みながらログを遡れるように）。
          // キーを持つのは `dialog` ゾーンのときだけで、無効化はアンマウントではなく
          // `active` で行う — 回答の途中経過（何問目か・チェック・書きかけの自由記述）は
          // 内部 state なので、Tab で往復するたびに捨てられては困る（一覧と同じ）。
          <PermissionDialog
            request={pending}
            active={dialogActive}
            // ダイアログをクリックしたら回答へ戻す（Tab と同じ出口をマウスにも用意する）。
            onActivate={() => setDialogFocus('dialog')}
            inactiveHint={m.detail.dialogInactiveHelp}
            onAnswer={(answers) => manager.answer(session.id, answers)}
            onAllow={() => manager.allow(session.id)}
            onDeny={(message) => manager.deny(session.id, message)}
            onCopy={onCopy}
            // 選択肢が多くても会話ログの席を残す（溢れはダイアログ側の内部スクロールへ）。
            // これが無いと 24 行の端末ではログの可視行が 0 になり、`Tab: ログを遡る` に
            // 切り替えても質問の背景を読めなかった（`core/layout.ts` の `dialogMaxRows`）。
            maxRows={dialogMaxRows(rows, 'detail')}
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
            {/* パレットは `commands.palette` が出す（`/` 付きは常に、裸の名前は実際に
                実行されるときだけ）。確定前に何が起きるか見えるようにするため。
                **入力欄の計測 Box の外**に置く（中に入れると実測した上端がずれて
                クリックが別の文字に当たる）。 */}
            {paletteCommands !== null ? (
              <CommandPalette
                title={m.command.paletteTitle}
                commands={paletteCommands}
                describeOverrides={commandDescribes}
                maxRows={paletteMaxRows(rows, 'detail')}
              />
            ) : null}
            <Composer
              composer={composer}
              focused
              placeholder={m.detail.followupPlaceholder(agentLabelOf(agent).name)}
            />
          </Box>
        )}

        {/* 許可要求を上げられない provider（Codex）では「確認モード」を言い切らない —
            ツールは確認なしに実行されるので、待っていれば聞かれると読めてしまう。 */}
        <StatusFooter
          mode={mode}
          hint={footerHint}
          confirmSupported={caps?.permissions !== false}
        />
      </Box>
    </Box>
  );
};
