/**
 * `codex exec --json` が stdout へ 1 行 1 件で吐く JSONL の**形**。
 *
 * 出所は Codex CLI の `codex-rs/exec/src/exec_events.rs`（この union が唯一の定義）で、
 * 実際に採取した出力が `src/core/__fixtures__/codex-*.jsonl` にある。**想定で書かない**
 * （規約: `.claude/rules/sdk-integration.md`）。
 *
 * ここは型だけ。`AgentEvent` への写像は `core/codex-parse.ts`、状態の畳み込みは
 * 全 provider 共通の `applyAgentEvent`（`core/agent-events.ts`）。
 */

/** コマンド実行の状態。`declined` は承認が拒否されたとき（exec モードでは常に自動 reject）。 */
export type CodexCommandStatus = 'in_progress' | 'completed' | 'failed' | 'declined';

/** パッチ適用の状態。CLI 側で `declined` は `failed` へ畳まれてから出てくる。 */
export type CodexPatchStatus = 'in_progress' | 'completed' | 'failed';

/** ファイル変更の種類。 */
export type CodexPatchKind = 'add' | 'delete' | 'update';

/** MCP ツール呼び出しの状態。 */
export type CodexMcpStatus = 'in_progress' | 'completed' | 'failed';

/** `file_change` が運ぶ 1 ファイルぶんの変更。 */
export interface CodexFileUpdate {
  path: string;
  kind: CodexPatchKind;
}

/** `todo_list` が運ぶ 1 項目。Claude の TodoWrite と違い状態は真偽値だけ。 */
export interface CodexTodoItem {
  text: string;
  completed: boolean;
}

/**
 * スレッドに積まれる 1 アイテム。`id` は CLI が振る通し番号（`item_0` …）で、
 * モデル側の id ではない。`item.started` と `item.completed` の突き合わせに使う。
 */
export type CodexItem = { id: string } & (
  | { type: 'agent_message'; text: string }
  | { type: 'reasoning'; text: string }
  | {
      type: 'command_execution';
      command: string;
      aggregated_output: string;
      /** 実行中は null（省略ではなく明示的に null が入る）。 */
      exit_code: number | null;
      status: CodexCommandStatus;
    }
  | { type: 'file_change'; changes: CodexFileUpdate[]; status: CodexPatchStatus }
  | {
      type: 'mcp_tool_call';
      server: string;
      tool: string;
      status: CodexMcpStatus;
    }
  | { type: 'web_search'; query: string }
  | { type: 'todo_list'; items: CodexTodoItem[] }
  | { type: 'error'; message: string }
);

/**
 * 1 ターンぶんのトークン使用量。**USD のコストは運ばない**ので、codiva の
 * コスト表示は Codex では出せない（`CODEX_CAPABILITIES.cost = false`）。
 */
export interface CodexUsage {
  input_tokens: number;
  cached_input_tokens: number;
  /** 実測では省略されることがある（CLI 側に `serde(default)` があるため）。 */
  cache_write_input_tokens?: number;
  output_tokens: number;
  reasoning_output_tokens: number;
}

/** stdout の 1 行。 */
export type CodexEvent =
  /** 最初に必ず 1 行来る。`thread_id` が resume 用の id（`codex exec resume <id>`）。 */
  | { type: 'thread.started'; thread_id: string }
  | { type: 'turn.started' }
  | { type: 'turn.completed'; usage?: CodexUsage }
  | { type: 'turn.failed'; error: { message: string } }
  | { type: 'item.started'; item: CodexItem }
  /** 実測では `todo_list` にしか来ない（コマンド実行は started → completed の 2 段）。 */
  | { type: 'item.updated'; item: CodexItem }
  | { type: 'item.completed'; item: CodexItem }
  /**
   * ストリームが吐く単発のエラー行。**これは終了ではない** — 実測では
   * `Reconnecting... 1/5 (...)` のような**再試行の実況**が同じ型で流れてくる
   * （`__fixtures__/codex-failure.jsonl`）。ターンが本当に落ちたかどうかは
   * `turn.failed` とプロセスの終了コードでしか分からない。
   */
  | { type: 'error'; message: string };

/** そのキーが文字列か（`type` 以外の必須フィールドの検査）。 */
function hasString(value: object, key: string): boolean {
  return typeof (value as Record<string, unknown>)[key] === 'string';
}

/**
 * `item.*` が解釈できる `item` を運んでいるか。`item` の中身（`type` ごとの必須
 * フィールド）は `codex-parse.ts` 側が switch で読むので、ここでは**判別子だけ**見る。
 */
function hasItem(value: object): boolean {
  const item = (value as { item?: unknown }).item;
  return !!item && typeof item === 'object' && hasString(item, 'type');
}

/**
 * JSON 1 行を {@link CodexEvent} として受理する（壊れた行・未知の型は捨てる）。
 *
 * `type` だけでなく**その型が必ず持つフィールド**まで見る。ここを通ったものは
 * `parseCodexEvent` が中身を無条件に読む（`event.error.message` / `event.item.type`）ので、
 * 欠けた行を通すとパースが TypeError で落ち、ターンのストリームごと死ぬ。
 */
export function toCodexEvent(value: unknown): CodexEvent | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const type = (value as { type?: unknown }).type;
  if (typeof type !== 'string') {
    return undefined;
  }
  switch (type) {
    case 'thread.started':
      return hasString(value, 'thread_id') ? (value as CodexEvent) : undefined;
    case 'turn.started':
    case 'turn.completed':
      return value as CodexEvent;
    case 'turn.failed': {
      const error = (value as { error?: unknown }).error;
      return error && typeof error === 'object' && hasString(error, 'message')
        ? (value as CodexEvent)
        : undefined;
    }
    case 'item.started':
    case 'item.updated':
    case 'item.completed':
      return hasItem(value) ? (value as CodexEvent) : undefined;
    case 'error':
      return hasString(value, 'message') ? (value as CodexEvent) : undefined;
    default:
      // 未知の型は無視する（CLI が新しいイベントを足しても落ちない）。
      return undefined;
  }
}
