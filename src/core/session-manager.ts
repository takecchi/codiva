import { type PermissionPolicy, type QueryFn, Session } from './session';
import { makeSlug, makeTitle, uniqueSlug } from './slug';
import { initialState } from './status-reducer';
import type { CreateSessionInput, SessionState } from './types';
import type { DiffStat, Worktree } from './worktree';

/** The subset of WorktreeManager the SessionManager needs (for DI in tests). */
export interface WorktreeService {
  baseBranch(): Promise<string>;
  takenSlugs(): Promise<Set<string>>;
  add(slug: string): Promise<Worktree>;
  diffStat(wt: Worktree, base: string): Promise<DiffStat>;
  merge(wt: Worktree, base: string): Promise<void>;
  remove(wt: Worktree, opts?: { force?: boolean }): Promise<void>;
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
  archive(): void;
}

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
  now?: () => number;
  model?: string;
  policy?: PermissionPolicy;
  /** Factory for a session; defaults to constructing a real Session. */
  createSession?: (args: {
    input: CreateSessionInput;
    onChange: (state: SessionState) => void;
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
  private snapshot: SessionState[] = [];
  private seq = 0;
  private mode: RunMode = 'auto';
  private readonly now: () => number;

  constructor(private readonly deps: SessionManagerDeps) {
    this.now = deps.now ?? Date.now;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
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
      const wt = await this.deps.worktrees.add(slug);
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
          model: this.deps.model,
          now: this.now,
          policy: this.deps.policy ?? this.modePolicy,
          onChange: (s) => this.onSessionChange(id, s),
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
    this.states.set(id, state);
    this.rebuild();
  }

  private rebuild(): void {
    this.snapshot = this.order.map((id) => this.states.get(id) as SessionState);
    this.notify();
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

  /** Abort every session (worktrees/branches are left intact) and clear listeners. */
  dispose(): void {
    for (const session of this.sessions.values()) {
      session.abort();
    }
    this.listeners.clear();
  }

  /** Paths of worktrees still on disk (shown to the user on exit). */
  activeWorktreePaths(): string[] {
    return [...this.worktreeMeta.values()].map((m) => m.worktree.path);
  }
}
