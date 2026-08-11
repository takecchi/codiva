import { clipLogText, pushLogEntry } from './log-buffer';
import { withoutPrRef } from './pr-detect';
import { makeTitle } from './slug';
import { isActiveStatus } from './status-meta';
import type {
  CodivaEvent,
  CreateSessionInput,
  LogEntry,
  LogKind,
  PrCheckRun,
  PrStatus,
  SessionState,
  TodoItem,
} from './types';

/**
 * Content equality for the named failing checks. Needed because each poll parses a
 * brand-new array out of the `gh` payload: without this the `pr` event would always
 * look like a status change and rebuild `prStatus` (and re-render every row) on
 * every tick, even while CI sat still.
 */
function sameChecks(
  a: readonly PrCheckRun[] | undefined,
  b: readonly PrCheckRun[] | undefined,
): boolean {
  if (a === b) {
    return true;
  }
  if (!a || !b || a.length !== b.length) {
    return false;
  }
  return a.every((check, i) => check.name === b[i]?.name && check.url === b[i]?.url);
}

export function initialState(input: CreateSessionInput): SessionState {
  return {
    id: input.id,
    title: input.title,
    status: 'creating',
    prompt: input.prompt,
    branch: input.branch,
    worktreePath: input.worktreePath,
    todos: [],
    messages: [],
    startedAt: input.startedAt,
    // `creating` is an active status, so the clock starts running immediately.
    activeMs: 0,
    activeSince: input.startedAt,
    logSeq: 0,
  };
}

/**
 * Fold a status transition into the active-time accumulator. Called centrally
 * for every adopted state (see `Session.commit`) so we don't have to touch each
 * individual transition: whenever the session crosses the active/idle boundary
 * we either open a new segment (`activeSince = at`) or close the current one
 * (`activeMs += at - activeSince`). Staying on the same side is a no-op — the
 * spread in the reducers already carried `activeMs`/`activeSince` forward, so we
 * return `next` unchanged to preserve the caller's no-op/ref-equality checks.
 */
export function accrueActive(prev: SessionState, next: SessionState, at: number): SessionState {
  const wasActive = isActiveStatus(prev.status);
  const nowActive = isActiveStatus(next.status);
  if (wasActive === nowActive) {
    return next;
  }
  if (nowActive) {
    return { ...next, activeSince: at };
  }
  const segment = prev.activeSince !== undefined ? Math.max(0, at - prev.activeSince) : 0;
  return { ...next, activeMs: next.activeMs + segment, activeSince: undefined };
}

/**
 * Total active (working) time in ms as of `now`: the accumulated completed
 * segments plus the currently-open segment if the session is still active. This
 * is what the UI shows for "session running time" — idle waiting never counts.
 */
export function activeElapsedMs(state: SessionState, now: number): number {
  const open = state.activeSince !== undefined ? Math.max(0, now - state.activeSince) : 0;
  return state.activeMs + open;
}

/** Derive Step n/m progress from a todo list. Exported for session restoration. */
export function progressOf(todos: TodoItem[]): { done: number; total: number } | undefined {
  const active = todos.filter((t) => t.status !== 'deleted');
  if (active.length === 0) {
    return undefined;
  }
  return { done: active.filter((t) => t.status === 'completed').length, total: active.length };
}

/**
 * Append a log entry and bump the monotonic seq. Shared with `claude-parse.ts` so the
 * live SDK stream and the reducer's own events produce identically-sequenced logs.
 * The log is bounded (`pushLogEntry`): oversized texts are clipped and the oldest
 * entries fall off, so a long-lived session can't grow the heap without limit
 * (see `core/log-buffer.ts`).
 */
export function appendLog(
  state: SessionState,
  kind: LogKind,
  text: string,
  timestamp?: number,
): { messages: LogEntry[]; logSeq: number } {
  const seq = state.logSeq + 1;
  const entry: LogEntry = { seq, kind, text, timestamp };
  return { messages: pushLogEntry(state.messages, entry), logSeq: seq };
}

