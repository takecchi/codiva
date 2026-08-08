import { type AccountSummary, sameAccountSummary } from './account';
import type { AgentAdapter } from './agent-ports';
import type { QueryFn } from './claude-adapter';
import { errorMessage } from './errors';
import type { Messages } from './i18n';
import { assemblePersistedState, type PersistedState, restoredSessionState } from './persistence';
import { PrCoordinator } from './pr-coordinator';
import {
  ciFixInstruction,
  type RecoveryKind,
  type RecoveryOutcome,
  recoverableSessions,
  recoveryKindFor,
  syncInstruction,
} from './pr-recovery';
import {
  mergeEventWindow,
  type RateLimitInfoJson,
  type RateLimitType,
  type RateLimitWindow,
  sortRateLimitWindows,
  toRateLimitWindow,
} from './rate-limit';
import { createModePolicy, type RunMode } from './run-mode';
import { type PermissionPolicy, Session, type SessionOptions } from './session';
import { discardSession, mergeSession, sessionDiffStat } from './session-actions';
import type {
  ActionResult,
  PrAutomation,
  PrBatchLookup,
  PrLookup,
  SessionHandle,
  WorktreeMeta,
  WorktreeService,
} from './session-ports';
import { SessionStore } from './session-store';
import { makeSlug, makeTitle, uniqueSlug } from './slug';
import { isInterruptible, isResumable, isTerminalStatus } from './status-meta';
import { accrueActive, initialState, reduce } from './status-reducer';
import type { CreateSessionInput, LogEntry, SessionState } from './types';
import { mergeUsageWindow, type UsageSnapshot } from './usage';
import type { DiffStat, SyncBaseResult, Worktree } from './worktree';

export interface SessionManagerDeps {
  worktrees: WorktreeService;
  /**
   * 新規セッションを駆動するエージェント。省略時は `queryFn` から Claude アダプタを
   * 組み立てる。ここを差し替えるだけで provider が変わる（`core/agent-ports.ts`）。
   */
  agent?: AgentAdapter;
  /** Claude Agent SDK の `query`。`agent` を渡す場合は不要。 */
  queryFn?: QueryFn;
  /** Optional Claude-backed title generator; forwarded to each fresh session. */
  generateTitle?: (prompt: string) => Promise<string | null | undefined>;
  now?: () => number;
  options?: SessionOptions;
  policy?: PermissionPolicy;
  /** Called on every session status transition (prev → next). Wired to desktop notifications. */
  onTransition?: (prev: SessionState, next: SessionState) => void;
  /** Called (as a dirty signal) whenever the persistable set changes; wired to a debounced save. */
  onPersist?: () => void;
  /** Called when the default model for new sessions changes (via /model); wired to persist the config file. */
  onModelChange?: (model: string | undefined) => void;
  /** Called when the repo instructions change (via /prompt); wired to persist `.codiva/prompt.md`. */
  onRepoPromptChange?: (prompt: string | undefined) => void;
  /** Optional PR lookup (via `gh`); when set, refreshPrs() polls each stale session's branch. */
  lookupPr?: PrLookup;
  /**
   * Optional batched PR lookup (one `gh pr list` for many sessions). Keeps the API
   * cost from scaling with the number of open sessions; falls back to `lookupPr`.
   */
  lookupPrs?: PrBatchLookup;
  /**
   * When true, sessions are created from the latest `origin/<base>` (fetched
   * first) instead of the local HEAD. Falls back to local HEAD when there is no
   * usable upstream. Default off unless wired (main.tsx defaults it on).
   */
  followOrigin?: boolean;
  /**
   * When true (and `prAutomation` is wired), a session that completes with
   * committed changes is pushed and gets a draft PR; refreshPrs() then readies it
   * once checks pass. Default off unless wired.
   */
  autoPr?: boolean;
  /**
   * When true, a PR the poll reports as `conflicting` gets the base branch merged
   * in automatically (pushed when clean, handed to the session when it conflicts).
   * Default off — the conflicting case spends a turn. See `core/pr-recovery.ts`.
   */
  autoSync?: boolean;
  /**
   * When true, a PR whose checks go red automatically asks its session to fix them.
   * Default off (it spends a turn), and bounded per session by
   * `MAX_AUTO_RECOVERY_ATTEMPTS` so a session that never pushes can't loop forever.
   */
  autoFixCi?: boolean;
  /**
   * Message catalog, used for the text of instructions sent to a session on the
   * user's behalf (PR recovery). Without it `recover()` is a no-op — the manager
   * must not invent English prompts of its own (regulation: i18n.md).
   */
  messages?: Messages;
  /** PR automation seam (create/checks/ready via `gh`); required for autoPr. */
  prAutomation?: PrAutomation;
  /** Factory for a session; defaults to constructing a real Session. `resume`/`restored` are set when rehydrating. */
  createSession?: (args: {
    input: CreateSessionInput;
    onChange: (state: SessionState) => void;
    onRateLimit: (info: RateLimitInfoJson) => void;
    resume?: string;
    restored?: SessionState;
  }) => SessionHandle;
}

