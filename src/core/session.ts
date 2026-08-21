import { applyAgentEvent } from './agent-events';
import { handoffInstruction, lastUserInstruction } from './agent-handoff';
import type { AgentAdapter, AgentRun, PermissionDecision } from './agent-ports';
import { AsyncQueue } from './async-queue';
import { createClaudeAdapter, type QueryFn } from './claude-adapter';
import type { EffortLevel, PermissionMode } from './config';
import { errorMessage } from './errors';
import type { RateLimitInfoJson } from './rate-limit';
import { isInterruptible } from './status-meta';
import {
  AGENT_SWITCH_DETAIL,
  accrueActive,
  initialState,
  reduce,
  STREAM_ENDED_DETAIL,
  USER_INTERRUPT_DETAIL,
} from './status-reducer';
import { composeSystemPrompt } from './system-prompt';
import type {
  AgentId,
  CodivaEvent,
  CreateSessionInput,
  PermissionRequest,
  PrInfo,
  PrLookupState,
  PrRef,
  SessionState,
} from './types';
import type { IgnoredFilesMode } from './worktree';

/**
 * Decide whether a tool runs automatically or is escalated to the user.
 *
 * `kind` は「ツール実行の許可」か「ユーザーへの質問」か（アダプタが正規化した値）。
 * **ツール名で質問を見分けてはいけない** — `AskUserQuestion` は Claude の名前で、
 * Grok は `_x.ai/ask_user_question` を、他の provider はまた別の名前を使う。
 */
export type PermissionPolicy = (
  toolName: string,
  input: Record<string, unknown>,
  kind?: PermissionRequest['kind'],
) => 'allow' | 'ask';

/**
 * Default policy: run everything automatically so sessions are autonomous.
 * 質問（`kind: 'question'`）は常にユーザーへ上げる — それ*が*「ユーザーに聞く」経路で、
 * 自動 allow すると**空の回答で「承諾した」と返してしまう**（provider には
 * 「ユーザーは答えなかった」と同じに見え、質問が黙って無視される）。
 * (Phase 1 showed even Write reaches canUseTool under acceptEdits, so relying on
 * permissionMode alone would stall autonomy; we auto-allow here instead.)
 */
const defaultPolicy: PermissionPolicy = (toolName, _input, kind) =>
  isQuestion(toolName, kind) ? 'ask' : 'allow';

/**
 * 質問かどうか。`kind` を第一の根拠にし、`kind` を持たない古い呼び出し元のために
 * Claude のツール名も見る（provider 固有の名前をここに増やさない）。
 */
export function isQuestion(toolName: string, kind?: PermissionRequest['kind']): boolean {
  return kind === 'question' || toolName === 'AskUserQuestion';
}

/** Per-session knobs forwarded to the SDK query (sourced from the config file). */
export interface SessionOptions {
  model?: string;
  effort?: EffortLevel;
  permissionMode?: PermissionMode;
  maxBudgetUsd?: number;
  /**
   * リポジトリ単位の追加指示（`.codiva/prompt.md`）。全セッションの systemPrompt に載る。
   * 詳細は `consume()` の注入コメントを参照。
   */
  appendSystemPrompt?: string;
  /**
   * worktree が ignore 済みファイルをどう引き継いだか（合成レイヤが
   * `resolveIgnoredFilesMode(config)` の結果を渡す）。`'symlink'` のときだけ
   * 「実体は元リポジトリと共有なので書き込む前にリンクを切る」注意書きを
   * systemPrompt へ載せる（`core/system-prompt.ts`）。
   */
  ignoredFiles?: IgnoredFilesMode;
}

export interface SessionDeps {
  /**
   * このセッションを駆動するエージェント。省略時は `queryFn` から Claude アダプタを
   * 組み立てる（合成ルートと既存テストのための短縮形）。
   */
  agent?: AgentAdapter;
  /** Claude Agent SDK の `query`。`agent` を渡す場合は不要。 */
  queryFn?: QueryFn;
  input: CreateSessionInput;
  options?: SessionOptions;
  now?: () => number;
  policy?: PermissionPolicy;
  onChange?: (state: SessionState) => void;
  /**
   * Called with the raw `rate_limit_info` whenever the SDK emits a
   * `rate_limit_event`. This is account-wide (claude.ai subscription) usage data,
   * not per-session, so the manager keeps the latest per window type and the
   * banner renders it. Injected so the session stays a pure stream consumer.
   */
  onRateLimit?: (info: RateLimitInfoJson) => void;
  /**
   * Optional title generator. When provided, a fresh session asks it to
   * summarize the initial prompt into a short title (à la Claude Code's tab
   * title) and swaps it in for the input-derived placeholder. I/O is injected
   * so the reducer/session stay pure and testable.
   */
  generateTitle?: (prompt: string) => Promise<string | null | undefined>;
  /** SDK session id to resume (session restoration). Loads prior history. */
  resume?: string;
  /** Pre-built state to start from instead of a fresh `creating` (session restoration). */
  restored?: SessionState;
}

