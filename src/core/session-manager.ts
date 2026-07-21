import { errorMessage } from './errors';
import { assemblePersistedState, type PersistedState, restoredSessionState } from './persistence';
import { PrCoordinator } from './pr-coordinator';
import {
  type RateLimitInfoJson,
  type RateLimitType,
  type RateLimitWindow,
  sameRateLimitWindow,
  sortRateLimitWindows,
  toRateLimitWindow,
} from './rate-limit';
import { createModePolicy, type RunMode } from './run-mode';
import { type PermissionPolicy, type QueryFn, Session, type SessionOptions } from './session';
import { discardSession, mergeSession, sessionDiffStat } from './session-actions';
import type {
  ActionResult,
  PrAutomation,
  PrLookup,
  SessionHandle,
  WorktreeMeta,
  WorktreeService,
} from './session-ports';
import { SessionStore } from './session-store';
import { makeSlug, makeTitle, uniqueSlug } from './slug';
import { initialState, reduce } from './status-reducer';
import type { CreateSessionInput, LogEntry, SessionState } from './types';
import type { DiffStat, Worktree } from './worktree';

export interface SessionManagerDeps {
  worktrees: WorktreeService;
  queryFn: QueryFn;
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
  /** Optional PR lookup (via `gh`); when set, refreshPrs() polls each live session's branch. */
  lookupPr?: PrLookup;
  /**
   * When true, sessions are created from the latest `origin/<base>` (fetched
   * first) instead of the local HEAD. Falls back to local HEAD when there is no
   * usable upstream. Default off unless wired (index.tsx defaults it on).
   */
  followOrigin?: boolean;
  /**
   * When true (and `prAutomation` is wired), a session that completes with
   * committed changes is pushed and gets a draft PR; refreshPrs() then readies it
   * once checks pass. Default off unless wired.
   */
  autoPr?: boolean;
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

/** Fields that end up in the persisted snapshot (see persistence.toPersistedSession). */
function persistRelevantChanged(prev: SessionState, next: SessionState): boolean {
  return (
    prev.status !== next.status ||
    prev.sdkSessionId !== next.sdkSessionId ||
    prev.title !== next.title ||
    prev.finishedAt !== next.finishedAt ||
    prev.totalCostUsd !== next.totalCostUsd ||
    prev.model !== next.model ||
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
      getMeta: (id) => this.worktreeMeta.get(id),
      getState: (id) => this.store.get(id),
      getSession: (id) => this.sessions.get(id),
      ids: () => this.store.ids(),
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

  /** Fold a session's `rate_limit_event` into the account-wide snapshot. */
  private onRateLimit(info: RateLimitInfoJson): void {
    const window = toRateLimitWindow(info);
    if (!window) {
      return;
    }
    const prev = this.rateLimits.get(window.type);
    if (prev && sameRateLimitWindow(prev, window)) {
      return; // unchanged — don't rebuild the snapshot or re-render
    }
    this.rateLimits.set(window.type, window);
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
        this.store.set(
          id,
          reduce(current, { kind: 'aborted', error: errorMessage(err), at: this.now() }),
        );
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
    );
  }

  // ── UI passthroughs ────────────────────────────────────────────────
  send(id: string, text: string): void {
    this.sessions.get(id)?.send(text);
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
  async interrupt(id: string): Promise<void> {
    await this.sessions.get(id)?.interrupt();
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
    }
    return result;
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