/** Outcome of `/clear`: how many rows went away, plus the first failure (if any). */
export interface ClearOutcome {
  /** Sessions actually dropped from the list. */
  cleared: number;
  /** First worktree removal failure; the rows that failed are still in the list. */
  error?: string;
}

/** Fields that end up in the persisted snapshot (see persistence.toPersistedSession). */
function persistRelevantChanged(prev: SessionState, next: SessionState): boolean {
  return (
    prev.status !== next.status ||
    prev.sdkSessionId !== next.sdkSessionId ||
    // エージェントの切替は state.json に残す必要がある（戻ったときに前の会話を
    // resume できるのは、この対応表が生き残っていればこそ）。
    prev.agent !== next.agent ||
    prev.agentSessions !== next.agentSessions ||
    prev.title !== next.title ||
    prev.finishedAt !== next.finishedAt ||
    prev.totalCostUsd !== next.totalCostUsd ||
    prev.model !== next.model ||
    // Reference compare: the reducer keeps `pr` identical while only the (unpersisted)
    // status half changes, so a poll that just moves the checks glyph doesn't
    // re-write state.json — only actually discovering/losing a PR does.
    prev.pr !== next.pr ||
    // Same reference-compare contract (addPrRefs keeps the array identical unless a
    // genuinely new PR shows up).
    prev.extraPrs !== next.extraPrs ||
    prev.todos !== next.todos
  );
}

/**
 * Coordinates the session lifecycle: create/provision/restore/dispose and the UI
 * passthroughs. The subscribable snapshot lives in {@link SessionStore}, tool-mode
 * policy in run-mode, merge/discard in session-actions, and PR automation in
 * {@link PrCoordinator}; this class wires them together and owns the per-session
 * worktree metadata + slug reservations. create() returns synchronously with a
 * 'creating' entry; worktree setup and session start happen in the background so
 * the input is never blocked.
 */
export class SessionManager {
  private readonly store = new SessionStore();
  private readonly sessions = new Map<string, SessionHandle>();
  private readonly worktreeMeta = new Map<string, WorktreeMeta>();
  private readonly usedSlugs = new Set<string>();
  private readonly prs: PrCoordinator;
  /**
   * Latest account-wide subscription usage per window type (claude.ai limits).
   * Every live session reports the same limits, so we keep the newest per type
   * and expose a sorted snapshot for the banner. Transient — never persisted.
   */
  private readonly rateLimits = new Map<RateLimitType, RateLimitWindow>();
  private rateLimitSnapshot: RateLimitWindow[] = [];
  /**
   * The authenticated account (plan name / organization) from the SDK probe.
   * Account-wide and transient, like the usage windows — never persisted.
   */
  private account: AccountSummary | undefined;
  private seq = 0;
  private mode: RunMode = 'auto';
  private readonly now: () => number;
  /**
   * Live per-session knobs forwarded to each new Session. Seeded from
   * deps.options (the config file) but mutable so /model can change the default
   * model for sessions created later in this run.
   */
  private options: SessionOptions;
  /** Default policy when a session doesn't get an explicit one; reads `this.mode` live. */
  private readonly modePolicy: PermissionPolicy = createModePolicy(() => this.mode);

