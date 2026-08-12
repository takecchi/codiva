import { clipStreamText, pushLogEntry } from './log-buffer';
import { addPrRefs, extractPrRefs } from './pr-detect';
import type { RateLimitInfoJson } from './rate-limit';
import { isResumable } from './status-meta';
import {
  appendLog,
  completeTurn,
  progressOf,
  toFailed,
  toInterrupted,
  toNeedsLogin,
  toRateLimited,
} from './status-reducer';
import type { AgentId, AgentStopCause, SessionState, TaskStatus, TodoItem } from './types';

/**
 * エージェント非依存の「起きたこと」の語彙と、その畳み込み。
 *
 * codiva はもともと Claude Agent SDK の `SDKMessage` を直接 `SessionState` へ畳んで
 * いた（旧 `applySdkMessage`）。そのため「SDK メッセージの形の知識」と「状態をどう
 * 変えるか」が 1 か所に混ざっており、別のエージェント（Codex / Grok）を足すには
 * 畳み込みごと書き直すしかなかった。
 *
 * ここで 2 段に割る:
 *
 *   provider のメッセージ ──[アダプタの parse]──▶ AgentEvent[] ──[applyAgentEvent]──▶ SessionState
 *
 * - 前半（形の知識）は各アダプタが持つ（Claude なら `core/claude-parse.ts`）。
 * - 後半（ログの積み方・状態遷移・no-op の判定）は**全 provider 共通**でここにある。
 *
 * これにより新しいエージェントは「自分のストリームを AgentEvent へ写す」だけで済み、
 * ログの上限・進捗・サブエージェントの完了ゲート・コスト集計といった codiva 固有の
 * 振る舞いを再実装しなくてよい。**セッション途中でエージェントを切り替えても**
 * （`Session.setAgent`）ログと状態は連続したままになる。
 */

/** ツールの「意味」。provider ごとに実際のツール名は違うのでここへ正規化する。 */
export type AgentToolKind = 'edit' | 'shell' | 'todo' | 'question' | 'other';

/**
 * TODO リストへの操作。Claude の TaskCreate / TaskUpdate / TodoWrite のような
 * provider 固有のツール入力は、アダプタがこの 3 種へ写してから渡す。
 */
export type TodoOp =
  | { op: 'create'; subject: string; activeForm?: string }
  | { op: 'update'; id: string; status?: TaskStatus; subject?: string; activeForm?: string }
  | {
      op: 'replace';
      items: readonly { subject: string; status: TaskStatus; activeForm?: string }[];
    };