/**
 * One live agent session bound to a worktree. Owns the streaming-input queue,
 * consumes the agent's normalized event stream into the pure fold, and bridges
 * permission requests to the UI (auto-allowing routine tools, blocking on
 * user-facing questions).
 *
 * どのエージェントで走るかは {@link AgentAdapter} が決める。worktree（＝成果物）は
 * provider に依存しないので、`setAgent()` で**途中から別のエージェントへ引き継ぐ**
 * ことができる。
 */
export class Session {
  private state: SessionState;
  /**
   * 現在の run へ指示文を流すキュー。**エージェント切替のたびに作り直す**（`setAgent`）
   * — 走っている run は自分が受け取ったキューを掴んだままなので、閉じることで
   * 「そのストリームだけ」を終わらせられる（セッション全体の abortController を
   * 使うとセッションごと止まってしまう）。
   */
  private inputQueue = new AsyncQueue<string>();
  private readonly abortController = new AbortController();
  private readonly now: () => number;
  private readonly policy: PermissionPolicy;
  private readonly onChange?: (state: SessionState) => void;
  /** 現在のエージェント。`setAgent()` で差し替わる。 */
  private adapter: AgentAdapter;
  /**
   * ログ行に刻む発言者。**切替が起きるまでは undefined** にしておく — 単一
   * エージェントで完結するセッションのログ行の形を変えないため（切替を使って
   * いないユーザーには何も増えない）。
   */
  private attribution?: AgentId;
  /**
   * 切替直後の 1 回だけ渡す引き継ぎ（`core/agent-handoff.ts`）。`AgentRunOptions.handoff`
   * として次の `open()` が消費し、アダプタが最初のユーザープロンプトに前置する。
   * **使い捨て**にするのは、引き継ぎが済んだ以降のターンでも「前任者から引き継いだ」と
   * 言い続けないため。
   */
  private handoff?: string;
  private run?: AgentRun;
  /**
   * 走っている run の**世代**。`setAgent()` で 1 つ上がる。
   *
   * なぜ要るか: `setAgent()` はキューを閉じて `this.run` の参照を捨てるが、consume の
   * `for await` は**そのイテレータを掴んだまま**なので、古い provider が遅れて出す
   * イベントがまだ届く。`applyAgentEvent` に渡す帰属（`this.attribution`）は既に切替先へ
   * 変わっているため、そのまま畳むと
   * - 遅れて届いた `session_started`（Claude の `system/init` は起動に 1〜3 秒かかる）で
   *   **前任者の resume id が切替先の id として保存される** → 次のターンで
   *   `codex exec resume <claude の uuid>` を投げて必ず失敗し、`agentSessions` にも
   *   `state.json` にも焼き付く（往復切替しても直らない）。
   * - 古いターンの `turn_completed` で切替済みのセッションが `completed` になり、
   *   auto-PR と完了通知まで走る。
   * 世代が変わった run のイベントは**畳まずに読み捨てて**ループを閉じる。
   */
  private epoch = 0;
  /**
   * 未応答の許可要求の**待ち行列**（先頭 = いま UI に出ているもの）。
   *
   * 単一スロットにしてはいけない: エージェントは 1 通のメッセージで**複数の tool_use を
   * 並行に**投げられるので、`confirm` モードではその数だけ `canUseTool` が同時に走る。
   * 後から来た要求で上書きすると**先の promise が永久に解決されない** — provider は
   * その 1 本を待ち続け、ターン終了イベントも来ないので、ストリームは生きたまま
   * セッションが永久に `running` / 許可待ちで張り付く（`consume` の最後の砦でも
   * 救えない = ストリームは終わっていないため）。
   */
  private pendingQueue: {
    request: PermissionRequest;
    resolve: (r: PermissionDecision) => void;
  }[] = [];
  private reqSeq = 0;
  /** True once the initial prompt has been enqueued (start / first send); keeps start() idempotent. */
  private startedOnce = false;
  /**
   * True while the SDK consume loop is running. Distinct from `startedOnce`: the
   * loop exits when the stream ends (abort/stop) or throws (connection drop). A
   * connection interruption leaves the session `interrupted` but resumable — the
   * next send() restarts the loop (with `resume`), which this flag gates so we
   * never run two consume loops at once.
   */
  private consuming = false;
  /**
   * エージェント切替でストリームを畳んだので、それが終わり次第もう一度
   * `ensureConsuming()` を回す必要がある、という印。
   *
   * 必要な理由: `setAgent()` は現在の run のキューを閉じるだけで、その run の
   * ループが実際に終わるのは次の tick 以降になる。ユーザーが切替直後に指示を
   * 送ると `ensureConsuming()` は「まだ consuming 中」と見て何もしないので、
   * 新しいエージェントが永久に起動しない（＝切り替えたのに何も起きない）。
   */
  private restartAfterSwitch = false;
  /**
   * Per-session model override set via setModel() (the detail view's /model).
   * `deps.options` is readonly, so we track the chosen model here and prefer it
   * in consume() when the query (re)starts. `overridden` distinguishes "no
   * override" from "override to undefined" (= reset to the CLI default).
   */
  private modelOverride: { overridden: boolean; model: string | undefined } = {
    overridden: false,
    model: undefined,
  };