  constructor(private readonly deps: SessionManagerDeps) {
    this.now = deps.now ?? Date.now;
    this.options = { ...deps.options };
    this.prs = new PrCoordinator({
      worktrees: deps.worktrees,
      autoPr: deps.autoPr,
      prAutomation: deps.prAutomation,
      lookupPr: deps.lookupPr,
      lookupPrs: deps.lookupPrs,
      autoSync: deps.autoSync,
      autoFixCi: deps.autoFixCi,
      // Bound lazily (the arrow captures `this`, which is fully built by the time a
      // poll can fire) so the coordinator can trigger recovery without knowing how
      // it works — it only decides *when*.
      recover: (id, kind) => this.recover(id, kind),
      getMeta: (id) => this.worktreeMeta.get(id),
      getState: (id) => this.store.get(id),
      getSession: (id) => this.sessions.get(id),
      ids: () => this.store.ids(),
      now: () => this.now(),
    });
  }

  subscribe(listener: () => void): () => void {
    return this.store.subscribe(listener);
  }

  /** The model used for new sessions (undefined → CLI default). */
  getModel(): string | undefined {
    return this.options.model;
  }

  /**
   * Set the default model for sessions created from now on (via /model). Already
   * running sessions keep the model they started with. Persists via onModelChange.
   */
  setModel(model: string | undefined): void {
    if (this.options.model === model) {
      return;
    }
    this.options = { ...this.options, model };
    this.deps.onModelChange?.(model);
  }

  /** The repo-wide instructions appended to new sessions' systemPrompt (undefined → none). */
  getRepoPrompt(): string | undefined {
    return this.options.appendSystemPrompt;
  }

  /**
   * Set the repo-wide instructions (via /prompt) applied to sessions created from
   * now on. Already running sessions keep the prompt they started with (systemPrompt
   * is fixed at query start). Empty/undefined clears it. Persists via onRepoPromptChange.
   */
  setRepoPrompt(prompt: string | undefined): void {
    const next = prompt && prompt.length > 0 ? prompt : undefined;
    if (this.options.appendSystemPrompt === next) {
      return;
    }
    this.options = { ...this.options, appendSystemPrompt: next };
    this.deps.onRepoPromptChange?.(next);
  }

  /** Current tool-approval mode (drives the shift+tab footer indicator). */
  getMode(): RunMode {
    return this.mode;
  }

  /** Flip auto ⇄ confirm and notify subscribers so the footer re-renders. */
  cycleMode(): RunMode {
    this.mode = this.mode === 'auto' ? 'confirm' : 'auto';
    this.store.notify();
    return this.mode;
  }

  getSnapshot(): SessionState[] {
    return this.store.getSnapshot();
  }

  /**
   * Account-wide claude.ai subscription usage windows (5-hour + weekly), newest
   * per type, in display order. Empty until the SDK reports a limit (Console/API
   * keys never do). The reference is stable across no-op events so the banner
   * subscription doesn't churn.
   */
  getRateLimits(): RateLimitWindow[] {
    return this.rateLimitSnapshot;
  }

  /**
   * The authenticated account (plan name / organization), or undefined until the
   * SDK probe answers — and for logins that report nothing (API keys, 3P providers).
   */
  getAccount(): AccountSummary | undefined {
    return this.account;
  }

  /**
   * Fold a polled `/usage` snapshot (see `utils/usage-probe`) into the account-wide
   * state: the plan name, plus any utilization windows the endpoint reported.
   *
   * Complements `rate_limit_event`, which only arrives while a session runs a turn:
   * polling keeps the status line current when everything is idle. Merged per
   * window (the endpoint has no `status`, events sometimes have no `utilization`)
   * and notifies at most once, only when something displayable actually moved.
   */
  applyUsage(snapshot: { account?: AccountSummary; usage?: UsageSnapshot }): void {
    let changed = false;
    const account = snapshot.account;
    if (account && !sameAccountSummary(this.account, account)) {
      this.account = account;
      changed = true;
    }
    for (const window of snapshot.usage?.windows ?? []) {
      const prev = this.rateLimits.get(window.type);
      const merged = mergeUsageWindow(prev, window);
      if (merged !== prev) {
        this.rateLimits.set(window.type, merged);
        changed = true;
      }
    }
    if (!changed) {
      return;
    }
    this.rateLimitSnapshot = sortRateLimitWindows([...this.rateLimits.values()]);
    this.store.notify();
  }

