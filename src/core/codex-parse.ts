import type { AgentEvent, TodoOp } from './agent-events';
import { classifyCodexError, isCodexRetryNotice } from './codex-errors';
import type { CodexEvent, CodexItem } from './codex-events';
import { MAX_LOG_ENTRY_CHARS } from './log-buffer';
import { isPrCreateCommand, PR_DETECT_SCAN_CHARS } from './pr-detect';

/**
 * Codex の JSONL（`core/codex-events.ts`）の**形**を知る唯一の場所。
 * `core/claude-parse.ts` と対になる純関数で、`CodexEvent` を中立の {@link AgentEvent} 列へ
 * 写すだけ。状態をどう変えるかは持たない（畳み込みは全 provider 共通の `applyAgentEvent`）。
 *
 * 形は想定で書かない — `__fixtures__/codex-*.jsonl` の実データでテストする
 * （規約: `.claude/rules/sdk-integration.md`）。
 */

/** ログ 1 行に載せるコマンド本文の上限（ヒアドキュメントで巨大になりうる）。 */
function clip(text: string): string {
  return text.slice(0, MAX_LOG_ENTRY_CHARS);
}

/** tool_result 相当の要約に使う先頭文字数（Claude 側と揃える）。 */
const RESULT_SUMMARY_CHARS = 200;

/** 先頭 1 行だけを、上限付きで取り出す。 */
function firstLine(text: string): string {
  const cut = text.slice(0, RESULT_SUMMARY_CHARS);
  const br = cut.search(/[\r\n]/);
  return br === -1 ? cut : cut.slice(0, br);
}

/**
 * `todo_list` を中立の {@link TodoOp} へ。Codex は真偽値しか持たない（`in_progress` が無い）
 * ので、完了/未完了の 2 値へ落とす。毎回リスト全体が届くので `replace`。
 */
function todoOpOf(items: readonly { text: string; completed: boolean }[]): TodoOp {
  return {
    op: 'replace',
    items: items.map((t) => ({
      subject: t.text,
      status: t.completed ? ('completed' as const) : ('pending' as const),
    })),
  };
}

/**
 * TODO 更新のログ 1 行。**空文字にしてはいけない** — `applyAgentEvent` の `tool_use` は
 * 要約が空でも必ず 1 行積むので、空のまま渡すとログに空行が並ぶ。
 */
function summarizeTodo(items: readonly { text: string; completed: boolean }[]): string {
  const done = items.filter((t) => t.completed).length;
  const next = items.find((t) => !t.completed)?.text ?? '';
  const head = `update_plan ${done}/${items.length}`;
  return clip(next ? `${head}: ${next}` : head);
}

/** TODO リストの更新イベント（進捗 + ログ 1 行）。 */
function todoEvent(item: {
  id: string;
  items: readonly { text: string; completed: boolean }[];
}): AgentEvent {
  return {
    kind: 'tool_use',
    id: item.id,
    summary: summarizeTodo(item.items),
    tool: 'todo',
    todo: todoOpOf(item.items),
  };
}

/** `file_change` のログ 1 行ぶんの要約（`apply_patch add path, update path2`）。 */
function summarizeFileChange(changes: readonly { path: string; kind: string }[]): string {
  const parts = changes.map((c) => `${c.kind} ${c.path}`);
  return clip(`apply_patch ${parts.join(', ')}`);
}

/**
 * アイテムが「始まった」ことを写す。codiva のログは Claude の tool_use / tool_result の
 * 2 段組みが基準なので、Codex の started / completed をそこへ合わせる。
 */
function fromItemStarted(item: CodexItem): AgentEvent[] {
  switch (item.type) {
    case 'command_execution':
      return [
        {
          kind: 'tool_use',
          id: item.id,
          summary: clip(`$ ${item.command}`),
          tool: 'shell',
          // 「このセッションが出した PR」は結果にしか URL が無いので、作成コマンドの
          // id を控えて completed 側と突き合わせる（core/pr-detect.ts）。
          prCreate: isPrCreateCommand(item.command) || undefined,
        },
      ];
    case 'file_change':
      return [
        {
          kind: 'tool_use',
          id: item.id,
          summary: summarizeFileChange(item.changes),
          tool: 'edit',
        },
      ];
    case 'mcp_tool_call':
      return [
        {
          kind: 'tool_use',
          id: item.id,
          summary: clip(`${item.server}/${item.tool}`),
          tool: 'other',
        },
      ];
    case 'web_search':
      return [
        { kind: 'tool_use', id: item.id, summary: clip(`web_search ${item.query}`), tool: 'other' },
      ];
    case 'todo_list':
      return [todoEvent(item)];
    default:
      return [];
  }
}

/**
 * コマンド結果のログ 1 行。失敗したときだけ終了コードを添える。**出力が無い失敗のときに
 * 二重に書かない**（`exited 3 (exit 3)` にならないよう、代替文言と接尾辞は排他にする）。
 */
