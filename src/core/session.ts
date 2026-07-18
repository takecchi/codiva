import type {
  Options,
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

export interface SessionDeps {
  queryFn: QueryFn;
  input: CreateSessionInput;
  model?: string;
  now?: () => number;
  policy?: PermissionPolicy;
  onChange?: (state: SessionState) => void;
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
    this.state = initialState(deps.input);
    this.now = deps.now ?? Date.now;
    this.policy = deps.policy ?? defaultPolicy;
    this.onChange = deps.onChange;
  }

  getState(): SessionState {
    return this.state;
  }

  /** Begin the session: enqueue the initial prompt and start consuming output. */
  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    this.inputQueue.push(toUserMessage(this.state.prompt));
    void this.consume();
  }

  /** Send an additional instruction into the live session. */
  send(text: string): void {
    this.inputQueue.push(toUserMessage(text));
    this.dispatch({ kind: 'user_input', text, at: this.now() });
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

  /** Mark the session archived (after its branch is merged or discarded). */
  archive(): void {
    this.dispatch({ kind: 'archived', at: this.now() });
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
      this.handle = this.deps.queryFn({
        prompt: this.inputQueue,
        options: {
          cwd: this.state.worktreePath,
          permissionMode: 'acceptEdits',
          canUseTool: this.canUseTool,
          abortController: this.abortController,
          settingSources: ['project'],
          ...(this.deps.model ? { model: this.deps.model } : {}),
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