  /** Fold a session's `rate_limit_event` into the account-wide snapshot. */
  private onRateLimit(info: RateLimitInfoJson): void {
    const window = toRateLimitWindow(info);
    if (!window) {
      return;
    }
    const prev = this.rateLimits.get(window.type);
    // Merge rather than replace: the event is authoritative on status/resetsAt but
    // may omit `utilization`, which would otherwise wipe the polled percentage at
    // the start of every turn (mergeEventWindow keeps it while the window instance
    // is unchanged, and returns `prev` itself when nothing displayable moved).
    const merged = mergeEventWindow(prev, window);
    if (merged === prev) {
      return; // unchanged — don't rebuild the snapshot or re-render
    }
    this.rateLimits.set(window.type, merged);
    this.rateLimitSnapshot = sortRateLimitWindows([...this.rateLimits.values()]);
    this.store.notify();
  }

  get(id: string): SessionState | undefined {
    return this.store.get(id);
  }

  /** Queue a new session for `prompt`; returns its id immediately. */
  create(prompt: string): string {
    this.seq += 1;
    const id = String(this.seq);
    const title = makeTitle(prompt);
    const startedAt = this.now();
    const placeholder = initialState({
      id,
      title,
      prompt,
      branch: `codiva/${makeSlug(prompt)}`,
      worktreePath: '',
      startedAt,
    });
    this.store.append(id, placeholder);
    this.deps.onPersist?.();
    void this.provision(id, prompt, title, startedAt);
    return id;
  }

  /** Construct a Session (or the injected fake) bound to this manager's callbacks. */
  private buildSession(
    input: CreateSessionInput,
    extra?: { resume?: string; restored?: SessionState },
  ): SessionHandle {
    const onChange = (s: SessionState) => this.onSessionChange(input.id, s);
    const onRateLimit = (info: RateLimitInfoJson) => this.onRateLimit(info);
    if (this.deps.createSession) {
      return this.deps.createSession({ input, onChange, onRateLimit, ...extra });
    }
    return new Session({
      agent: this.deps.agent,
      queryFn: this.deps.queryFn,
      input,
      options: this.options,
      now: this.now,
      policy: this.deps.policy ?? this.modePolicy,
      onChange,
      onRateLimit,
      generateTitle: extra ? undefined : this.deps.generateTitle,
      resume: extra?.resume,
      restored: extra?.restored,
    });
  }

  private async provision(
    id: string,
    prompt: string,
    title: string,
    startedAt: number,
  ): Promise<void> {
    try {
      const taken = new Set<string>([
        ...(await this.deps.worktrees.takenSlugs()),
        ...this.usedSlugs,
      ]);
      const slug = uniqueSlug(makeSlug(prompt), taken);
      this.usedSlugs.add(slug);
      const base = await this.deps.worktrees.baseBranch();
      // Origin-follow: branch from the latest origin/<base> when enabled and
      // available; syncedStartPoint returns undefined (→ local HEAD) otherwise.
      const startPoint = this.deps.followOrigin
        ? await this.deps.worktrees.syncedStartPoint(base).catch(() => undefined)
        : undefined;
      const wt = await this.deps.worktrees.add(slug, startPoint);
      this.worktreeMeta.set(id, { worktree: wt, base });
      const input: CreateSessionInput = {
        id,
        title,
        prompt,
        branch: wt.branch,
        worktreePath: wt.path,
        startedAt,
      };
      const session = this.buildSession(input);
      this.sessions.set(id, session);
      this.store.set(id, session.getState());
      this.deps.onPersist?.();
      session.start();
    } catch (err) {
      // Provisioning failed before a Session exists — run it through the reducer
      // (rather than hand-writing state) so failure classification and the error
      // log line stay consistent with every other transition.
      const current = this.store.get(id);
      if (current) {
        const at = this.now();
        // This is the one state transition that doesn't flow through Session.commit
        // (it happens before a Session exists), so fold the active-time accumulator
        // here too — otherwise the failed row's clock would never stop (activeSince
        // stays open on a terminal state).
        const next = reduce(current, { kind: 'aborted', error: errorMessage(err), at });
        this.store.set(id, accrueActive(current, next, at));
        this.deps.onPersist?.();
      }
    }
  }