/**
 * ターンに紐づく一時情報（保留中の決定・サブエージェント完了ゲート）を落とす。
 * **ターンが終わるすべての遷移で通す。**
 *
 * `activeTaskIds` / `deferredResult` は「トップレベルの `result` は届いたが
 * バックグラウンドの Task がまだ走っている」ことの記録で、**そのターン限りの**もの。
 * ターンが終わったあとも残すと、次のターンの `turn_completed` まで「まだ Task が
 * 走っている」と誤認して保留され、ゲートを解く `task_settled` は二度と来ないので
 * **セッションが永久に `running` のまま張り付く**（実際に起きた不具合）。
 *
 * `pendingPermission` も同じ理由で落とす（応答できない `canUseTool` の promise が
 * ダイアログとして残り続ける）。`Session.commit` が「pending が消えた」ことを検知して
 * deny で解決するので、未応答の `tool_use` で終わる transcript にもならない。
 */
function clearTurnState(state: SessionState): SessionState {
  const { pendingPermission, ...rest } = clearTaskGate(state);
  void pendingPermission;
  return rest;
}

/**
 * サブエージェント完了ゲートだけを落とす（保留中の決定は残す）。
 * ステータスは変えずにゲートだけ捨てたい遷移用（`agent_switched`）。
 */
function clearTaskGate(state: SessionState): SessionState {
  const { deferredResult, activeTaskIds, ...rest } = state;
  void deferredResult;
  void activeTaskIds;
  return rest;
}

/**
 * ターンの完了を確定する（`completed` へ）。ログには「新しい情報のときだけ」結果
 * テキストを積む — 多くの provider は最後のアシスタント発話をターン結果としてもう一度
 * 返すので、そのまま積むと画面上で同じ文章が 2 回出る。比較は**クリップ後**の文字列で
 * 行う（`MAX_LOG_ENTRY_CHARS` より長い答えが自分自身の echo と一致しなくなるため）。
 *
 * `applyAgentEvent`（`turn_completed` / 最後の `task_settled`）と `reduce`
 * （`permission_resolved` = 許可待ちの裏で溜まっていた完了の確定）の**両方**から
 * 呼ぶので、`toInterrupted` などと同じくここに置く。
 */
export function completeTurn(
  state: SessionState,
  result: { at: number; totalCostUsd?: number; resultText: string },
): SessionState {
  const resultText = result.resultText.trim();
  const lastAssistantText = state.messages.findLast((m) => m.kind === 'assistant_text')?.text;
  const isEcho = resultText.length > 0 && clipLogText(resultText) === lastAssistantText;
  const withLog =
    resultText.length > 0 && !isEcho
      ? appendLog(state, 'result', resultText)
      : { messages: state.messages, logSeq: state.logSeq };
  return {
    ...clearTurnState(state),
    status: 'completed',
    finishedAt: result.at,
    totalCostUsd: result.totalCostUsd,
    streamingText: undefined,
    messages: withLog.messages,
    logSeq: withLog.logSeq,
  };
}

/**
 * 許可/質問待ちの裏で溜まっていたターン完了を確定できるなら確定する。
 *
 * サブエージェントの完了ゲート（`activeTaskIds`）が空になった瞬間に許可待ち
 * （バックグラウンド Task が上げた質問など）だったケースの受け皿。その瞬間は
 * `running` ではないので完了できず、ゲートは空なので `task_settled` も二度と来ない —
 * 回答して `running` に戻るここで拾わないと**完了が永久に失われる**（= ずっと Running）。
 */
function settleDeferred(state: SessionState, at: number): SessionState {
  if (!state.deferredResult || (state.activeTaskIds?.length ?? 0) > 0) {
    return state;
  }
  return completeTurn(state, { ...state.deferredResult, at });
}

/**
 * Transition into the `failed` state: the turn stopped for a reason that isn't
 * resumable (unclassified error). `reduce`（`aborted`）と `applyAgentEvent`
 * （`turn_stopped` の既定）の両方から呼ぶ — 失敗は終端なので、ここでも
 * `clearTurnState` でターン限りの一時情報を落とす（残すと、追加指示で再開したときに
 * 古い完了ゲートが次のターンの完了を飲み込む）。
 */
export function toFailed(state: SessionState, at: number, detail: string): SessionState {
  const withLog = appendLog(state, 'error', detail);
  return {
    ...clearTurnState(state),
    status: 'failed',
    finishedAt: at,
    error: detail,
    streamingText: undefined,
    messages: withLog.messages,
    logSeq: withLog.logSeq,
  };
}

/**
 * Transition into the `rate_limited` state: the session stopped because a usage/
 * rate limit was hit. Idle & resumable once the limit resets (like a completed
 * turn, it can receive more input) — but flagged distinctly so the user sees it
 * wasn't a clean finish and can wait for the reset. Records the reason in the log.
 * Shared with `claude-parse.ts` (a limit can surface both as an SDK message and as a
 * thrown error caught by the reducer's `aborted` event).
 */
