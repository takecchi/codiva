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

/**
 * JSONL の枠切り（純粋）。`codex exec` の stdout は行区切りの JSON だが、チャンクは
 * 行の途中で切れるし、`command_execution` は `aggregated_output` を丸ごと 1 行で運ぶ
 * ので巨大にもなる。プロセスの扱い（`utils/codex.ts`）と分けてここに置くのは、
 * **この framing こそテストしたい部分**だから（部分行・CRLF・末尾行・上限超過）。
 *
 * `maxLineChars` を超えた行は**捨てて次の改行まで読み飛ばす**。溜め切ってから
 * `JSON.parse` すると同じものが 2 部ヒープに載る（このリポジトリは同種の積み上げで
 * 実際に OOM している）ので、1 イベントを失うほうを選ぶ。
 */
export function createJsonlSplitter(maxLineChars: number): {
  /** チャンクを流し込み、確定した JSON 値を返す（壊れた行・空行は落ちる）。 */
  push(chunk: string): unknown[];
  /** ストリーム終端。改行で終わっていない最後の行を確定させる。 */
  flush(): unknown[];
} {
  let buffer = '';
  // 「今の行が長すぎるので次の改行まで捨てる」状態。
  let skipping = false;

  const take = (line: string, out: unknown[]): void => {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      return;
    }
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      // JSONL 以外の行（想定外）は捨てる。TUI を落とさない。
    }
  };

  return {
    push(chunk: string): unknown[] {
      const out: unknown[] = [];
      buffer += chunk;
      let nl = buffer.indexOf('\n');
      while (nl !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (skipping) {
          skipping = false;
        } else {
          take(line, out);
        }
        nl = buffer.indexOf('\n');
      }
      if (buffer.length > maxLineChars) {
        buffer = '';
        skipping = true;
      }
      return out;
    },
    flush(): unknown[] {
      const out: unknown[] = [];
      if (!skipping) {
        take(buffer, out);
      }
      buffer = '';
      skipping = false;
      return out;
    },
  };
}

/** そのキーが文字列か（`type` 以外の必須フィールドの検査）。 */
function hasString(value: object, key: string): boolean {
  return typeof (value as Record<string, unknown>)[key] === 'string';
}

/**
 * `item.*` が解釈できる `item` を運んでいるか。判別子（`type`）に加えて、
 * **`codex-parse.ts` が無条件に配列として触るフィールド**まで検査する
 * （`file_change.changes` / `todo_list.items`）。ここを通すと向こうで
 * `undefined.map(...)` になり、TypeError がアダプタの generator を突き抜けて
 * **ターンのストリームごと死ぬ**（そして `codex exec` が孤児として残る）。
 */
function hasItem(value: object): boolean {
  const item = (value as { item?: unknown }).item;
  if (!item || typeof item !== 'object' || !hasString(item, 'type')) {
    return false;
  }
  const detail = item as { type: string; changes?: unknown; items?: unknown };
  if (detail.type === 'file_change') {
    return Array.isArray(detail.changes);
  }
  if (detail.type === 'todo_list') {
    return Array.isArray(detail.items);
  }
  return true;
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