/** provider 非依存の「エージェントに起きたこと」。 */
export type AgentEvent =
  /** セッションが確立した（resume 用の id と解決済みモデルが分かる）。 */
  | { kind: 'session_started'; sessionId?: string; model?: string }
  /**
   * アシスタントのメッセージが 1 通届き始めた。ストリーミングのプレビューを捨てて
   * `running` へ戻す（保留中の許可があるときは維持）ための区切りで、本文は続く
   * `assistant_text` / `tool_use` が運ぶ。
   */
  | { kind: 'assistant_message'; model?: string }
  /**
   * 解決済みモデルが**あとから**分かった。ストリームがモデル名を運ばない provider
   * （Codex）が、別経路で調べた結果を報告するための専用イベント。
   *
   * `session_started` / `assistant_message` にも `model` は載るが、あちらは
   * 「ターンが動いている」ことを表す区切りでもあるため `status` を `running` に
   * 戻してしまう。到着順が読めない非同期の問い合わせ結果をあれに相乗りさせると、
   * 完了したセッションが `running` に巻き戻る。こちらは**モデル欄だけ**を触る。
   */
  | { kind: 'model_resolved'; model: string }
  | { kind: 'assistant_text'; text: string; timestamp?: number }
  | {
      kind: 'tool_use';
      /** provider 側の tool_use id。`tool_result` との突き合わせに使う。 */
      id?: string;
      /** ログ 1 行ぶんの要約（アダプタが作る）。 */
      summary: string;
      tool: AgentToolKind;
      todo?: TodoOp;
      /** PR 作成コマンド（`gh pr create`）だったか（`core/pr-detect.ts`）。 */
      prCreate?: boolean;
      timestamp?: number;
    }
  | {
      kind: 'tool_result';
      toolUseId?: string;
      /** ログ 1 行ぶんの要約（先頭 1 行）。 */
      summary: string;
      /**
       * PR URL 検出のために走査するテキスト（`PR_DETECT_SCAN_CHARS` で上限済み）。
       * 対応する tool_use が `prCreate` だったときだけ読まれる。
       */
      scanText?: string;
    }
  /** 新しいアシスタントメッセージが始まる — ストリーミングプレビューを白紙に戻す。 */
  | { kind: 'stream_reset' }
  /** ストリーミング中の増分テキスト（ライブプレビュー用）。 */
  | { kind: 'stream_text'; text: string }
  /**
   * 情報だけのログ行（API リトライ等）。`coalesceKey` を持つと、直前の system 行が
   * 同じ接頭辞なら**書き換える**（件数を増やさない）。
   */
  | { kind: 'notice'; text: string; coalesceKey?: string }
  /** サブエージェント（Task）が走り始めた — 完了ゲートに積む。 */
  | { kind: 'task_started'; taskId: string }
  /** サブエージェントが片付いた — 全部片付いたら保留中の完了を確定する。 */
  | { kind: 'task_settled'; taskId?: string }
  /**
   * **今生きているサブエージェントの全集合**（レベル信号）。`task_started` /
   * `task_settled` のエッジと違い、届いた集合で**丸ごと置き換える** — エッジを
   * 1 通取りこぼしても完了ゲートが wedge しない（= セッションが永久に `running` に
   * ならない）ようにするための自己修復経路。出せる provider だけが出せばよい。
   */
  | { kind: 'tasks_changed'; taskIds: readonly string[] }
  /** ターンが正常終了した。 */
  | { kind: 'turn_completed'; text: string; totalCostUsd?: number }
  /**
   * ターンが完了以外で終わった。
   *
   * `rollup` は「これは既に診断済みの停止を要約しているだけ」の印。provider が同じ
   * 失敗を 2 回（詳細なメッセージ + ターン終了の要約）報告するとき、2 回目で分類を
   * やり直すと精度が落ちる（認証切れが「よく分からない failed」に格下げされる）ので、
   * 既に resumable な状態ならコストだけ取って何もしない。
   */
  | {
      kind: 'turn_stopped';
      cause: AgentStopCause;
      detail: string;
      totalCostUsd?: number;
      /** `rate_limit` のとき、制限が解除される時刻（epoch ms）。 */
      resetsAt?: number;
      rollup?: boolean;
    }
  /**
   * アカウント全体の使用状況。セッションの状態ではないので畳み込みでは無視し、
   * `Session` が横に流す（`onRateLimit`）。
   */
  | { kind: 'usage'; info: RateLimitInfoJson };

/** TODO 操作を 1 つ適用する。 */
function applyTodoOp(todos: TodoItem[], op: TodoOp): TodoItem[] {
  if (op.op === 'create') {
    return [
      ...todos,
      {
        id: String(todos.length + 1),
        subject: op.subject,
        status: 'pending',
        activeForm: op.activeForm,
      },
    ];
  }
  if (op.op === 'update') {
    return todos.map((t) =>
      t.id !== op.id
        ? t
        : {
            ...t,
            status: op.status ?? t.status,
            subject: op.subject ?? t.subject,
            activeForm: op.activeForm ?? t.activeForm,
          },
    );
  }
  return op.items.map((t, i) => ({
    id: String(i + 1),
    subject: t.subject,
    status: t.status,
    activeForm: t.activeForm,
  }));
}

/** `turn_completed` の畳み込み（サブエージェントが残っていれば保留する）。 */
function onTurnCompleted(
  state: SessionState,
  event: Extract<AgentEvent, { kind: 'turn_completed' }>,
  at: number,
): SessionState {
  const cost = event.totalCostUsd ?? state.totalCostUsd;
  // サブエージェントがまだ走っている: この完了はバックグラウンド化された Task が
  // 先に tool_result を返したせいで届いたもので、作業はまだ終わっていない。
  // 最後の 1 本が片付くまで `running` のまま保留する。
  if ((state.activeTaskIds?.length ?? 0) > 0) {
    return {
      ...state,
      totalCostUsd: cost,
      streamingText: undefined,
      deferredResult: { at, totalCostUsd: cost, resultText: event.text },
    };
  }
  return completeTurn(state, { at, totalCostUsd: cost, resultText: event.text });
}