  constructor(private readonly deps: SessionDeps) {
    this.state = deps.restored ?? initialState(deps.input);
    this.now = deps.now ?? Date.now;
    this.policy = deps.policy ?? defaultPolicy;
    this.onChange = deps.onChange;
    if (deps.agent) {
      this.adapter = deps.agent;
    } else if (deps.queryFn) {
      this.adapter = createClaudeAdapter({
        queryFn: deps.queryFn,
        generateTitle: deps.generateTitle,
      });
    } else {
      throw new Error('Session requires either `agent` or `queryFn`');
    }
    // 「誰が駆動しているか」は状態に載せる（一覧のバッジ・復元・切替の起点）。
    // 復元されたセッションは既に持っているのでそのまま。
    if (this.state.agent === undefined) {
      this.state = { ...this.state, agent: this.adapter.id };
    }
  }

  /** いま UI に出ている（＝先頭の）許可要求。 */
  private get pending():
    | { request: PermissionRequest; resolve: (r: PermissionDecision) => void }
    | undefined {
    return this.pendingQueue[0];
  }

  /**
   * 未応答の許可要求を**すべて** deny で解決して待ち行列を空にする。ターンが終わる／
   * セッションが止まる経路で必ず呼ぶ — 未応答の `tool_use` で終わる transcript は
   * 後の `resume` を壊すし、放置した promise は provider を永久にブロックする。
   */
  private denyAllPending(message: string): void {
    const queued = this.pendingQueue;
    this.pendingQueue = [];
    for (const entry of queued) {
      entry.resolve({ behavior: 'deny', message });
    }
  }

  /** 現在のエージェント（UI が capability を引くための読み取り口）。 */
  getAgent(): AgentAdapter {
    return this.adapter;
  }