export function toRateLimited(
  state: SessionState,
  at: number,
  detail: string,
  resetsAt?: number,
): SessionState {
  const withLog = appendLog(state, 'system', detail);
  return {
    ...clearTurnState(state),
    status: 'rate_limited',
    finishedAt: at,
    rateLimitResetsAt: resetsAt,
    streamingText: undefined,
    messages: withLog.messages,
    logSeq: withLog.logSeq,
  };
}

/**
 * ユーザー操作による中断（詳細ビューの `Ctrl+C`）のログ/詳細文。
 *
 * 同じ中断が **2 経路**で届く: (1) `Session.interrupt()` が SDK へ interrupt 制御要求を
 * 出す前に立てる診断（UI を即座に「中断」にするため）、(2) CLI がターンを閉じる
 * `result`（`terminal_reason: 'aborted_streaming'`。`claude-parse.ts`）。両方で**同じ文言**を
 * 使うことで `toInterrupted` の重複畳み込みが効き、ログが二重にならない。
 */
export const USER_INTERRUPT_DETAIL = 'interrupted by user';

/**
 * エージェントのストリームが**終端イベントを出さずに終わった**ときのログ/詳細文
 * （`Session.consume` の最後の砦）。
 *
 * streaming input mode ではプロンプト源を閉じるまでストリームは終わらないのが正常なので、
 * ここに来るのは想定外の終了（CLI サブプロセスが黙って落ちた・transport が EOF になった等）。
 * 状態機械には「ターンが終わった」と伝わらないため、放っておくと**セッションが永久に
 * `running` のまま**になり、動作時間も増え続ける（実際に起きた不具合）。
 * 失敗ではなく resumable な `interrupted` に落として、追加指示 / `Ctrl+R` で続けられるようにする。
 */
export const STREAM_ENDED_DETAIL = 'agent stream ended before the turn finished';

/** エージェント切替（`Session.setAgent`）で進行中のターンを畳んだときのログ/詳細文。 */
export const AGENT_SWITCH_DETAIL = 'turn stopped to switch agents';

/**
 * Transition into the `interrupted` state: the live query dropped mid-flight
 * because the connection was interrupted (not a clean finish, not a real
 * failure). Idle & resumable — sending a follow-up (or the explicit "resume"
 * action) restarts the query with `resume` so Claude continues where it left
 * off. Records the reason in the log. Shared with `claude-parse.ts` (a connection
 * drop can surface both as a thrown error caught by `Session.consume` and as an
 * error `result` on the stream). Transient bookkeeping (`pendingPermission` from
 * a turn that can never resolve now, deferred sub-agent results) is dropped so a
 * resumed turn starts clean.
 */
export function toInterrupted(state: SessionState, at: number, detail: string): SessionState {
  // A mid-response API failure reaches us twice: first as the flagged assistant
  // message the CLI synthesizes for it, then as the `result` that rolls that
  // message up (same text). Treat the second one as a no-op so the log doesn't
  // grow a duplicate line (and `finishedAt` isn't pushed forward). Same reasoning
  // as `toNeedsLogin`, but keyed on the log rather than on `state.error`: an
  // interruption is not a failure, so it deliberately leaves `error` unset.
  //
  // The key is the last *system* entry, not the last entry: other messages can
  // land in between (a synthesized tool_result for the tool_use the dead stream
  // left dangling, a background sub-agent's output). Still gated on the status, so
  // a later turn that gets interrupted with the very same wording is logged again
  // — anything the user sends first leaves `interrupted` for `running`.
  if (state.status === 'interrupted') {
    const lastSystem = state.messages.findLast((m) => m.kind === 'system');
    if (lastSystem?.text === detail) {
      return state;
    }
  }
  const withLog = appendLog(state, 'system', detail);
  return {
    ...clearTurnState(state),
    status: 'interrupted',
    finishedAt: at,
    streamingText: undefined,
    messages: withLog.messages,
    logSeq: withLog.logSeq,
  };
}

