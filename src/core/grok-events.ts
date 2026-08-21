/**
 * `grok agent stdio`（ACP = Agent Client Protocol / JSON-RPC 2.0 over stdio）が
 * 流すメッセージの**形**。
 *
 * 出所は xai-org/grok-build の `agent-client-protocol` クレート（`session/*` の標準部）と
 * `crates/codegen/xai-grok-shell/src/extensions/notification.rs`（`x.ai/*` の拡張部）で、
 * 実際に採取した通信が `src/core/__fixtures__/grok-*.jsonl` にある。**想定で書かない**
 * （規約: `.claude/rules/sdk-integration.md`）。
 *
 * ここは型と受理ガードだけ。`AgentEvent` への写像は `core/grok-parse.ts`、状態の
 * 畳み込みは全 provider 共通の `applyAgentEvent`（`core/agent-events.ts`）。
 *
 * 通知が**2 本のレール**で届くことに注意する:
 *   - `session/update` … ACP 標準（`sessionUpdate` が camelCase のフィールドを持つ）
 *   - `_x.ai/session_notification` … xAI 拡張（同じ `update` 封筒だが **snake_case**）
 * どちらも中身は `update.sessionUpdate` で判別するので、{@link grokUpdateOf} が
 * 両方から `update` を取り出す。
 */

/** JSON-RPC のエラー。`data` に CLI の詳細文が入る（分類は `grok-errors.ts`）。 */
export interface GrokRpcError {
  code: number;
  message: string;
  data?: unknown;
}

/** stdout の 1 行（agent → client）。 */
export type GrokMessage =
  /** こちらの要求への応答。 */
  | { kind: 'response'; id: number | string; result: unknown }
  /** こちらの要求が失敗した。 */
  | { kind: 'error'; id: number | string; error: GrokRpcError }
  /** エージェントからの**要求**（許可・質問）。応答を返さないとターンが止まる。 */
  | { kind: 'request'; id: number | string; method: string; params: unknown }
  /** 一方向の通知（`session/update` ほか）。 */
  | { kind: 'notification'; method: string; params: unknown };

/** テキスト 1 かけら（`agent_message_chunk` / `agent_thought_chunk`）。 */
export interface GrokContentChunk {
  content?: { type?: string; text?: string };
}

/** ツールの素性。`_meta['x.ai/tool']` に入る（ツール名はここが唯一の出所）。 */
export interface GrokToolInfo {
  name?: string;
  kind?: string;
  label?: string;
  read_only?: boolean;
}

/** `tool_call` / `tool_call_update` の `_meta`。 */
export interface GrokToolMeta {
  'x.ai/tool'?: GrokToolInfo;
}

/** ツールの出力 1 件（テキストか差分）。 */
export interface GrokToolContent {
  type?: string;
  content?: { type?: string; text?: string };
  path?: string;
  oldText?: string;
  newText?: string;
}

/** ツール実行の状態。終端は `completed` / `failed`。 */
export type GrokToolStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

/** `plan`（= TODO リスト）の 1 項目。 */
export interface GrokPlanEntry {
  content?: string;
  status?: string;
}

/** 選べるモデル 1 件（`initialize` / `session/new` / `_x.ai/models/update`）。 */
export interface GrokModelInfo {
  modelId?: string;
  name?: string;
  description?: string;
}

/** 現在のモデルと選択肢。 */
export interface GrokModelState {
  currentModelId?: string;
  availableModels?: GrokModelInfo[];
}

/**
 * 解釈する `sessionUpdate`。ここに無いものは {@link toGrokUpdate} が捨てる
 * （CLI が新しい種別を足しても落ちないため）。
 */
export type GrokSessionUpdate =
  | ({ sessionUpdate: 'agent_message_chunk' } & GrokContentChunk)
  | ({ sessionUpdate: 'agent_thought_chunk' } & GrokContentChunk)
  | {
      sessionUpdate: 'tool_call';
      toolCallId?: string;
      title?: string;
      rawInput?: Record<string, unknown>;
      _meta?: GrokToolMeta;
    }
  | {
      sessionUpdate: 'tool_call_update';
      toolCallId?: string;
      title?: string;
      kind?: string;
      status?: GrokToolStatus;
      content?: GrokToolContent[];
      rawInput?: Record<string, unknown>;
      rawOutput?: unknown;
      _meta?: GrokToolMeta;
    }
  | { sessionUpdate: 'plan'; entries?: GrokPlanEntry[] }
  /** 再試行の実況。**終了ではない**（`type: 'failed'` でもターンは続くことがある）。 */
  | { sessionUpdate: 'retry_state'; type?: string; error_type?: string; message?: string };

/** エージェントが上げてくる許可要求（`session/request_permission`）の選択肢。 */
export interface GrokPermissionOption {
  optionId: string;
  name?: string;
  /** `allow_once` / `allow_always` / `reject_once` / `reject_always`。 */
  kind?: string;
}

/** `session/request_permission` の params。 */
export interface GrokPermissionParams {
  sessionId?: string;
  toolCall?: {
    toolCallId?: string;
    title?: string;
    kind?: string;
    rawInput?: Record<string, unknown>;
    _meta?: GrokToolMeta;
  };
  options: GrokPermissionOption[];
}

/** `_x.ai/ask_user_question` が運ぶ質問 1 件。**`header` は無い**（実測）。 */
export interface GrokQuestion {
  question?: string;
  multiSelect?: boolean;
  options?: { label?: string; description?: string }[];
}

/** `_x.ai/ask_user_question` の params。 */
export interface GrokQuestionParams {
  sessionId?: string;
  toolCallId?: string;
  questions: GrokQuestion[];
  /** `'default'` | `'plan'`。plan モードだけ追加の選択肢が出る（codiva は使わない）。 */
  mode?: string;
}

