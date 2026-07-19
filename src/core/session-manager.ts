import {
  type PersistedSession,
  type PersistedState,
  restoredSessionState,
  toPersistedSession,
} from './persistence';
import { type PermissionPolicy, type QueryFn, Session, type SessionOptions } from './session';
import { makeSlug, makeTitle, uniqueSlug } from './slug';
import { initialState } from './status-reducer';
import type { CreateSessionInput, LogEntry, PrChecksState, PrInfo, SessionState } from './types';
import { type DiffStat, MergeConflictError, type Worktree } from './worktree';

/** The subset of WorktreeManager the SessionManager needs (for DI in tests). */
export interface WorktreeService {
  baseBranch(): Promise<string>;
  takenSlugs(): Promise<Set<string>>;
  add(slug: string, startPoint?: string): Promise<Worktree>;
  syncedStartPoint(base: string): Promise<string | undefined>;
  pushBranch(wt: Worktree): Promise<void>;
  diffStat(wt: Worktree, base: string): Promise<DiffStat>;
  merge(wt: Worktree, base: string): Promise<void>;
  remove(wt: Worktree, opts?: { force?: boolean }): Promise<void>;
}

/**
 * GitHub PR automation seam (via `gh`), injected so the manager stays testable.
 * All calls are best-effort at the call site; failures never break a session.
 */
export interface PrAutomation {
  /** Open a draft PR for a pushed branch (or return the existing one). */
  createPr(cwd: string, branch: string): Promise<PrInfo | undefined>;
  /** Aggregate CI state of the PR's checks. */
  checks(cwd: string, branch: string): Promise<PrChecksState>;
  /** Flip a draft PR to ready-for-review. */
  markReady(cwd: string, branch: string): Promise<void>;
}

/** The subset of Session the manager drives (for DI in tests). */
export interface SessionHandle {
  getState(): SessionState;
  start(): void;
  send(text: string): void;
  answerPending(answers: Record<string, string>): void;
  allowPending(): void;
  denyPending(message: string): void;
  interrupt(): Promise<void>;
  abort(): void;
  stop(): void;
  archive(): void;
  setPr(pr: PrInfo | undefined): void;
  markConflict(files: string[]): void;
}

/** Look up the open PR for a branch (via `gh`), or undefined if there is none. */
export type PrLookup = (cwd: string, branch: string) => Promise<PrInfo | undefined>;

/** Result of a lifecycle action (merge/discard) surfaced to the UI. */
export interface ActionResult {
  ok: boolean;
  error?: string;
}

/**
 * Global tool-approval mode, toggled with shift+tab (à la Claude Code).
 * - `auto`: run every tool automatically (only AskUserQuestion pauses).
 * - `confirm`: pause on every tool for an explicit allow/deny.
 * The mode is read at each tool call, so toggling affects live sessions too.
 */
export type RunMode = 'auto' | 'confirm';

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
    resume?: string;
    restored?: SessionState;
  }) => SessionHandle;
}

type Listener = () => void;

/**
 * Owns all sessions and exposes a snapshot the UI subscribes to via
 * useSyncExternalStore. create() returns synchronously with a 'creating' entry;
 * worktree setup and session start happen in the background so the input is
 * never blocked. Snapshots keep per-session object identity across rebuilds so
 * unchanged rows don't re-render.
 */
export class SessionManager {
  private readonly listeners = new Set<Listener>();
  private readonly order: string[] = [];
  private readonly states = new Map<string, SessionState>();
  private readonly sessions = new Map<string, SessionHandle>();
  private readonly worktreeMeta = new Map<string, { worktree: Worktree; base: string }>();
  private readonly usedSlugs = new Set<string>();
  /** Sessions we've already attempted an auto-PR for (avoids repeat push/create). */
  private readonly autoPrAttempted = new Set<string>();
  private snapshot: SessionState[] = [];
  private seq = 0;
  private mode: RunMode = 'auto';
  private readonly now: () => number;
  /**
   * Live per-session knobs forwarded to each new Session. Seeded from
   * deps.options (the config file) but mutable so /model can change the default
   * model for sessions created later in this run.
   */
  private options: SessionOptions;