  /**
   * 駆動するエージェントを差し替える（Claude で進めた作業を Codex に引き継ぐ等）。
   *
   * 走っているストリームは閉じ、次の `send()` で新しいエージェントが起動する。
   * **モデル側の文脈は provider をまたげない** — 各 CLI が自分のトランスクリプトを
   * 持っているため。切替先で過去にセッションを持っていればその id で resume し、
   * 初めてなら新しい会話として始まる（`agent_switched` の reducer 参照）。
   * 共通しているのは worktree と codiva 側のログで、そこが引き継ぎの土台になる。
   */
  setAgent(adapter: AgentAdapter): void {
    if (adapter.id === this.adapter.id) {
      return;
    }
    // 引き継ぎの状況説明は**切替前**に組み立てる（前任者の名前と、まだ消えていない
    // ログから直前の指示を拾う必要がある）。実際に渡すのは次の `open()` で 1 回だけ。
    this.handoff = handoffInstruction({
      from: this.adapter.displayName,
      branch: this.state.branch,
      task: this.state.prompt,
      lastInstruction: lastUserInstruction(this.state.messages),
      messages: this.state.messages,
    });
    // 走っているターンを畳んでからでないと、2 本のストリームが同じ worktree を
    // 触ることになる。保留中の許可も解決しておく（未応答の tool_use で終わる
    // トランスクリプトは後の resume を壊す）。
    this.denyAllPending('agent switched');
    // 進行中のターンを止める。キューを閉じるだけでは足りない — ターンの最中の run は
    // キューではなく provider の出力を await しているので、そのままだと古い provider が
    // worktree を触り続け、遅れて届く `turn_completed` がセッションを completed に
    // 戻して auto-PR まで走らせてしまう。best-effort（持たない provider もある）。
    void Promise.resolve(this.run?.interrupt?.()).catch(() => undefined);
    // 走っている run のプロンプト源を閉じる。**これが「ストリームを畳む」実体** —
    // `run = undefined` は参照を捨てるだけで、consume ループはそのオブジェクトを
    // 掴んだまま回り続けるし、アダプタ側は共有キューを await して止まっている。
    // 閉じないと、切替後に送った指示を**古いエージェントが受け取る**（切り替えたのに
    // 何も起きないように見える）。
    //
    // 積み残し（ターン実行中に送られてまだ渡っていない指示）は**新しいキューへ移す**。
    // 閉じたキューも buffer を先に吐き出すので、置いていくと古いエージェントが実行して
    // しまうし、捨てるとユーザーの指示が黙って消える（ログには残るのに実行されない）。
    const carried = this.inputQueue.drain();
    this.inputQueue.close();
    this.inputQueue = new AsyncQueue<string>();
    for (const text of carried) {
      this.inputQueue.push(text);
    }
    this.restartAfterSwitch = this.consuming;
    this.run = undefined;
    // 世代を上げる。畳んだ run が遅れて出すイベントは、これで「古い世代のもの」と
    // 分かるので畳まずに読み捨てる（詳細は {@link epoch}）。
    this.epoch += 1;
    // 畳んだのが**進行中のターン**なら、状態も「止まった」ことにする。`agent_switched`
    // は status を動かさないので、これが無いと積み残しが無いときに `running`（や応答
    // できない許可待ち）のまま張り付く — ストリームはもう無いので誰も先へ進めない。
    // 積み残しがあれば直後に新しいエージェントが起動して `running` へ戻る。
    if (isInterruptible(this.state.status)) {
      this.dispatch({ kind: 'interrupted', error: AGENT_SWITCH_DETAIL, at: this.now() });
    }
    this.adapter = adapter;
    // provider ごとにモデル名の名前空間は別なので、切替前の既定/override を渡さない。
    // `/model` で明示的に選び直すまでは切替先 CLI の既定を使う。
    this.modelOverride = { overridden: true, model: undefined };
    // ここから先のログ行には発言者を刻む（どこからが別エージェントか分かるように）。
    this.attribution = adapter.id;
    this.dispatch({ kind: 'agent_switched', agent: adapter.id, at: this.now() });
  }

  getState(): SessionState {
    return this.state;
  }

  /**
   * Begin a fresh session: enqueue the initial prompt and start consuming output.
   * Restored sessions skip this — they stay idle until the first `send()`, which
   * lazily starts the (resumed) query so we don't spawn a subprocess per restored
   * session at launch.
   */
  start(): void {
    if (this.startedOnce) {
      return;
    }
    this.startedOnce = true;
    // 最初の指示もフォローアップ (send) と同じくログへ積む。dispatch しないと詳細画面で
    // AI の応答が先頭になり「自分が何を指示したか」が見えない。復元経路は transcript から
    // 既に user ログを持ち start() を通らないため、二重記録にはならない。
    this.dispatch({ kind: 'user_input', text: this.state.prompt, at: this.state.startedAt });
    this.inputQueue.push(this.state.prompt);
    this.ensureConsuming();
    void this.runTitleGen();
  }

  /**
   * Fire-and-forget: derive a concise title from the prompt content and dispatch
   * it. Only fresh starts call this, so restored sessions keep their saved title.
   * Failures are swallowed — the placeholder title stands.
   */
  private async runTitleGen(): Promise<void> {
    if (!this.deps.generateTitle) {
      return;
    }
    try {
      const title = await this.deps.generateTitle(this.state.prompt);
      if (title && !this.abortController.signal.aborted) {
        this.dispatch({ kind: 'title', title, at: this.now() });
      }
    } catch {
      // best-effort — keep the input-derived placeholder title
    }
  }

