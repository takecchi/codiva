/**
 * Antigravity CLI（`agy --output-format stream-json`）の**線上の形**と受理ガード。
 *
 * ここが Antigravity 固有の JSON を知ってよい唯一の場所で、下流（`antigravity-parse.ts`）
 * は生の `unknown` を一切読まない。`codex-events.ts` / `grok-events.ts` と同じ役割。
 *
 * **実測（agy 1.2.10, darwin/arm64）**: stream-json は 3 種類の `event` しか出さない
 * （`init` / `step_update` / `result`）。未認証で走らせて実際に採れた 1 行:
 *
 * ```json
 * {"event":"result","result":{"conversation_id":"","status":"ERROR","response":"",
 *  "error":"authentication failed or timed out","duration_seconds":0,"num_turns":0,
 *  "usage":{"input_tokens":0,"output_tokens":0,"thinking_tokens":0,
 *           "cache_read_tokens":0,"total_tokens":0}}}
 * ```
 *
 * この 1 行は公式ドキュメントの `result` スキーマと**フィールド単位で完全に一致**した
 * ので、まだ実採取できていない `init` / `step_update` も同ドキュメントの形を採用して
 * いる（認証が要るため。`docs/TECH_NOTES.md` の Antigravity 節に採取状況を記録）。
 * ただし**すべてのフィールドを optional**として扱い、欠けても落ちないようにする —
 * 実データで確かめきれていないぶんは「読めなければ無視」へ倒すのが安全側。
 */

/** トークン使用量。USD のコストは運ばないので `capabilities.cost` は false。 */
export interface AntigravityUsage {
  input_tokens?: number;
  output_tokens?: number;
  thinking_tokens?: number;
  cache_read_tokens?: number;
  total_tokens?: number;
}

/** ツール 1 回ぶんの情報（`step_type: 'tool'` の step に載る）。 */
export interface AntigravityToolInfo {
  name?: string;
  parameters?: Record<string, unknown>;
  output?: string;
}

/** サブエージェント 1 件の記述子（MVP では読まない — `capabilities.subagents` は false）。 */
export interface AntigravitySubagentDescriptor {
  type_name?: string;
  role?: string;
  conversation_id?: string;
  log_uri?: string;
  workspace_uris?: readonly string[];
}

/**
 * step の状態。`ACTIVE` は「まだ動いている」、`DONE` は「その step が終わった」。
 * **知らない値は `ACTIVE` 側に倒す**（決着と誤認して早すぎる確定を出さない）。
 */
export type AntigravityStepState = 'ACTIVE' | 'DONE';

/** step の種別。`agent_response` が本文、`tool` がツール実行。 */
export type AntigravityStepType = 'user_input' | 'agent_response' | 'tool' | 'checkpoint';

export interface AntigravityStepUpdate {
  conversation_id?: string;
  step_index?: number;
  state?: string;
  step_type?: string;
  /** 本文の増分（`agent_response` の step に届く）。 */
  text_delta?: string;
  duration_seconds?: number;
  usage?: AntigravityUsage;
  tool_name?: string;
  tool_info?: AntigravityToolInfo;
  subagent_info?: { subagents?: readonly AntigravitySubagentDescriptor[] };
}

export interface AntigravityInit {
  cwd?: string;
  tools?: readonly string[];
  permission_mode?: string;
  model?: string;
  agent?: string;
}

/**
 * ターンの決着。`SUCCESS` 以外は `turn_stopped` へ写す。
 * `WAITING` / `RUNNING` は終端ではないので**決着として扱わない**。
 */
export type AntigravityResultStatus =
  | 'SUCCESS'
  | 'ERROR'
  | 'CANCELED'
  | 'INTERRUPTED'
  | 'INVALID'
  | 'WAITING'
  | 'RUNNING';

export interface AntigravityResult {
  conversation_id?: string;
  status?: string;
  response?: string;
  error?: string;
  duration_seconds?: number;
  num_turns?: number;
  usage?: AntigravityUsage;
  structured_output?: unknown;
}