  constructor(private readonly deps: SessionManagerDeps) {
    this.now = deps.now ?? Date.now;
    this.options = { ...deps.options };
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
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
    this.notify();
    return this.mode;
  }

  /**
   * Policy applied to sessions that don't get an explicit one. Reads `this.mode`
   * at call time so a shift+tab toggle takes effect on already-running sessions.
   * AskUserQuestion always escalates — it *is* the ask-the-user channel.
   */
  private readonly modePolicy: PermissionPolicy = (toolName) => {
    if (toolName === 'AskUserQuestion') {
      return 'ask';
    }
    return this.mode === 'auto' ? 'allow' : 'ask';
  };

  getSnapshot(): SessionState[] {
    return this.snapshot;
  }

  get(id: string): SessionState | undefined {
    return this.states.get(id);
  }

  /** Queue a new session for `prompt`; returns its id immediately. */
  create(prompt: string): string {
    this.seq += 1;
    const id = String(this.seq);
    const title = makeTitle(prompt);
    const placeholder: SessionState = {
      ...initialState({
        id,
        title,
        prompt,
        branch: `codiva/${makeSlug(prompt)}`,
        worktreePath: '',
        startedAt: this.now(),
      }),
    };
    this.order.push(id);
    this.states.set(id, placeholder);
    this.rebuild();
    void this.provision(id, prompt, title);
    return id;
  }