  /**
   * Send an additional instruction into the session. Works whether the session
   * has never started (restored → lazy resume), is idle after a completed turn,
   * or was `interrupted` by a dropped connection — in the last case ensureConsuming
   * restarts the (ended) consume loop with `resume`, so the follow-up continues the
   * same SDK conversation. This is what powers the one-key "resume" action.
   */
  send(text: string): void {
    this.startedOnce = true;
    this.inputQueue.push(text);
    this.ensureConsuming();
    this.dispatch({ kind: 'user_input', text, at: this.now() });
  }

  /**
   * Start the SDK query + consume loop if one isn't already running. Safe to call
   * again after a connection interruption ended the previous loop (it restarts,
   * resuming the SDK session). A permanently stopped session (abort/stop aborts
   * the controller) is never restarted.
   */
  private ensureConsuming(): void {
    if (this.consuming || this.abortController.signal.aborted) {
      return;
    }
    this.consuming = true;
    void this.consume();
  }

  /** Answer a pending AskUserQuestion. `answers` maps question text → chosen label. */
  answerPending(answers: Record<string, string>): void {
    this.resolvePending({
      behavior: 'allow',
      input: { ...(this.pending?.request.input ?? {}), answers },
    });
  }

  /** Allow a pending tool permission request. */
  allowPending(): void {
    this.resolvePending({ behavior: 'allow', input: this.pending?.request.input ?? {} });
  }

  /** Deny a pending tool permission request with a reason shown to Claude. */
  denyPending(message: string): void {
    this.resolvePending({ behavior: 'deny', message });
  }

  /**
   * 進行中のターンを中断する（詳細ビューの `Ctrl+C`）。セッション自体は生かしたまま
   * `interrupted`（idle & resumable）へ落とし、追加指示 / `Ctrl+R` で同じ SDK 会話を
   * 続けられる状態にする。`stop()`（プロセスだけ落とす）や `abort()`（`failed` にする）
   * とは別物。
   *
   * 状態は SDK の応答を待たずに**先に**確定させる。理由は2つ:
   * - 体感: interrupt は control request なので CLI の応答まで数百 ms かかる。押した瞬間に
   *   「中断」になってほしい。
   * - 分類: CLI が返すターン終了 result は `is_error: true` なので、診断が無いと
   *   `failed` に落ちる。先に `interrupted` を立てておけば sdk-parse のロールアップ
   *   ガード（`isResumable`）がコストだけ拾って状態を維持する（`aborted_streaming` の
   *   判定も同じ文言なので二重ログにならない）。
   *
   * 許可/質問待ちで押された場合、`commit()` が「pending が消えた」ことを検知して
   * canUseTool の promise を deny で解決する（未応答の tool_use で終わる transcript は
   * 後の resume を壊すため）。
   */
  async interrupt(): Promise<void> {
    if (!isInterruptible(this.state.status)) {
      return;
    }
    this.dispatch({ kind: 'interrupted', error: USER_INTERRUPT_DETAIL, at: this.now() });
    // **まだ始まっていないターンは投げない**（Grok アダプタが立ち上げ中の中断で
    // 指示ごと捨てるのと同じ理由）。エージェント切替の直後は、畳んだループが終わるまで
    // 新しい run が立たない予約状態（`restartAfterSwitch`）で、ここに `this.run` は無い。
    // 予約を消さないと、`Ctrl+C` で `interrupted` にした直後に古いループの `finally` が
    // 新しいエージェントを起こしてしまい、**切替後の最初の指示だけ中断できない**。
    if (!this.run) {
      this.restartAfterSwitch = false;
      this.inputQueue.drain();
      return;
    }
    try {
      await this.run.interrupt?.();
    } catch {
      // best-effort: サブプロセスがもう居ない transport への write は reject する
      // （setModel と同じ）。中断できなかった場合もストリームは生きているので、
      // 次のメッセージが状態を `running` へ戻す（= 表示が実態に追いつく）。
    }
  }

  /**
   * Switch the model for THIS session only (the detail view's /model). Applies to
   * the live query immediately via the SDK's setModel (streaming-input only) and
   * to any later (re)start of the query. `model` undefined resets to the CLI
   * default. state.model updates optimistically now; the SDK-reported resolved
   * model on the next assistant turn confirms it (and the list row repaints).
   */
  setModel(model: string | undefined): void {
    this.modelOverride = { overridden: true, model };
    // setModel は SDK の control request で、サブプロセスがもう居ない transport への
    // write は reject する（EPIPE / stream destroyed）。`handle` はターンが終わっても
    // 残るので、終了済みセッションの詳細で /model を押すと裸の void が unhandled
    // rejection になりアプリごと落ちていた。切替えは best-effort（下の dispatch で
    // 次回起動時のモデルは確定する）なので握り潰す。
    void Promise.resolve(this.run?.setModel?.(model)).catch(() => undefined);
    this.dispatch({ kind: 'model', model, at: this.now() });
  }