/** `turn_stopped` の畳み込み（分類ごとの遷移 + 要約の二重適用ガード）。 */
function onTurnStopped(
  state: SessionState,
  event: Extract<AgentEvent, { kind: 'turn_stopped' }>,
  at: number,
): SessionState {
  const cost = event.totalCostUsd ?? state.totalCostUsd;
  // 既に診断済みの停止の要約なら、分類をやり直さずコストだけ取る。
  if (event.rollup && isResumable(state.status)) {
    return cost === state.totalCostUsd ? state : { ...state, totalCostUsd: cost };
  }
  switch (event.cause) {
    case 'auth':
      return { ...toNeedsLogin(state, at, event.detail), totalCostUsd: cost };
    case 'rate_limit':
      return { ...toRateLimited(state, at, event.detail, event.resetsAt), totalCostUsd: cost };
    case 'connection':
      return { ...toInterrupted(state, at, event.detail), totalCostUsd: cost };
    default:
      return { ...toFailed(state, at, event.detail), totalCostUsd: cost };
  }
}

/**
 * 中立イベントを 1 つ畳み込む。**全 provider 共通の唯一の状態遷移経路**。
 *
 * `agent` は「今どのエージェントが喋っているか」で、ログ行の帰属に使う
 * （セッション途中で切り替えたとき、どこからが Codex の発言かを残すため）。
 */