  private onSessionChange(id: string, state: SessionState): void {
    const prev = this.store.get(id);
    this.store.set(id, state);
    if (prev && prev.status !== state.status) {
      this.deps.onTransition?.(prev, state);
      // A turn finished — open a draft PR for the branch if auto-PR is on.
      if (prev.status !== 'completed' && state.status === 'completed') {
        void this.prs.maybeAutoPr(id);
      }
    }
    // Only signal a persist when a persisted field actually changed — a burst of
    // streaming-text/log updates shouldn't churn the debounced save.
    if (!prev || persistRelevantChanged(prev, state)) {
      this.deps.onPersist?.();
    }
  }

  /**
   * Rehydrate sessions from a persisted state. Call once at startup, before any
   * create(). Restored sessions are NOT started — they sit idle (their worktree
   * already exists on disk) and lazily resume their SDK conversation on the first
   * follow-up. Ids/slugs are reserved so new sessions don't collide.
   * `histories` (session id → log rebuilt from the SDK transcript) fills the
   * detail-view log; without it a restored session's log starts empty.
   */
  restore(persisted: PersistedState, histories?: ReadonlyMap<string, LogEntry[]>): void {
    for (const p of persisted.sessions) {
      if (this.store.has(p.id)) {
        continue;
      }
      const restored = restoredSessionState(p, histories?.get(p.id));
      const worktree: Worktree = { slug: p.slug, branch: p.branch, path: p.worktreePath };
      this.worktreeMeta.set(p.id, { worktree, base: p.base });
      this.usedSlugs.add(p.slug);
      const input: CreateSessionInput = {
        id: p.id,
        title: p.title,
        prompt: p.prompt,
        branch: p.branch,
        worktreePath: p.worktreePath,
        startedAt: p.startedAt,
      };
      const session = this.buildSession(input, { resume: p.sdkSessionId, restored });
      this.sessions.set(p.id, session);
      this.store.append(p.id, session.getState());
      const n = Number(p.id);
      if (Number.isInteger(n)) {
        this.seq = Math.max(this.seq, n);
      }
    }
    this.deps.onPersist?.();
  }

  /** Build the on-disk snapshot of every restorable session (for state.json). */
  persistableState(): PersistedState {
    return assemblePersistedState(
      this.store.ids(),
      (id) => this.store.get(id),
      (id) => this.worktreeMeta.get(id),
      this.now(),
    );
  }

  // ── UI passthroughs ────────────────────────────────────────────────
  send(id: string, text: string): void {
    this.sessions.get(id)?.send(text);
  }

  /**
   * Resume a cut-off session (`isResumable` — interrupted / rate_limited /
   * needs_login) by sending `instruction`; returns whether it was sent. A session
   * that isn't (or is no longer) cut off is left alone.
   *
   * The status check belongs here rather than in the views because the store is
   * the only *synchronously* fresh view of it: `send` flips the session to
   * `running` immediately, while the UI's subscription is ~100ms throttled, so a
   * held-down / auto-repeating resume key would otherwise queue the same "continue
   * from where you left off" instruction several times — double-billing the turn
   * and leaving duplicate user turns in the transcript for Claude to read.
   */
  resume(id: string, instruction: string): boolean {
    const state = this.store.get(id);
    if (state === undefined || !isResumable(state.status)) {
      return false;
    }
    this.send(id, instruction);
    return true;
  }
  answer(id: string, answers: Record<string, string>): void {
    this.sessions.get(id)?.answerPending(answers);
  }
  allow(id: string): void {
    this.sessions.get(id)?.allowPending();
  }
  deny(id: string, message: string): void {
    this.sessions.get(id)?.denyPending(message);
  }
  /**
   * 進行中のターンを中断する（詳細ビューの `Ctrl+C`）。中断を試みたかを返す。
   *
   * 対象かどうかの判定は `resume()` と同じ理由でここ（core 側）に置く: UI のストア購読は
   * ~100ms スロットルなので、View の `status` は「もう中断済み」を知らない。連打で
   * 2 回目の interrupt が飛んでも、ストアの現在値（`Session.interrupt` が同期的に
   * `interrupted` へ進める）で弾ける。
   */
  async interrupt(id: string): Promise<boolean> {
    const state = this.store.get(id);
    if (state === undefined || !isInterruptible(state.status)) {
      return false;
    }
    await this.sessions.get(id)?.interrupt();
    return true;
  }
  /**
   * Switch the model for a single running session (the detail view's /model).
   * Only that session is affected — the global default (getModel/setModel) and
   * other sessions are untouched, so newly created sessions keep the configured
   * default. The switch is not persisted (it's a live, per-session override).
   */
  setSessionModel(id: string, model: string | undefined): void {
    this.sessions.get(id)?.setModel(model);
  }

