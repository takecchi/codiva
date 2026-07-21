import type { SessionState } from './types';

type Listener = () => void;

/**
 * The subscribable session snapshot the UI reads via useSyncExternalStore.
 * Holds insertion order + the latest state per id, and rebuilds an array snapshot
 * on every change. Per-session object identity is preserved across rebuilds (the
 * states map holds the very objects the reducer produced), so unchanged rows keep
 * their reference and don't re-render.
 *
 * This is purely the store — lifecycle, worktrees, and persistence live in
 * SessionManager, which drives it.
 */
export class SessionStore {
  private readonly listeners = new Set<Listener>();
  private readonly order: string[] = [];
  private readonly states = new Map<string, SessionState>();
  private snapshot: SessionState[] = [];

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Notify subscribers without rebuilding the snapshot (e.g. a mode toggle). */
  notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }

  getSnapshot(): SessionState[] {
    return this.snapshot;
  }

  get(id: string): SessionState | undefined {
    return this.states.get(id);
  }

  has(id: string): boolean {
    return this.states.has(id);
  }

  /** Session ids in insertion order (creation order). */
  ids(): readonly string[] {
    return this.order;
  }

  /** Add a new session at the end of the order (creation / restore). */
  append(id: string, state: SessionState): void {
    if (!this.states.has(id)) {
      this.order.push(id);
    }
    this.states.set(id, state);
    this.rebuild();
  }

  /** Replace an existing session's state (no reordering). */
  set(id: string, state: SessionState): void {
    this.states.set(id, state);
    this.rebuild();
  }

  /** Drop a session entirely (from both order and state). Used by clear(). */
  remove(id: string): void {
    const idx = this.order.indexOf(id);
    if (idx === -1) {
      return;
    }
    this.order.splice(idx, 1);
    this.states.delete(id);
    this.rebuild();
  }

  clearListeners(): void {
    this.listeners.clear();
  }

  private rebuild(): void {
    this.snapshot = this.order.map((id) => this.states.get(id) as SessionState);
    this.notify();
  }
}