  /** Permanently stop the session. The worktree and branch are left intact. */
  abort(): void {
    this.inputQueue.close();
    this.abortController.abort();
    if (this.state.status !== 'completed' && this.state.status !== 'failed') {
      this.dispatch({ kind: 'aborted', at: this.now() });
    }
  }

  /**
   * Quietly shut down the subprocess without changing state — used on app quit so
   * an in-flight session persists as resumable (rather than being marked failed by
   * abort()). Its SDK session lives on and can be resumed on next launch.
   *
   * If a permission prompt is still pending, deny it first so the transcript ends
   * on a resolved tool_use (deny → tool_result) rather than a dangling tool_use,
   * which can make a later `resume` error out. We resolve the promise directly
   * (no dispatch) to keep stop() quiet — status must not change.
   */
  stop(): void {
    this.denyAllPending('session stopped');
    this.inputQueue.close();
    this.abortController.abort();
  }

  /** Mark the session archived (after its branch is merged or discarded). */
  archive(): void {
    this.dispatch({ kind: 'archived', at: this.now() });
  }

  /**
   * Record (or clear) the pull request detected for this branch. Driven by the
   * manager's out-of-band `gh` poll; a no-op event doesn't change state.
   */
  setPr(pr: PrInfo | undefined): void {
    this.dispatch({ kind: 'pr', pr, at: this.now() });
  }

  /**
   * Forget a PR `gh` answered about by URL with "there is no such PR". Only for that
   * authoritative answer — a lookup that couldn't tell us keeps the reference.
   * Without this the number would stay on the row forever with no state: the poll
   * clears `pr`, but a reference detected from the session's own `gh pr create`
   * lives in `extraPrs`, which nothing else removes.
   */
  dropPr(pr: PrRef): void {
    this.dispatch({ kind: 'pr_gone', pr, at: this.now() });
  }

  /**
   * Record that the PR lookup is in flight (`loading`) or failed (`error`) without
   * an answer about the PR itself, so the list can show "looking…" / "couldn't
   * check" instead of an empty cell. Cleared by the next successful setPr().
   */
  setPrLookup(lookup: PrLookupState | undefined): void {
    this.dispatch({ kind: 'pr_lookup', lookup, at: this.now() });
  }

  /**
   * Flag the session as blocked on a merge conflict (its branch couldn't merge
   * into base). Driven by the manager's merge action; we surface the conflicted
   * files but never auto-resolve.
   */
  markConflict(files: string[]): void {
    this.dispatch({ kind: 'conflict', files, at: this.now() });
  }

  private resolvePending(result: PermissionDecision): void {
    const pending = this.pendingQueue.shift();
    if (!pending) {
      return;
    }
    pending.resolve(result);
    // 並行して届いた次の要求があるなら、続けてそれを UI へ上げる（`permission_resolved`
    // で一旦 running に戻してから出し直すと、その一瞬だけ状態が嘘になる）。
    const next = this.pending;
    if (next) {
      this.dispatch({ kind: 'permission_request', request: next.request, at: this.now() });
      return;
    }
    this.dispatch({ kind: 'permission_resolved', at: this.now() });
  }

  /**
   * アダプタから上がってきた許可要求。ルーチンツールはポリシーで即 allow し、
   * ユーザーに聞くべきものだけ UI へ上げる（解決するまでエージェントはブロック
   * してよい）。「何が質問か」といったツール名の意味づけはアダプタ側で済んでいる
   * ので、ここは codiva 自身のポリシー（`core/run-mode.ts`）だけを見る。
   */
  private requestPermission = (req: Omit<PermissionRequest, 'id'>): Promise<PermissionDecision> => {
    if (this.policy(req.toolName, req.input, req.kind) === 'allow') {
      return Promise.resolve({ behavior: 'allow', input: req.input });
    }
    this.reqSeq += 1;
    const request: PermissionRequest = { ...req, id: `${this.state.id}:${this.reqSeq}` };
    return new Promise<PermissionDecision>((resolve) => {
      // 先に出ている要求があるなら**待たせる**（上書きすると先の promise が
      // 迷子になり、provider がそれを永久に待ち続ける）。UI へ上げるのは自分が
      // 先頭になったときで、回答のたびに `resolvePending` が次を出す。
      const idle = this.pendingQueue.length === 0;
      this.pendingQueue.push({ request, resolve });
      if (idle) {
        this.dispatch({ kind: 'permission_request', request, at: this.now() });
      }
    });
  };