function commandSummary(first: string, failed: boolean, exit: number | null): string {
  if (!first) {
    return failed ? `exited ${exit ?? '?'}` : '';
  }
  return failed ? `${first} (exit ${exit ?? '?'})` : first;
}

/** アイテムが「終わった」ことを写す。 */
function fromItemCompleted(item: CodexItem): AgentEvent[] {
  switch (item.type) {
    case 'agent_message':
      return [{ kind: 'assistant_text', text: item.text }];
    case 'reasoning':
      // 推論の要約。Codex の exec JSON には増分テキストが無く、これが唯一の
      // 「作業中に何か出る」信号なので、system 行として薄く残す。
      return item.text.trim().length > 0 ? [{ kind: 'notice', text: item.text }] : [];
    case 'command_execution': {
      const output = item.aggregated_output ?? '';
      // ログ用の要約は先頭 1 行だが、PR の URL は数行下に出るので少し深く読む（上限付き）。
      const head = output.slice(0, PR_DETECT_SCAN_CHARS);
      const failed = item.status === 'failed' || item.status === 'declined';
      return [
        {
          kind: 'tool_result',
          toolUseId: item.id,
          summary: commandSummary(firstLine(head), failed, item.exit_code),
          scanText: head,
        },
      ];
    }
    case 'file_change':
      return [
        {
          kind: 'tool_result',
          toolUseId: item.id,
          summary: item.status === 'completed' ? '' : `apply_patch ${item.status}`,
        },
      ];
    case 'mcp_tool_call':
      return [
        {
          kind: 'tool_result',
          toolUseId: item.id,
          summary: item.status === 'completed' ? '' : `${item.tool} ${item.status}`,
        },
      ];
    case 'todo_list':
      // `item.completed` は直前の `item.updated` と同じリストを繰り返すだけなので
      // ログ行は増やさない（進捗は既に反映済み）。
      return [];
    case 'error':
      // アイテム単位のエラー（モデル設定不正など）。ターンはまだ終わっていない。
      return [{ kind: 'notice', text: item.message }];
    default:
      return [];
  }
}

/**
 * 再試行の実況をまとめる接頭辞（連発するので直前の同種行を書き換える）。
 * `applyAgentEvent` の畳み込みは `startsWith` で**大小を区別する**ので、
 * 実際に届く文言（`Reconnecting... 1/5 (...)`）と同じ綴りにする。
 */
const RETRY_PREFIX = 'Reconnecting';

/**
 * Codex のイベント 1 件を中立イベント列へ写す。**アダプタの入口**。
 * 状態は見ない（純粋・イベント単位で決まる）。
 */
export function parseCodexEvent(event: CodexEvent): AgentEvent[] {
  switch (event.type) {
    case 'thread.started':
      // resume に使う id。ターンごとにプロセスを起こす Codex では、
      // resume した回も**同じ id** で再度届く（＝ no-op になる）。
      return [{ kind: 'session_started', sessionId: event.thread_id }];

    case 'turn.started':
      // ターンが動き出した = running へ戻す区切り（Claude の assistant_message と同じ役）。
      return [{ kind: 'assistant_message' }];

    case 'item.started':
      return fromItemStarted(event.item);

    case 'item.updated':
      // 実測では `todo_list` にしか来ない（コマンド実行は started → completed の 2 段）。
      return event.item.type === 'todo_list' ? [todoEvent(event.item)] : [];

    case 'item.completed':
      return fromItemCompleted(event.item);

    case 'turn.completed':
      // 結果テキストは最後の `agent_message` として既にログへ積んである（Codex の
      // `turn.completed` は本文を運ばない）ので、空文字で完了だけを伝える。
      // **コストは運ばない** — usage はトークン数だけで USD が無い。
      return [{ kind: 'turn_completed', text: '' }];

    case 'turn.failed':
      // ターンが本当に落ちた唯一の信号（`error` 行は再試行の実況でしかない）。
      // 認証切れ / レート制限 / 通信断の見分けは Codex 固有の知識なので
      // `classifyCodexError` に閉じ込める（状態機械は分類結果しか見ない）。
      return [
        {
          kind: 'turn_stopped',
          cause: classifyCodexError(event.error.message),
          detail: event.error.message,
        },
      ];

    case 'error':
      // **これは終了ではない**。再試行の実況（`Reconnecting... 1/5`）が同じ型で来るし、
      // 本当に落ちたときは直後に `turn.failed` が同じ文言で届く。ここでは 1 行残すだけ。
      return [
        {
          kind: 'notice',
          text: event.message,
          coalesceKey: isCodexRetryNotice(event.message) ? RETRY_PREFIX : undefined,
        },
      ];

    default:
      return [];
  }
}