  // ── Lifecycle (merge / discard) ────────────────────────────────────
  /** Committed diff stat vs. base plus uncommitted paths for a session. */
  async diffStat(id: string): Promise<DiffStat | undefined> {
    const meta = this.worktreeMeta.get(id);
    return meta ? sessionDiffStat(this.deps.worktrees, meta) : undefined;
  }

  // ── PR recovery (conflicts / red CI) ───────────────────────────────
  /**
   * Sessions whose PR is stuck (base moved on and conflicts, or CI is red), with
   * what each one needs. Drives the bulk action and its hint/confirm counts.
   */
  recoverable(): { state: SessionState; kind: RecoveryKind }[] {
    return recoverableSessions(this.store.getSnapshot());
  }

  /**
   * Un-stick one session's PR: merge the base branch in when GitHub reports a
   * conflict, or hand the red CI to the session with the failing check names.
   * Chooses by {@link recoveryKindFor} unless `kind` forces one (the explicit
   * `/sync` / `/fix-ci` commands, which must work before a poll has answered).
   *
   * The cheap outcomes cost nothing: a clean base merge is pushed straight away
   * without waking Claude, and an already-merged base is a no-op. Only a conflict,
   * a dirty worktree or a red build actually spends a turn.
   */
  async recover(id: string, kind?: RecoveryKind): Promise<RecoveryOutcome> {
    const t = this.deps.messages;
    const meta = this.worktreeMeta.get(id);
    const state = this.store.get(id);
    const session = this.sessions.get(id);
    if (!t || !meta || !state || !session) {
      return { kind: 'skipped' };
    }
    const wanted = kind ?? recoveryKindFor(state);
    if (!wanted) {
      return { kind: 'skipped' };
    }
    // Applies to the explicit `/sync` / `/fix-ci` too, which is the whole reason this
    // check isn't folded into `recoveryKindFor`: running `git merge` inside a worktree
    // Claude is actively editing races with its writes, and queueing a follow-up
    // instruction mid-turn just fights the work already in flight.
    if (!isTerminalStatus(state.status) || state.status === 'archived') {
      return { kind: 'busy' };
    }
    if (wanted === 'ci') {
      session.send(ciFixInstruction(state.branch, state.prStatus?.failingChecks, t));
      return { kind: 'delegated', recovery: 'ci' };
    }
    let result: SyncBaseResult;
    try {
      result = await this.deps.worktrees.syncBase(meta.worktree, meta.base);
    } catch (err) {
      return { kind: 'error', error: errorMessage(err) };
    }
    const instruction = syncInstruction(result, meta.base, t);
    if (instruction !== undefined) {
      session.send(instruction);
      return { kind: 'delegated', recovery: 'sync' };
    }
    if (result.kind === 'upToDate') {
      return { kind: 'upToDate' };
    }
    // A clean merge is only worth anything once GitHub can see it, and pushing a
    // fast-forwardable merge is deterministic enough to do without asking Claude.
    try {
      await this.deps.worktrees.pushBranch(meta.worktree);
    } catch (err) {
      return { kind: 'error', error: errorMessage(err) };
    }
    return { kind: 'synced' };
  }

  /** Merge a session's branch into base, then archive it. */
  async merge(id: string): Promise<ActionResult> {
    const meta = this.worktreeMeta.get(id);
    if (!meta) {
      return { ok: false, error: 'worktree not found' };
    }
    return mergeSession(this.deps.worktrees, meta, this.sessions.get(id));
  }

