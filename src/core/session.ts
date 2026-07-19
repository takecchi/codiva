import type {
  EffortLevel,
  Options,
  PermissionMode,
  PermissionResult,
  Query,
  SDKMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { AsyncQueue } from './async-queue';
import { initialState, reduce } from './status-reducer';
import type {
  CodivaEvent,
  CreateSessionInput,
  PermissionRequest,
  PrInfo,
  QuestionSpec,
  SessionState,
} from './types';

export type QueryFn = (params: {
  prompt: AsyncIterable<SDKUserMessage>;
  options: Options;
}) => Query;

/** Decide whether a tool runs automatically or is escalated to the user. */
export type PermissionPolicy = (
  toolName: string,
  input: Record<string, unknown>,
) => 'allow' | 'ask';

/**
 * Default policy: run everything automatically so sessions are autonomous.
 * AskUserQuestion is always escalated — it *is* the "ask the user" channel.
 * (Phase 1 showed even Write reaches canUseTool under acceptEdits, so relying on
 * permissionMode alone would stall autonomy; we auto-allow here instead.)
 */
export const defaultPolicy: PermissionPolicy = (toolName) =>
  toolName === 'AskUserQuestion' ? 'ask' : 'allow';

/** Per-session knobs forwarded to the SDK query (sourced from the config file). */
export interface SessionOptions {
  model?: string;
  effort?: EffortLevel;
  permissionMode?: PermissionMode;
  maxBudgetUsd?: number;
}

export interface SessionDeps {
  queryFn: QueryFn;
  input: CreateSessionInput;
  options?: SessionOptions;
  now?: () => number;
  policy?: PermissionPolicy;
  onChange?: (state: SessionState) => void;
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

function toUserMessage(text: string): SDKUserMessage {
  return { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null };
}

function parseQuestions(input: Record<string, unknown>): QuestionSpec[] {
  const raw = (input.questions as Record<string, unknown>[] | undefined) ?? [];
  return raw.map((q) => ({
    question: String(q.question ?? ''),
    header: String(q.header ?? ''),
    multiSelect: Boolean(q.multiSelect),
    options: ((q.options as { label?: string; description?: string }[] | undefined) ?? []).map(
      (o) => ({ label: String(o.label ?? ''), description: String(o.description ?? '') }),
    ),
  }));
}

/**
 * One live Claude session bound to a worktree. Owns the streaming-input queue,
 * consumes the SDK message stream into the pure reducer, and bridges canUseTool
 * to the UI (auto-allowing routine tools, blocking on user-facing questions).
 */
export class Session {
  private state: SessionState;
  private readonly inputQueue = new AsyncQueue<SDKUserMessage>();
  private readonly abortController = new AbortController();
  private readonly now: () => number;
  private readonly policy: PermissionPolicy;
  private readonly onChange?: (state: SessionState) => void;
  private handle?: Query;
  private pending?: { request: PermissionRequest; resolve: (r: PermissionResult) => void };
  private reqSeq = 0;
  private started = false;

  constructor(private readonly deps: SessionDeps) {
    this.state = deps.restored ?? initialState(deps.input);
    this.now = deps.now ?? Date.now;
    this.policy = deps.policy ?? defaultPolicy;
    this.onChange = deps.onChange;
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
    if (this.started) {
      return;
    }
    this.inputQueue.push(toUserMessage(this.state.prompt));
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

  /** Send an additional instruction into the (possibly not-yet-started) session. */
  send(text: string): void {
    this.inputQueue.push(toUserMessage(text));
    this.ensureConsuming();
    this.dispatch({ kind: 'user_input', text, at: this.now() });
  }

  /** Start the SDK query + consume loop if it isn't running yet. */
  private ensureConsuming(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    void this.consume();
  }

  /** Answer a pending AskUserQuestion. `answers` maps question text → chosen label. */
  answerPending(answers: Record<string, string>): void {
    this.resolvePending({
      behavior: 'allow',
      updatedInput: { ...(this.pending?.request.input ?? {}), answers },
    });
  }

  /** Allow a pending tool permission request. */
  allowPending(): void {
    this.resolvePending({ behavior: 'allow', updatedInput: this.pending?.request.input ?? {} });
  }

  /** Deny a pending tool permission request with a reason shown to Claude. */
  denyPending(message: string): void {
    this.resolvePending({ behavior: 'deny', message });
  }

  /** Interrupt the current turn (ends it with an error result); session stays alive. */
  async interrupt(): Promise<void> {
    await this.handle?.interrupt?.();
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
    if (this.pending) {
      this.pending.resolve({ behavior: 'deny', message: 'session stopped' });
      this.pending = undefined;
    }
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
   * Flag the session as blocked on a merge conflict (its branch couldn't merge
   * into base). Driven by the manager's merge action; we surface the conflicted
   * files but never auto-resolve.
   */
  markConflict(files: string[]): void {
    this.dispatch({ kind: 'conflict', files, at: this.now() });
  }

  private resolvePending(result: PermissionResult): void {
    const pending = this.pending;
    if (!pending) {
      return;
    }
    this.pending = undefined;
    pending.resolve(result);
    this.dispatch({ kind: 'permission_resolved', at: this.now() });
  }

  private canUseTool = (
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<PermissionResult> => {
    const decision = this.policy(toolName, input);
    if (decision === 'allow') {
      return Promise.resolve({ behavior: 'allow', updatedInput: input });
    }
    this.reqSeq += 1;
    const isQuestion = toolName === 'AskUserQuestion';
    const request: PermissionRequest = {
      id: `${this.state.id}:${this.reqSeq}`,
      toolName,
      input,
      kind: isQuestion ? 'question' : 'tool',
      questions: isQuestion ? parseQuestions(input) : undefined,
    };
    return new Promise<PermissionResult>((resolve) => {
      this.pending = { request, resolve };
      this.dispatch({ kind: 'permission_request', request, at: this.now() });
    });
  };

  private async consume(): Promise<void> {
    try {
      const opts = this.deps.options;
      this.handle = this.deps.queryFn({
        prompt: this.inputQueue,
        options: {
          cwd: this.state.worktreePath,
          permissionMode: opts?.permissionMode ?? 'acceptEdits',
          canUseTool: this.canUseTool,
          abortController: this.abortController,
          settingSources: ['project'],
          // Stream partial assistant text so the detail view shows a live preview
          // (reduced into state.streamingText). See status-reducer reduceStreamEvent.
          includePartialMessages: true,
          ...(opts?.model ? { model: opts.model } : {}),
          ...(opts?.effort ? { effort: opts.effort } : {}),
          ...(opts?.maxBudgetUsd != null ? { maxBudgetUsd: opts.maxBudgetUsd } : {}),
          ...(this.deps.resume ? { resume: this.deps.resume } : {}),
        },
      });
      for await (const message of this.handle) {
        this.dispatch({ kind: 'sdk', message: message as SDKMessage, at: this.now() });
      }
    } catch (err) {
      if (!this.abortController.signal.aborted) {
        this.dispatch({ kind: 'aborted', error: String(err), at: this.now() });
      }
    }
  }

  private dispatch(event: CodivaEvent): void {
    const next = reduce(this.state, event);
    if (next !== this.state) {
      this.state = next;
      this.onChange?.(next);
    }
  }
}