export function applyAgentEvent(
  state: SessionState,
  event: AgentEvent,
  at: number,
  agent?: AgentId,
): SessionState {
  switch (event.kind) {
    case 'session_started': {
      const sessionId = event.sessionId ?? state.sdkSessionId;
      const model = event.model ?? state.model;
      return {
        ...state,
        // CLI プロセスが起き直った＝前のプロセスのタスクはもう居ない。レベル信号は
        // 起動時に何も出さない（membership が変わったときだけ）ので、ここで空に
        // 戻さないと、前のプロセスの id が残ったまま誰も片付けられなくなる
        // （SDK の `SDKBackgroundTasksChangedMessage` が明示している要件）。
        activeTaskIds: undefined,
        // 保留中の許可がある間は awaiting_* を維持する（ダイアログの裏で
        // "Running" に戻さない）。
        status: state.pendingPermission ? state.status : 'running',
        sdkSessionId: sessionId,
        // 切替で戻ってきたときに resume できるよう、provider ごとに id を控える。
        agentSessions:
          agent && sessionId && state.agentSessions?.[agent] !== sessionId
            ? { ...state.agentSessions, [agent]: sessionId }
            : state.agentSessions,
        model,
      };
    }

    // 状態は動かさない（順序に依存しないので、ターンが終わったあとに届いても安全）。
    case 'model_resolved':
      return state.model === event.model ? state : { ...state, model: event.model };

    case 'assistant_message': {
      const model = event.model ?? state.model;
      const status = state.pendingPermission ? state.status : 'running';
      if (state.status === status && state.streamingText === undefined && model === state.model) {
        return state;
      }
      return { ...state, status, streamingText: undefined, model };
    }

    case 'assistant_text': {
      const text = event.text.trim();
      if (text.length === 0) {
        return state;
      }
      const seq = state.logSeq + 1;
      return {
        ...state,
        messages: pushLogEntry(state.messages, {
          seq,
          kind: 'assistant_text',
          text,
          timestamp: event.timestamp,
          agent,
        }),
        logSeq: seq,
      };
    }

    case 'tool_use': {
      const todos = event.todo ? applyTodoOp(state.todos, event.todo) : state.todos;
      const prCreateToolIds =
        event.prCreate && event.id
          ? trackPrCreate(state.prCreateToolIds, event.id)
          : state.prCreateToolIds;
      const seq = state.logSeq + 1;
      return {
        ...state,
        todos,
        progress: todos === state.todos ? state.progress : progressOf(todos),
        prCreateToolIds,
        messages: pushLogEntry(state.messages, {
          seq,
          kind: 'tool_use',
          text: event.summary,
          timestamp: event.timestamp,
          agent,
        }),
        logSeq: seq,
      };
    }

    case 'tool_result': {
      let extraPrs = state.extraPrs;
      let prCreateToolIds = state.prCreateToolIds;
      // `gh pr create` の結果だけを走査する（ログ全体から URL を拾うと `gh pr list` の
      // 出力や他人の PR まで「このセッションの PR」になる）。
      if (event.toolUseId && prCreateToolIds?.includes(event.toolUseId)) {
        const rest = prCreateToolIds.filter((id) => id !== event.toolUseId);
        prCreateToolIds = rest.length > 0 ? rest : undefined;
        // 既に PR がある場合も `gh pr create` はその URL を出すので、ブランチの PR と
        // 同じものは弾く（`+1` として二重に数えないため）。
        const found = extractPrRefs(event.scanText ?? '').filter(
          (ref) => ref.url !== state.pr?.url,
        );
        extraPrs = addPrRefs(extraPrs, found);
      }
      if (event.summary.length === 0) {
        if (extraPrs === state.extraPrs && prCreateToolIds === state.prCreateToolIds) {
          return state;
        }
        return { ...state, extraPrs, prCreateToolIds };
      }
      const seq = state.logSeq + 1;
      return {
        ...state,
        extraPrs,
        prCreateToolIds,
        messages: pushLogEntry(state.messages, {
          seq,
          kind: 'tool_result',
          text: event.summary,
          agent,
        }),
        logSeq: seq,
      };
    }

    case 'stream_reset':
      return state.streamingText === undefined ? state : { ...state, streamingText: undefined };

    case 'stream_text': {
      if (event.text.length === 0) {
        return state;
      }
      return {
        ...state,
        // 保留中の許可があるセッションは awaiting_* のまま。
        status: state.pendingPermission ? state.status : 'running',
        // 描画されるのは末尾 1 行だけなので、丸ごと持ち歩かない。
        streamingText: clipStreamText((state.streamingText ?? '') + event.text),
      };
    }

    case 'notice': {
      const last = state.messages.at(-1);
      // 直前が同種の通知なら seq を保ったまま書き換える（連発でログを流さない）。
      if (event.coalesceKey && last?.kind === 'system' && last.text.startsWith(event.coalesceKey)) {
        return {
          ...state,
          messages: [...state.messages.slice(0, -1), { ...last, text: event.text }],
        };
      }
      const withLog = appendLog(state, 'system', event.text);
      return { ...state, messages: withLog.messages, logSeq: withLog.logSeq };
    }

    case 'task_started': {
      const active = state.activeTaskIds ?? [];
      if (active.includes(event.taskId)) {
        return state;
      }
      return { ...state, activeTaskIds: [...active, event.taskId] };
    }

    case 'task_settled': {
      const active = state.activeTaskIds ?? [];
      // id が無い決着通知は**ゲートを空にする**。「どのタスクか分からないので何もしない」
      // にすると、その 1 通で完了ゲートが永久に埋まったままになり（片付いたタスクへの
      // `task_settled` はもう来ない）セッションが `running` から出られなくなる。
      // 早すぎる完了より張り付きのほうが害が大きいので、安全側は「空にする」。
      const next = event.taskId ? active.filter((id) => id !== event.taskId) : [];
      // 最後の 1 本が片付き、保留していた完了があるなら今こそ確定する。走っている
      // 状態のときだけ — 途中で失敗/中断したセッションを遅れて来た通知で
      // completed にしない。許可/質問待ちだった場合は `deferredResult` を持ったまま
      // ゲートだけ空にし、回答して `running` へ戻る `permission_resolved` が確定する
      // （`settleDeferred`。ここで諦めると完了が永久に失われる）。
      if (next.length === 0 && state.deferredResult && state.status === 'running') {
        return completeTurn(state, { ...state.deferredResult, at });
      }
      if (next.length === active.length) {
        return state;
      }
      return { ...state, activeTaskIds: next };
    }

    case 'tasks_changed': {
      // REPLACE セマンティクス。エッジ（task_started / task_settled）の取りこぼしを
      // ここで必ず正す — これがあるので「1 通落ちてゲートが永久に埋まる」が起きない。
      const active = state.activeTaskIds ?? [];
      const next = [...event.taskIds];
      if (next.length === active.length && next.every((id, i) => id === active[i])) {
        return state;
      }
      if (next.length === 0 && state.deferredResult && state.status === 'running') {
        return completeTurn(state, { ...state.deferredResult, at });
      }
      return { ...state, activeTaskIds: next };
    }

    case 'turn_completed':
      return onTurnCompleted(state, event, at);

    case 'turn_stopped':
      return onTurnStopped(state, event, at);

    // アカウント全体の使用状況はセッション状態ではない（`Session` が横に流す）。
    case 'usage':
      return state;

    default:
      return state;
  }
}

/**
 * 未応答の PR 作成コマンドを何件まで覚えておくか。tool_use は通常すぐ次の
 * メッセージで応答されるので、並行呼び出しをまたげれば十分。上限を置くことで
 * 結果が返らないセッションが状態を無制限に伸ばせないようにする。
 */
const MAX_PENDING_PR_CREATES = 8;

/** `gh pr create` の tool_use id を結果が来るまで覚える（古いものから落ちる）。 */
function trackPrCreate(ids: readonly string[] | undefined, id: string): readonly string[] {
  const current = ids ?? [];
  return current.includes(id) ? current : [...current, id].slice(-MAX_PENDING_PR_CREATES);
}
