import type {
  Options,
  PermissionResult,
  Query,
  SDKMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type { AgentEvent } from './agent-events';
import type {
  AgentAdapter,
  AgentAvailability,
  AgentCapabilities,
  AgentLoginProcess,
  AgentRun,
  AgentRunRequest,
} from './agent-ports';
import { classifyClaudeError } from './claude-errors';
import { parseClaudeMessage } from './claude-parse';
import type { QuestionSpec } from './types';

/**
 * Claude Code（`@anthropic-ai/claude-agent-sdk`）用の {@link AgentAdapter}。
 *
 * ここが「Claude の `query()` を codiva の中立語彙へ翻訳する」層で、
 * SDK の型が出てくるのはこのファイルと `claude-parse.ts` / `claude-errors.ts` だけ。
 * `Session` から見ると Claude も Codex も同じ `AgentAdapter` なので、
 * **セッション途中の切替**（`Session.setAgent`）が成立する。
 */

/** SDK の `query` の署名（DI 用）。 */
export type QueryFn = (params: {
  prompt: AsyncIterable<SDKUserMessage>;
  options: Options;
}) => Query;

/** Claude Code が持っている機能。 */
export const CLAUDE_CAPABILITIES: AgentCapabilities = {
  permissions: true,
  interrupt: true,
  setModel: true,
  resume: true,
  modelCatalog: true,
  usage: true,
  cost: true,
  transcript: true,
};

/** AskUserQuestion の入力を UI が扱える {@link QuestionSpec} へ写す。 */
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

/** ユーザー発話（文字列）を SDK のメッセージ形へ包む。 */
function toUserMessage(text: string): SDKUserMessage {
  return { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null };
}

async function* toSdkPrompt(prompt: AsyncIterable<string>): AsyncIterable<SDKUserMessage> {
  for await (const text of prompt) {
    yield toUserMessage(text);
  }
}

/** `AgentAdapter` を Claude 用に組み立てる。`queryFn` は DI（テストはフェイクを注入）。 */
export function createClaudeAdapter(deps: {
  queryFn: QueryFn;
  generateTitle?: (prompt: string) => Promise<string | null | undefined>;
  /** 導入・ログイン検出（I/O は `utils/claude.ts` の `detectClaudeAvailability`）。 */
  checkAvailability?: () => Promise<AgentAvailability>;
  /** TUI 内ログインのプロセス起動（I/O は `utils/agent-login.ts` の `spawnLogin`）。 */
  spawnLogin?: (command: string, args: readonly string[]) => AgentLoginProcess;
}): AgentAdapter {
  const spawnLogin = deps.spawnLogin;
  return {
    id: 'claude',
    displayName: 'Claude',
    loginCommand: 'claude',
    capabilities: CLAUDE_CAPABILITIES,
    classifyError: classifyClaudeError,
    generateTitle: deps.generateTitle,
    checkAvailability: deps.checkAvailability,
    // `claude auth login` はブラウザ OAuth。端末は明け渡さないので、出力に現れる
    // 認証 URL を codiva が拾って開く（既定は claude.ai サブスク。`--console` 等は付けない）。
    login: spawnLogin ? () => spawnLogin('claude', ['auth', 'login']) : undefined,

    open(request: AgentRunRequest): AgentRun {
      const canUseTool = async (
        toolName: string,
        input: Record<string, unknown>,
      ): Promise<PermissionResult> => {
        const isQuestion = toolName === 'AskUserQuestion';
        const decision = await request.requestPermission({
          toolName,
          input,
          kind: isQuestion ? 'question' : 'tool',
          questions: isQuestion ? parseQuestions(input) : undefined,
        });
        // `AskUserQuestion` は `answers` を入れずに allow すると質問が無視される
        // （"The user did not answer the questions."）ので、UI の回答は
        // `decision.input` に載せて丸ごと差し替える。
        return decision.behavior === 'allow'
          ? { behavior: 'allow', updatedInput: decision.input ?? input }
          : { behavior: 'deny', message: decision.message ?? 'denied' };
      };

      const opts = request.options;
      const handle = deps.queryFn({
        prompt: toSdkPrompt(request.prompt),
        options: {
          cwd: request.cwd,
          permissionMode: opts.permissionMode ?? 'acceptEdits',
          canUseTool,
          abortController: request.abortController,
          settingSources: ['project'],
          // Stream partial assistant text so the detail view shows a live preview
          // (reduced into state.streamingText). See claude-parse fromStreamEvent.
          includePartialMessages: true,
          // worktree の環境説明 + リポジトリ追加指示を systemPrompt として注入する。SDK は
          // systemPrompt 省略時に空文字("")へ写像する（claude_code プリセットは使わない）ため、
          // ここに文字列を渡すのは「空への追記」と等価。将来ベースの systemPrompt を
          // 足すなら、この行は array / preset-append 形へ切り替える必要がある。
          ...(opts.systemPrompt ? { systemPrompt: opts.systemPrompt } : {}),
          ...(opts.model ? { model: opts.model } : {}),
          ...(opts.effort ? { effort: opts.effort } : {}),
          ...(opts.maxBudgetUsd != null ? { maxBudgetUsd: opts.maxBudgetUsd } : {}),
          ...(request.resume ? { resume: request.resume } : {}),
        } as Options,
      });

      return {
        async *[Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
          for await (const message of handle) {
            yield* parseClaudeMessage(message as SDKMessage);
          }
        },
        interrupt: async () => {
          await handle.interrupt?.();
        },
        setModel: (model) => handle.setModel?.(model),
      };
    },
  };
}