/**
 * `session/prompt` の応答。`stopReason` は ACP 標準の
 * `end_turn` / `max_tokens` / `max_turn_requests` / `refusal` / `cancelled`。
 */
export interface GrokPromptResult {
  stopReason?: string;
  _meta?: { modelId?: string };
}

/** `session/new` / `session/resume` の応答（`models` から解決済みモデルが分かる）。 */
export interface GrokSessionResult {
  sessionId?: string;
  models?: GrokModelState;
}

/** `initialize` の応答（モデルカタログの出所）。 */
export interface GrokInitializeResult {
  authMethods?: { id?: string }[];
  _meta?: {
    defaultAuthMethodId?: string | null;
    modelState?: GrokModelState;
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** JSON 1 行を {@link GrokMessage} として受理する（壊れた行は捨てる）。 */
export function toGrokMessage(value: unknown): GrokMessage | undefined {
  if (!isObject(value)) {
    return undefined;
  }
  const id = value.id;
  const method = value.method;
  const hasId = typeof id === 'number' || typeof id === 'string';
  if (typeof method === 'string') {
    return hasId
      ? { kind: 'request', id: id as number | string, method, params: value.params }
      : { kind: 'notification', method, params: value.params };
  }
  if (!hasId) {
    return undefined;
  }
  const error = value.error;
  // `error` が付いている応答は**必ずエラー**として扱う。`message` が欠けていても
  // 成功に落とすと、待っている要求が「結果 undefined の成功」で解決してしまい、
  // 失敗が turn_stopped ではなく空の完了として現れる。
  if (isObject(error)) {
    return {
      kind: 'error',
      id: id as number | string,
      error: {
        code: typeof error.code === 'number' ? error.code : 0,
        message: typeof error.message === 'string' ? error.message : 'unknown error',
        data: error.data,
      },
    };
  }
  return { kind: 'response', id: id as number | string, result: value.result };
}

/** 通知の `method` が `update` 封筒を運ぶものか（2 本のレールを 1 つに畳む）。 */
export function isGrokUpdateMethod(method: string): boolean {
  return method === 'session/update' || method === '_x.ai/session_notification';
}

/**
 * 解釈できる `sessionUpdate` だけを受理する。未知の種別・壊れた形は `undefined`
 * （`grok-parse.ts` が中身を無条件に読むので、ここを緩めると TypeError が
 * ストリームを突き抜けてターンごと死ぬ）。
 */
export function toGrokUpdate(value: unknown): GrokSessionUpdate | undefined {
  if (!isObject(value)) {
    return undefined;
  }
  const kind = value.sessionUpdate;
  if (typeof kind !== 'string') {
    return undefined;
  }
  switch (kind) {
    case 'agent_message_chunk':
    case 'agent_thought_chunk':
      return isObject(value.content) ? (value as GrokSessionUpdate) : undefined;
    case 'tool_call':
    case 'tool_call_update':
      // `content` は `toolOutputText` が **for-of で回す**ので、来ているなら
      // 「オブジェクトの配列」であることまで見る（配列でない truthy を通すと
      // for-of が TypeError を投げ、それがアダプタの generator を突き抜けて
      // **ターンのストリームごと死ぬ** = `grok` が孤児として残る）。
      return value.content === undefined ||
        (Array.isArray(value.content) && value.content.every(isObject))
        ? (value as GrokSessionUpdate)
        : undefined;
    case 'plan':
      // 各要素は `e.content` / `e.status` として無条件に読む。
      return Array.isArray(value.entries) && value.entries.every(isObject)
        ? (value as GrokSessionUpdate)
        : undefined;
    case 'retry_state':
      return typeof value.message === 'string' ? (value as GrokSessionUpdate) : undefined;
    default:
      return undefined;
  }
}

/** 通知メッセージから `update` を取り出す（両レール共通）。 */
export function grokUpdateOf(message: GrokMessage): GrokSessionUpdate | undefined {
  if (message.kind !== 'notification' || !isGrokUpdateMethod(message.method)) {
    return undefined;
  }
  const params = message.params;
  return isObject(params) ? toGrokUpdate(params.update) : undefined;
}

/** 許可要求として受理できるか（応答必須なので選択肢が要る）。 */
export function toGrokPermissionParams(value: unknown): GrokPermissionParams | undefined {
  if (!isObject(value) || !Array.isArray(value.options)) {
    return undefined;
  }
  const options = value.options.filter(
    (o): o is GrokPermissionOption => isObject(o) && typeof o.optionId === 'string',
  );
  return options.length > 0
    ? { ...(value as unknown as GrokPermissionParams), options }
    : undefined;
}

/** 質問要求として受理できるか。 */
export function toGrokQuestionParams(value: unknown): GrokQuestionParams | undefined {
  if (!isObject(value) || !Array.isArray(value.questions)) {
    return undefined;
  }
  return value as unknown as GrokQuestionParams;
}

/** モデル状態（`initialize` / `session/new` / `_x.ai/models/update`）を取り出す。 */
export function toGrokModelState(value: unknown): GrokModelState | undefined {
  if (!isObject(value)) {
    return undefined;
  }
  const models = isObject(value.models) ? value.models : value;
  const current = models.currentModelId;
  const available = models.availableModels;
  if (typeof current !== 'string' && !Array.isArray(available)) {
    return undefined;
  }
  return {
    currentModelId: typeof current === 'string' ? current : undefined,
    availableModels: Array.isArray(available)
      ? available.filter((m): m is GrokModelInfo => isObject(m))
      : undefined,
  };
}