  private async provision(id: string, prompt: string, title: string): Promise<void> {
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
        startedAt: this.now(),
      };
      const session =
        this.deps.createSession?.({ input, onChange: (s) => this.onSessionChange(id, s) }) ??
        new Session({
          queryFn: this.deps.queryFn,
          input,
          options: this.options,
          now: this.now,
          policy: this.deps.policy ?? this.modePolicy,
          onChange: (s) => this.onSessionChange(id, s),
          generateTitle: this.deps.generateTitle,
        });
      this.sessions.set(id, session);
      this.states.set(id, session.getState());
      this.rebuild();
      session.start();
    } catch (err) {
      const current = this.states.get(id);
      if (current) {
        this.states.set(id, { ...current, status: 'failed', error: String(err) });
        this.rebuild();
      }
    }
  }

  private onSessionChange(id: string, state: SessionState): void {
    const prev = this.states.get(id);
    this.states.set(id, state);
    if (prev && prev.status !== state.status) {
      this.deps.onTransition?.(prev, state);
      // A turn finished — open a draft PR for the branch if auto-PR is on.
      if (prev.status !== 'completed' && state.status === 'completed') {
        void this.maybeAutoPr(id);
      }
    }
    this.rebuild();
  }

  /**
   * Best-effort auto-PR for a just-completed session: push the branch and open a
   * draft PR (once per session). No-op unless autoPr + prAutomation are wired,
   * the session already has a PR, or the branch has no committed changes to PR.
   * refreshPrs() later flips the draft to ready when checks pass.
   */
  private async maybeAutoPr(id: string): Promise<void> {
    if (!this.deps.autoPr || !this.deps.prAutomation || this.autoPrAttempted.has(id)) {
      return;
    }
    const meta = this.worktreeMeta.get(id);
    const state = this.states.get(id);
    const session = this.sessions.get(id);
    if (!meta || !state || !session || state.pr) {
      return;
    }
    this.autoPrAttempted.add(id);
    try {
      const stat = await this.deps.worktrees.diffStat(meta.worktree, meta.base);
      if (stat.committed.trim().length === 0) {
        // Nothing committed ahead of base — there's nothing to open a PR for.
        return;
      }
      await this.deps.worktrees.pushBranch(meta.worktree);
      const pr = await this.deps.prAutomation.createPr(meta.worktree.path, state.branch);
      if (pr) {
        session.setPr(pr);
      }
    } catch {
      // best-effort — a missing remote / `gh` / network issue must not disrupt the session
    }
  }

  private rebuild(): void {
    this.snapshot = this.order.map((id) => this.states.get(id) as SessionState);
    this.deps.onPersist?.();
    this.notify();
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
      if (this.states.has(p.id)) {
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
      const onChange = (s: SessionState) => this.onSessionChange(p.id, s);
      const session =
        this.deps.createSession?.({ input, onChange, resume: p.sdkSessionId, restored }) ??
        new Session({
          queryFn: this.deps.queryFn,
          input,
          options: this.options,
          now: this.now,
          policy: this.deps.policy ?? this.modePolicy,
          onChange,
          resume: p.sdkSessionId,
          restored,
        });
      this.sessions.set(p.id, session);
      this.states.set(p.id, session.getState());
      this.order.push(p.id);
      const n = Number(p.id);
      if (Number.isInteger(n)) {
        this.seq = Math.max(this.seq, n);
      }
    }
    this.rebuild();
  }

  /** Build the on-disk snapshot of every restorable session (for state.json). */
  persistableState(): PersistedState {
    const sessions = this.order
      .map((id) => {
        const state = this.states.get(id);
        const meta = this.worktreeMeta.get(id);
        if (!state || !meta) {
          return undefined;
        }
        return toPersistedSession(state, { slug: meta.worktree.slug, base: meta.base });
      })
      .filter((s): s is PersistedSession => s !== undefined);
    return { version: 1, sessions };
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
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

  // ── Lifecycle (merge / discard) ────────────────────────────────────
  /** Committed diff stat vs. base plus uncommitted paths for a session. */
  async diffStat(id: string): Promise<DiffStat | undefined> {
    const meta = this.worktreeMeta.get(id);
    if (!meta) {
      return undefined;
    }
    return this.deps.worktrees.diffStat(meta.worktree, meta.base);
  }

  /** Merge a session's branch into base, then archive it. */
  async merge(id: string): Promise<ActionResult> {
    const meta = this.worktreeMeta.get(id);
    if (!meta) {
      return { ok: false, error: 'worktree not found' };
    }
    try {
      await this.deps.worktrees.merge(meta.worktree, meta.base);
      this.sessions.get(id)?.archive();
      return { ok: true };
    } catch (err) {
      // A conflict is detected (not auto-resolved): flag the session so the list
      // shows a `conflict` badge instead of only a transient error toast.
      if (err instanceof MergeConflictError) {
        this.sessions.get(id)?.markConflict(err.files);
      }
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Abort a session, remove its worktree + branch, then archive it. */
  async discard(id: string, opts: { force?: boolean } = {}): Promise<ActionResult> {
    const meta = this.worktreeMeta.get(id);
    if (!meta) {
      return { ok: false, error: 'worktree not found' };
    }
    this.sessions.get(id)?.abort();
    try {
      await this.deps.worktrees.remove(meta.worktree, opts);
      this.worktreeMeta.delete(id);
      this.sessions.get(id)?.archive();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
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
    this.listeners.clear();
  }

  /** Paths of worktrees still on disk (shown to the user on exit). */
  activeWorktreePaths(): string[] {
    return [...this.worktreeMeta.values()].map((m) => m.worktree.path);
  }

  /**
   * Poll every live session's branch for an open PR and feed the result back in
   * via session.setPr (the reducer no-ops when unchanged). Best-effort: a lookup
   * failure for one session never rejects or affects the others. No-op when no
   * `lookupPr` is wired (e.g. in tests). Wired to a periodic timer in index.tsx.
   */
  async refreshPrs(): Promise<void> {
    const lookup = this.deps.lookupPr;
    if (!lookup) {
      return;
    }
    await Promise.all(
      this.order.map(async (id) => {
        const state = this.states.get(id);
        const meta = this.worktreeMeta.get(id);
        const session = this.sessions.get(id);
        // Skip rows with no worktree yet (creating) or already archived — nothing
        // to look up, and no branch that could have a PR.
        if (!state || !meta || !session || state.status === 'archived') {
          return;
        }
        try {
          const pr = await lookup(meta.worktree.path, state.branch);
          session.setPr(pr);
          // Auto-ready: once a draft PR's checks pass, flip it to ready-for-review.
          if (this.deps.autoPr && this.deps.prAutomation && pr?.isDraft) {
            const checks = await this.deps.prAutomation.checks(meta.worktree.path, state.branch);
            if (checks === 'passing') {
              await this.deps.prAutomation.markReady(meta.worktree.path, state.branch);
              session.setPr({ ...pr, isDraft: false });
            }
          }
        } catch {
          // best-effort — a missing `gh`, network hiccup, or auth issue is ignored
        }
      }),
    );
  }
}