  private async consume(): Promise<void> {
    // この run の世代。`setAgent()` が上げたら、ここから先のイベントは
    // 「切替前の provider の残響」なので畳まない（詳細は {@link epoch}）。
    const epoch = this.epoch;
    try {
      const opts = this.deps.options;
      // A per-session /model override wins over the configured default.
      const model = this.modelOverride.overridden ? this.modelOverride.model : opts?.model;
      // Codex の JSONL は Claude の system/init と違って解決済みモデルを通知しない。
      // 明示指定がある場合は実際に adapter へ渡す値を先に表示し、provider が後から
      // 解決済みモデルを報告する場合は通常の AgentEvent が上書きする。
      if (model !== undefined && this.state.model !== model) {
        this.dispatch({ kind: 'model', model, at: this.now() });
      }
      // Resume the prior SDK conversation when we have one: `deps.resume` for a
      // restored session, or the live `sdkSessionId` when restarting after a
      // connection interruption. Absent on a fresh session's first start.
      // 切替後は「その provider が過去に発行した id」（`agent_switched` が据えた
      // `sdkSessionId`）だけを使う。`deps.resume` は復元時の初期エージェント用なので、
      // 別の provider へ持ち込むと存在しない会話を resume しようとして壊れる。
      const resume = this.attribution
        ? this.state.sdkSessionId
        : (this.deps.resume ?? this.state.sdkSessionId);
      // 引き継ぎは切替後の最初のユーザープロンプトにだけ添える（前置はアダプタの仕事 =
      // `attachHandoff`）。systemPrompt に載せないのは、resume 済みの Codex thread など
      // provider によっては再開時に systemPrompt を読み直さないため。
      //
      // 画面のログには元の入力だけを積むので、この内部添付が二重表示されることはない。
      // CLI のトランスクリプトには**ユーザー発言として**残るが、復元は
      // `stripHandoff` を通るので詳細ビューにも `lastUserInstruction` にも漏れない。
      //
      // **ここで捨てない**。1 回きりの引き継ぎなので、`open()` の時点で落とすと
      // provider へ渡る前に run が死んだ経路（CLI 未導入・未ログイン・起動直後の
      // `Ctrl+C`）で黙って消える（ログインし直して送り直しても、もう引き継がれない）。
      // 落とすのは**アダプタが「確かに渡した」と言ったとき**だけ（`onHandoffDelivered`）。
      const handoff = this.handoff;
      const systemPrompt = composeSystemPrompt({
        ignoredFiles: opts?.ignoredFiles,
        repoPrompt: opts?.appendSystemPrompt,
      });
      const run = this.adapter.open({
        cwd: this.state.worktreePath,
        prompt: this.inputQueue,
        resume,
        options: {
          model,
          effort: opts?.effort,
          permissionMode: opts?.permissionMode,
          maxBudgetUsd: opts?.maxBudgetUsd,
          systemPrompt,
          handoff,
        },
        // 引き継ぎが provider へ渡ったという報告。**世代が変わっていたら無視する** —
        // 切替後の `this.handoff` は次のエージェント向けの別物なので、畳んだ run の
        // 遅れた報告でそれを消してはいけない。
        onHandoffDelivered: () => {
          if (epoch === this.epoch) {
            this.handoff = undefined;
          }
        },
        requestPermission: this.requestPermission,
        abortController: this.abortController,
      });
      this.run = run;
      for await (const event of run) {
        // 切替で畳んだ run の残響。**畳まずに抜ける**（`break` で run.return() が走り、
        // 古いストリームも閉じる）。
        if (epoch !== this.epoch) {
          break;
        }
        // Account-wide subscription usage is surfaced out-of-band (it isn't
        // per-session state) so the manager can aggregate it for the banner.
        if (event.kind === 'usage') {
          this.deps.onRateLimit?.(event.info);
        }
        // 正規化済みイベントの畳み込みは全 provider 共通（core/agent-events.ts）。
        this.commit(applyAgentEvent(this.state, event, this.now(), this.attribution));
      }
    } catch (err) {
      // 世代が変わっていれば、投げたのは切替前の provider（もう関係ない）。
      // その失敗を今のエージェントの失敗として記録すると、切替直後のセッションが
      // 身に覚えのないエラーで `failed` になる。
      if (!this.abortController.signal.aborted && epoch === this.epoch) {
        const error = errorMessage(err);
        // 文言から分類するのはアダプタの仕事（provider ごとに言い回しが違う）。
        // 認証切れが最優先なのは、CLI の認証エラーがタイムアウトに*言及する*ことが
        // あり（"Failed to authenticate through the broker: request timed out"）、
        // 通信断と読み違えると「ログインし直せ」と言うべき場面で素の再開を勧めて
        // しまうため。
        const cause = this.adapter.classifyError?.(error) ?? 'failed';
        const auth = cause === 'auth';
        // 通信断も失敗ではない: `interrupted`（idle & resumable）にして、追加指示 /
        // 再開アクションで同じ会話を続けられるようにする。ただし resume 先の id が
        // 無ければ続けようがないので、そのときは本物の初期失敗として扱う。
        const dropped = cause === 'connection' && this.state.sdkSessionId !== undefined;
        // Both leave a *resumable* session, so a pending permission from the dead
        // turn (which can never resolve now) must be denied rather than left
        // dangling: a transcript ending on an unanswered tool_use can make the
        // later `resume` error out (same reasoning as `stop()`).
        if (auth || dropped) {
          this.denyAllPending(auth ? 'authentication expired' : 'connection interrupted');
        }
        this.dispatch(
          dropped
            ? { kind: 'interrupted', error, at: this.now() }
            : {
                kind: 'aborted',
                error,
                // resume 先が無い通信断は「続きから」ができないので、resumable な
                // 分類を渡さず素直に失敗にする（旧実装と同じ着地）。
                cause: cause === 'connection' ? 'failed' : cause,
                at: this.now(),
              },
        );
      }
    } finally {
      // The loop has exited (stream end, abort, or throw). Release the guard so a
      // later send() can restart it — an interrupted session resumes this way.
      this.consuming = false;
      // 切替のために畳んだループだった場合、その間に送られた指示がキューへ積まれた
      // ままになっている（`ensureConsuming` は consuming 中だったので何もしていない）。
      // ここで新しいエージェントを起こして拾い直す。
      const switched = this.restartAfterSwitch;
      this.restartAfterSwitch = false;
      const stale = epoch !== this.epoch;
      if (switched && this.inputQueue.pending > 0) {
        this.ensureConsuming();
      } else if (
        !stale &&
        !this.abortController.signal.aborted &&
        isInterruptible(this.state.status)
      ) {
        // **最後の砦**: ストリームが終端イベント（`turn_completed` / `turn_stopped`）を
        // 出さずに終わった。streaming input mode ではプロンプト源を閉じるまで終わらない
        // のが正常なので、ここに来るのは想定外の終了（CLI が黙って落ちた等）。状態機械
        // には何も届いていないため、放っておくと**セッションが永久に `running`**（または
        // 応答できない許可待ち）のまま張り付き、動作時間だけが増え続ける。
        // 失敗ではなく resumable な `interrupted` に落として、追加指示 / `Ctrl+R` で
        // 続けられるようにする（`stop()` / `abort()` は controller を abort するので
        // ここには来ない = quiet 停止の意味は保たれる）。
        this.dispatch({ kind: 'interrupted', error: STREAM_ENDED_DETAIL, at: this.now() });
      }
    }
  }

  private dispatch(event: CodivaEvent): void {
    this.commit(reduce(this.state, event));
  }

  /** Adopt a newly computed state and notify subscribers (skips no-op transitions). */
  private commit(next: SessionState): void {
    if (next === this.state) {
      return;
    }
    // A transition that clears a pending decision without going through
    // resolvePending came from the SDK stream — the turn ended (interrupted / auth
    // stop) while a permission prompt was still open, so canUseTool's promise can
    // never be answered. Deny it, for the same reason `stop()` and the consume
    // catch do: a transcript ending on a dangling tool_use can make a later
    // `resume` error out. (resolvePending clears `pending` before it dispatches, so
    // ordinary allow/deny answers never reach this.)
    if (this.pending && next.pendingPermission === undefined) {
      this.denyAllPending('turn ended before this was answered');
    }
    // Fold the transition into the active-time accumulator centrally, so every
    // status change (reducer- or SDK-driven) counts only the time actually spent
    // working (see accrueActive). Uses the injected clock for determinism.
    const adjusted = accrueActive(this.state, next, this.now());
    this.state = adjusted;
    this.onChange?.(adjusted);
  }
}