/**
 * Transition into the `needs_login` state: the turn stopped because Claude could
 * not authenticate (expired OAuth session / bad credentials — see `isAuthError`).
 * This is neither a completion nor a failure of the work: the user logs in again
 * (`claude` → `/login`) and resumes, so the state is idle & resumable and the UI
 * points at the login step. Records the reason in the log. Shared with
 * `claude-parse.ts` (an auth failure can surface as an SDK `result` / `auth_status`
 * message as well as a thrown error caught by `Session.consume`).
 *
 * Transient bookkeeping (a `pendingPermission` from a turn that can never resolve
 * now, deferred sub-agent results) is dropped so the resumed turn starts clean —
 * same reasoning as `toInterrupted`.
 */
export function toNeedsLogin(state: SessionState, at: number, detail: string): SessionState {
  // The same auth failure reaches us twice: first as the flagged assistant message
  // the CLI synthesizes for it, then as the `result` that rolls that message up
  // (same text). Treat the second one as a no-op so the log doesn't grow a
  // duplicate line — and so subscribers see a stable reference (no repaint).
  if (state.status === 'needs_login' && state.error === detail) {
    return state;
  }
  const withLog = appendLog(state, 'error', detail);
  return {
    ...clearTurnState(state),
    status: 'needs_login',
    finishedAt: at,
    error: detail,
    streamingText: undefined,
    messages: withLog.messages,
    logSeq: withLog.logSeq,
  };
}