/** stream-json の 1 行。 */
export type AntigravityEvent =
  | { event: 'init'; conversation_id?: string; init?: AntigravityInit }
  | { event: 'step_update'; conversation_id?: string; step_update?: AntigravityStepUpdate }
  | { event: 'result'; conversation_id?: string; result?: AntigravityResult };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function strArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.filter((v): v is string => typeof v === 'string');
}

function toUsage(value: unknown): AntigravityUsage | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  return {
    input_tokens: num(value.input_tokens),
    output_tokens: num(value.output_tokens),
    thinking_tokens: num(value.thinking_tokens),
    cache_read_tokens: num(value.cache_read_tokens),
    total_tokens: num(value.total_tokens),
  };
}

function toToolInfo(value: unknown): AntigravityToolInfo | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  return {
    name: str(value.name),
    parameters: isRecord(value.parameters) ? value.parameters : undefined,
    output: str(value.output),
  };
}

function toSubagentInfo(
  value: unknown,
): { subagents?: readonly AntigravitySubagentDescriptor[] } | undefined {
  if (!isRecord(value) || !Array.isArray(value.subagents)) {
    return undefined;
  }
  const subagents = value.subagents.filter(isRecord).map((entry) => ({
    type_name: str(entry.type_name),
    role: str(entry.role),
    conversation_id: str(entry.conversation_id),
    log_uri: str(entry.log_uri),
    workspace_uris: strArray(entry.workspace_uris),
  }));
  return { subagents };
}

/**
 * 1 行ぶんの JSON を受理する。**読めない行は undefined**（TUI を落とさない）。
 *
 * `event` が未知の名前でも捨てる — CLI 側がイベントを増やしたときに、知らない形を
 * 下流へ流して壊すより 1 行落とすほうが安全（`toCodexEvent` と同じ方針）。
 */
export function toAntigravityEvent(raw: unknown): AntigravityEvent | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  const conversationId = str(raw.conversation_id);
  switch (raw.event) {
    case 'init': {
      const init = isRecord(raw.init) ? raw.init : undefined;
      return {
        event: 'init',
        conversation_id: conversationId,
        init: init && {
          cwd: str(init.cwd),
          tools: strArray(init.tools),
          permission_mode: str(init.permission_mode),
          model: str(init.model),
          agent: str(init.agent),
        },
      };
    }
    case 'step_update': {
      const step = isRecord(raw.step_update) ? raw.step_update : undefined;
      return {
        event: 'step_update',
        conversation_id: conversationId,
        step_update: step && {
          conversation_id: str(step.conversation_id),
          step_index: num(step.step_index),
          state: str(step.state),
          step_type: str(step.step_type),
          text_delta: str(step.text_delta),
          duration_seconds: num(step.duration_seconds),
          usage: toUsage(step.usage),
          tool_name: str(step.tool_name),
          tool_info: toToolInfo(step.tool_info),
          subagent_info: toSubagentInfo(step.subagent_info),
        },
      };
    }
    case 'result': {
      const result = isRecord(raw.result) ? raw.result : undefined;
      return {
        event: 'result',
        conversation_id: conversationId,
        result: result && {
          conversation_id: str(result.conversation_id),
          status: str(result.status),
          response: str(result.response),
          error: str(result.error),
          duration_seconds: num(result.duration_seconds),
          num_turns: num(result.num_turns),
          usage: toUsage(result.usage),
          structured_output: result.structured_output,
        },
      };
    }
    default:
      return undefined;
  }
}

/**
 * その `event` の conversation id（`result` / `step_update` は入れ子側にも持つ）。
 * 空文字は id ではないので undefined に丸める（未認証の `result` が実際に `""` を返す）。
 */
export function antigravityConversationId(event: AntigravityEvent): string | undefined {
  const nested =
    event.event === 'result'
      ? event.result?.conversation_id
      : event.event === 'step_update'
        ? event.step_update?.conversation_id
        : undefined;
  const id = nested || event.conversation_id;
  return id && id.length > 0 ? id : undefined;
}