  /** Abort a session, remove its worktree + branch, then archive it. */
  async discard(id: string, opts: { force?: boolean } = {}): Promise<ActionResult> {
    const meta = this.worktreeMeta.get(id);
    if (!meta) {
      return { ok: false, error: 'worktree not found' };
    }
    const result = await discardSession(this.deps.worktrees, meta, this.sessions.get(id), opts);
    if (result.ok) {
      this.worktreeMeta.delete(id);
      this.prs.forget(id);
    }
    return result;
  }

  /**
   * Remove one session outright (`x` / `/remove`): the worktree + branch are
   * deleted **and** the list row is dropped. This is the difference from discard,
   * which leaves the row behind as `archived`: a lingering row keeps showing up in
   * the list and — for a session whose PR is old and no longer interesting — makes
   * the bulk recovery pass (`recoverableSessions`, which reads the store) offer it
   * again on every Ctrl+F. Dropping the row also keeps it out of state.json
   * (persistableState() reads the store), so it stays gone after a restart.
   *
   * A row whose worktree is already gone (a session discarded earlier) is still
   * removable: missing metadata is not an error here, since forgetting the row is
   * the whole point of the command.
   */
  async remove(id: string, opts: { force?: boolean } = {}): Promise<ActionResult> {
    if (this.store.get(id) === undefined) {
      return { ok: false, error: 'session not found' };
    }
    const meta = this.worktreeMeta.get(id);
    if (meta) {
      const result = await discardSession(this.deps.worktrees, meta, this.sessions.get(id), opts);
      if (!result.ok) {
        return result;
      }
    }
    this.forget(id);
    this.deps.onPersist?.();
    return { ok: true };
  }

  /**
   * Clear finished sessions (the `/clear` command). Every terminal session
   * (completed/interrupted/rate_limited/failed/conflict/archived) has its worktree
   * and branch removed and its row dropped, so nothing is left behind on disk or
   * in state.json. In-flight sessions (creating/running/awaiting_*) are kept:
   * clearing them would orphan a live SDK conversation.
   *
   * Sequential on purpose: `git worktree remove` + `git branch -D` take a
   * repo-wide lock, so firing them together would make some of them fail on a lock
   * they can't see (same reason as the bulk recovery pass).
   *
   * A worktree that refuses to go is reported and its row is **kept** — dropping
   * the row would hide a directory that is still on disk.
   */
  async clear(): Promise<ClearOutcome> {
    const targets = this.store
      .ids()
      .filter((id) => isTerminalStatus(this.store.get(id)?.status ?? 'running'));
    let cleared = 0;
    let error: string | undefined;
    for (const id of targets) {
      const meta = this.worktreeMeta.get(id);
      if (meta) {
        try {
          await this.deps.worktrees.remove(meta.worktree, { force: true });
        } catch (err) {
          error ??= errorMessage(err);
          continue;
        }
      }
      this.forget(id);
      cleared += 1;
    }
    if (cleared > 0) {
      this.deps.onPersist?.();
    }
    return { cleared, error };
  }

  /**
   * Drop every trace of a session from memory, list row included. Stops the SDK
   * process quietly (stop(), not abort(): the status no longer matters once the row
   * is gone, and abort would fire a state change nobody reads). The reserved slug
   * is intentionally **not** freed — handing a brand-new session the branch name of
   * one the user just deleted would be confusing, and slugs are cheap.
   */
  private forget(id: string): void {
    this.sessions.get(id)?.stop();
    this.sessions.delete(id);
    this.worktreeMeta.delete(id);
    this.prs.forget(id);
    this.store.remove(id);
  }

  /**
   * Quietly stop every session (worktrees/branches left intact) and clear
   * listeners. Uses stop() rather than abort() so in-flight sessions persist as
   * resumable instead of being marked failed on quit.
   */
  dispose(): void {
    for (const session of this.sessions.values()) {
      session.stop();
    }
    this.store.clearListeners();
  }

  /** Paths of worktrees still on disk (shown to the user on exit). */
  activeWorktreePaths(): string[] {
    return [...this.worktreeMeta.values()].map((meta) => meta.worktree.path);
  }

  /** Poll every live session's branch for an open PR (best-effort; see PrCoordinator). */
  async refreshPrs(): Promise<void> {
    await this.prs.refreshPrs();
  }
}