/** Pure reducer: the single source of truth for session state transitions. */
export function reduce(state: SessionState, event: CodivaEvent): SessionState {
  switch (event.kind) {
    case 'permission_request': {
      const status = event.request.kind === 'question' ? 'awaiting_input' : 'awaiting_permission';
      // The question text is already parsed onto the request (QuestionSpec[]),
      // so we read it directly rather than re-parsing the raw tool input here —
      // that keeps SDK-shape parsing out of the reducer (see claude-parse.ts).
      const summary =
        event.request.kind === 'question'
          ? `AskUserQuestion: ${event.request.questions?.[0]?.question ?? ''}`
          : `permission: ${event.request.toolName}`;
      const withLog = appendLog(state, 'system', summary);
      return {
        ...state,
        status,
        pendingPermission: event.request,
        messages: withLog.messages,
        logSeq: withLog.logSeq,
      };
    }

    case 'permission_resolved': {
      if (state.pendingPermission === undefined) {
        return state;
      }
      const { pendingPermission, ...rest } = state;
      void pendingPermission;
      // 許可待ちだったあいだにサブエージェント完了ゲートが空になっていたら、
      // 保留されていたターン完了をここで確定する（`settleDeferred` の説明参照）。
      return settleDeferred({ ...rest, status: 'running' }, event.at);
    }

    case 'user_input': {
      const withLog = appendLog(state, 'user', event.text, event.at);
      return {
        ...state,
        // 保留中の決定（質問/許可待ち）があるセッションを running へ降格させない。
        // 追加指示を送っても pendingPermission は解決されないため、ダイアログは
        // 出たまま awaiting_* を維持する（#37 と同じ不変条件: pending がある間は
        // 決して "Running" に戻さない）。解決は permission_resolved のみが行う。
        status: state.pendingPermission ? state.status : 'running',
        finishedAt: undefined,
        streamingText: undefined,
        messages: withLog.messages,
        logSeq: withLog.logSeq,
      };
    }

    case 'model':
      // No-op when unchanged so subscribers don't re-render needlessly.
      return state.model === event.model ? state : { ...state, model: event.model };

    case 'title': {
      const title = makeTitle(event.title);
      // Ignore empty generations; keep the placeholder rather than blank it.
      return title.length === 0 || title === state.title ? state : { ...state, title };
    }

    case 'pr': {
      // The two halves are compared (and kept) separately: `pr` is *which* PR this
      // is — stable and persisted — while the status flips (unknown → mergeable →
      // merged / conflicting, draft → ready, checks pending → passing) on the same
      // PR and must repaint the glyph. Splitting them means the number keeps
      // rendering while the status is still unknown, and that a status-only change
      // doesn't touch `pr` (whose reference gates the debounced persist).
      const sameRef = state.pr?.number === event.pr?.number && state.pr?.url === event.pr?.url;
      const sameStatus =
        state.prStatus?.mergeStatus === event.pr?.mergeStatus &&
        state.prStatus?.isDraft === event.pr?.isDraft &&
        state.prStatus?.checks === event.pr?.checks &&
        // Compared by content, not reference: every poll builds a fresh array, so a
        // reference compare would report "changed" on every tick and defeat the
        // identity preservation the other three fields are here for.
        sameChecks(state.prStatus?.failingChecks, event.pr?.failingChecks);
      // A `pr` event means the lookup answered, so it always clears prLookup —
      // even when nothing changed (a successful retry must drop the "couldn't
      // check" mark).
      if (sameRef && sameStatus && state.prLookup === undefined) {
        return state;
      }
      const ref = event.pr ? { number: event.pr.number, url: event.pr.url } : undefined;
      const status: PrStatus | undefined = event.pr
        ? {
            mergeStatus: event.pr.mergeStatus,
            ...(event.pr.isDraft === undefined ? {} : { isDraft: event.pr.isDraft }),
            ...(event.pr.checks === undefined ? {} : { checks: event.pr.checks }),
            ...(event.pr.failingChecks === undefined
              ? {}
              : { failingChecks: event.pr.failingChecks }),
          }
        : undefined;
      return {
        ...state,
        // Keep each half's object identity when that half didn't change.
        pr: sameRef ? state.pr : ref,
        prStatus: sameStatus ? state.prStatus : status,
        // `extraPrs` は「ブランチの PR *以外*」。セッション自身が `gh pr create` で
        // 作った PR がそのままブランチの PR だった場合（autoPr より先に作られた）は
        // ここで畳む — 一覧の `+n` が同じ PR を二重に数えないようにする。
        extraPrs: withoutPrRef(state.extraPrs, ref),
        prLookup: undefined,
      };
    }

    case 'pr_lookup': {
      if (state.prLookup === event.lookup) {
        return state;
      }
      return { ...state, prLookup: event.lookup };
    }

    case 'conflict': {
      const summary =
        event.files.length > 0 ? `merge conflict in ${event.files.join(', ')}` : 'merge conflict';
      const withLog = appendLog(state, 'error', summary);
      return {
        ...state,
        status: 'conflict',
        conflictFiles: event.files,
        streamingText: undefined,
        messages: withLog.messages,
        logSeq: withLog.logSeq,
      };
    }

    case 'aborted': {
      const error = event.error ?? 'aborted';
      // 分類は**アダプタが済ませて** `cause` で運んでくる（`AgentAdapter.classifyError`）。
      // かつてはここで文言の正規表現を回していたが、それは Claude CLI の言い回しの
      // 知識であって状態機械の仕事ではない — provider が増えると判定が混ざる。
      //
      // 認証切れは「待っても再試行しても直らない」ので、行き止まりの `failed` では
      // なく再ログインを促す `needs_login` へ。レート制限は待てば直るので同様に
      // 区別する。`cause` 省略時（UI 起点の abort など）は素直に失敗扱い。
      if (event.cause === 'auth') {
        return toNeedsLogin(state, event.at, error);
      }
      if (event.cause === 'rate_limit') {
        return toRateLimited(state, event.at, error);
      }
      if (event.cause === 'connection') {
        return toInterrupted(state, event.at, error);
      }
      return toFailed(state, event.at, error);
    }

    case 'interrupted':
      return toInterrupted(state, event.at, event.error ?? 'connection interrupted');

    case 'agent_switched': {
      const current = state.agent ?? 'claude';
      if (current === event.agent) {
        return state;
      }
      // 今の provider の resume id を退避し、切替先の id（過去に使っていれば）を
      // 現在値に据える。worktree（＝成果物）はそのままなので、切替は「別の
      // エージェントに同じ作業場を引き継ぐ」だけ。モデル側の文脈は provider を
      // またげないため、`agentSessions` に無い provider へ切り替えたときは
      // `sdkSessionId` が undefined になり、次のターンは新しい会話として始まる。
      const carried = state.sdkSessionId
        ? { ...state.agentSessions, [current]: state.sdkSessionId }
        : state.agentSessions;
      const next = carried?.[event.agent];
      return {
        // 完了ゲートは「今のターンで走っている Task」の記録なので、別の provider へ
        // 引き継がない（引き継ぐと切替先の `turn_completed` が永久に保留される）。
        ...clearTaskGate(state),
        agent: event.agent,
        agentSessions: carried,
        sdkSessionId: next,
        // 直前のエージェントのストリーミング途中表示は引き継がない。
        streamingText: undefined,
        // 解決済みモデルは provider ごとに別物なので捨てる（次のターンが埋める）。
        model: undefined,
      };
    }

    case 'archived':
      return state.status === 'archived'
        ? state
        : { ...state, status: 'archived', streamingText: undefined };

    default:
      return state;
  }
}
