import type { AgentEvent, AgentToolKind, TodoOp } from './agent-events';
import { GROK_RETRY_PREFIX } from './grok-errors';
import type {
  GrokPlanEntry,
  GrokSessionUpdate,
  GrokToolContent,
  GrokToolInfo,
} from './grok-events';
import { MAX_LOG_ENTRY_CHARS } from './log-buffer';
import { isPrCreateCommand, PR_DETECT_SCAN_CHARS } from './pr-detect';
import type { TaskStatus } from './types';

/**
 * Grok の ACP 通知（`core/grok-events.ts`）の**形**を知る唯一の場所。
 * `core/claude-parse.ts` / `core/codex-parse.ts` と対になり、`GrokSessionUpdate` を
 * 中立の {@link AgentEvent} 列へ写すだけ（状態は変えない）。
 *
 * ただし Claude / Codex と違い **1 件 1 件が独立していない**: 本文は
 * `agent_message_chunk` の細切れでしか届かず、「メッセージが 1 通終わった」という
 * 区切りが通知に無い。そこで本文と思考をここで溜め、次のツール呼び出し・ターン終了
 * （= アダプタが呼ぶ {@link GrokParser.flush}）で 1 行に確定させる。
 * I/O は持たないのでテストは実データのフィクスチャだけで駆動できる。
 *
 * 形は想定で書かない — `__fixtures__/grok-*.jsonl` の実データでテストする
 * （規約: `.claude/rules/sdk-integration.md`）。
 */

/** ログ 1 行に載せる本文の上限。 */
function clip(text: string): string {
  return text.slice(0, MAX_LOG_ENTRY_CHARS);
}

/** tool_result 相当の要約に使う先頭文字数（Claude / Codex と揃える）。 */
const RESULT_SUMMARY_CHARS = 200;

/** 先頭 1 行だけを、上限付きで取り出す。 */
function firstLine(text: string): string {
  const cut = text.slice(0, RESULT_SUMMARY_CHARS);
  const br = cut.search(/[\r\n]/);
  return br === -1 ? cut : cut.slice(0, br);
}

function stringField(input: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = input?.[key];
  return typeof value === 'string' ? value : undefined;
}

/** `ask_user_question` の 1 問目の本文（無ければ undefined）。 */
function firstQuestion(input: Record<string, unknown> | undefined): string | undefined {
  const questions = input?.questions;
  if (!Array.isArray(questions) || questions.length === 0) {
    return undefined;
  }
  const first = questions[0];
  return typeof first === 'object' && first !== null
    ? stringField(first as Record<string, unknown>, 'question')
    : undefined;
}

/**
 * TODO は `plan` 通知だけから作る。`todo_write` のツール呼び出しも届くが、同じ内容を
 * 2 行に増やすだけなので捨てる（`GROK_SILENT_TOOLS`）。
 */
const GROK_SILENT_TOOLS = new Set(['todo_write']);

/** `_meta['x.ai/tool'].kind` → 中立のツール種別。 */
function toolKindOf(info: GrokToolInfo | undefined): AgentToolKind {
  switch (info?.kind) {
    case 'execute':
      return 'shell';
    case 'edit':
      return 'edit';
    case 'ask_user':
      return 'question';
    default:
      return info?.name === 'todo_write' ? 'todo' : 'other';
  }
}

/**
 * ログ 1 行ぶんの要約。**`title` をそのまま使わない** — `tool_call` 時点の title は
 * ツール名そのもの（`run_terminal_command`）で、読みやすい題（`Execute \`echo hi\``）は
 * 続く `tool_call_update` まで来ない。`rawInput` は最初から揃っているので、
 * Claude / Codex と同じ書式（`$ <command>` / `<tool> <path>`）をここで組む。
 */
function summarizeToolCall(
  info: GrokToolInfo | undefined,
  rawInput: Record<string, unknown> | undefined,
  title: string | undefined,
): string {
  const name = info?.name ?? title ?? 'tool';
  const command = stringField(rawInput, 'command');
  if (command !== undefined) {
    return clip(`$ ${command}`);
  }
  const path =
    stringField(rawInput, 'file_path') ??
    stringField(rawInput, 'target_file') ??
    stringField(rawInput, 'path');
  if (path !== undefined) {
    return clip(`${name} ${path}`);
  }
  const query = stringField(rawInput, 'query') ?? stringField(rawInput, 'pattern');
  if (query !== undefined) {
    return clip(`${name} ${query}`);
  }
  // 質問はツール名だけだと「何を聞かれたか」がログから消える（読みやすい題は
  // 後続の `tool_call_update` まで来ない）ので、1 問目の本文を出す。
  const question = firstQuestion(rawInput);
  if (question !== undefined) {
    return clip(`${name} ${question}`);
  }
  // 何も手がかりが無いときだけ CLI の題に頼る（空にはしない — 空の要約でも
  // `applyAgentEvent` は 1 行積むので、ログに空行が並ぶ）。
  return clip(title && title !== name ? title : name);
}

/** ツール出力のテキスト部分だけを連結する（差分は本文を持たない）。 */
function toolOutputText(content: readonly GrokToolContent[] | undefined): string {
  if (!content) {
    return '';
  }
  const parts: string[] = [];
  for (const item of content) {
    const text = item.content?.text;
    if (typeof text === 'string' && text.length > 0) {
      parts.push(text);
    }
  }
  return parts.join('\n');
}

/** `rawOutput.exit_code` を読む（run_terminal_command のときだけ入る）。 */
function exitCodeOf(rawOutput: unknown): number | undefined {
  if (typeof rawOutput !== 'object' || rawOutput === null) {
    return undefined;
  }
  const code = (rawOutput as { exit_code?: unknown }).exit_code;
  return typeof code === 'number' ? code : undefined;
}

/**
 * 結果のログ 1 行。失敗したときだけ終了コードを添える。出力が無い失敗で
 * 二重に書かないよう、代替文言と接尾辞は排他にする（Codex 側と同じ規則）。
 */
function resultSummary(head: string, failed: boolean, exit: number | undefined): string {
  const first = firstLine(head);
  if (!first) {
    return failed ? `failed${exit === undefined ? '' : ` (exit ${exit})`}` : '';
  }
  return failed ? `${first} (${exit === undefined ? 'failed' : `exit ${exit}`})` : first;
}

/** `plan.entries[].status` → codiva の {@link TaskStatus}。 */
function todoStatusOf(status: string | undefined): TaskStatus {
  switch (status) {
    case 'in_progress':
      return 'in_progress';
    case 'completed':
      return 'completed';
    default:
      return 'pending';
  }
}

function todoOpOf(entries: readonly GrokPlanEntry[]): TodoOp {
  // Grok の `plan` は毎回リスト全体を送るので `replace`。
  return {
    op: 'replace',
    items: entries.map((e) => ({ subject: e.content ?? '', status: todoStatusOf(e.status) })),
  };
}

/** TODO 更新のログ 1 行。**空文字にしない**（空行がログに並ぶため）。 */
function summarizePlan(entries: readonly GrokPlanEntry[]): string {
  const done = entries.filter((e) => e.status === 'completed').length;
  const next = entries.find((e) => e.status !== 'completed')?.content ?? '';
  const head = `plan ${done}/${entries.length}`;
  return clip(next ? `${head}: ${next}` : head);
}

/** ツール呼び出しの素性を覚えておくぶん（結果と突き合わせるのに要る）。 */
interface PendingTool {
  kind: AgentToolKind;
  silent: boolean;
}

/** ストリームの状態を持つパーサ。1 本の {@link AgentRun} につき 1 つ作る。 */
export interface GrokParser {
  /** 通知 1 件を中立イベント列へ写す。 */
  parse(update: GrokSessionUpdate): AgentEvent[];
  /**
   * 溜めている本文・思考を確定させる（ターンの終わり・中断時にアダプタが呼ぶ）。
   * 呼ばないとその回の本文がログに残らない。
   */
  flush(): AgentEvent[];
}

/**
 * {@link GrokParser} を作る。溜めるのは「本文」と「思考」の 2 つだけで、
 * ツールの素性（結果の突き合わせ用）を id で覚える。
 */
export function createGrokParser(): GrokParser {
  let text = '';
  let thought = '';
  /** 本文の 1 通目が始まったか（`assistant_message` は 1 通につき 1 回だけ出す）。 */
  let messageOpen = false;
  const tools = new Map<string, PendingTool>();

  /** 溜めた思考を 1 行の notice にして吐く。 */
  function flushThought(): AgentEvent[] {
    const trimmed = thought.trim();
    thought = '';
    return trimmed.length > 0 ? [{ kind: 'notice', text: clip(trimmed) }] : [];
  }

  /** 溜めた本文をログ行に確定し、ライブプレビューを畳む。 */
  function flushText(): AgentEvent[] {
    const trimmed = text.trim();
    text = '';
    if (!messageOpen) {
      return [];
    }
    messageOpen = false;
    // 本文が空（ツールだけのメッセージ）でもプレビューは畳む。
    return trimmed.length > 0
      ? [{ kind: 'assistant_text', text: clip(trimmed) }, { kind: 'stream_reset' }]
      : [{ kind: 'stream_reset' }];
  }

  return {
    parse(update: GrokSessionUpdate): AgentEvent[] {
      switch (update.sessionUpdate) {
        case 'agent_thought_chunk': {
          const chunk = update.content?.text ?? '';
          thought += chunk;
          return [];
        }

        case 'agent_message_chunk': {
          const chunk = update.content?.text ?? '';
          const events: AgentEvent[] = [];
          if (!messageOpen) {
            // 思考 → 本文の順で届くので、本文が始まった時点で思考を確定させる。
            events.push(...flushThought());
            // ターンが動いている区切り（プレビューを白紙に戻して running へ）。
            events.push({ kind: 'assistant_message' });
            messageOpen = true;
          }
          text += chunk;
          if (chunk.length > 0) {
            events.push({ kind: 'stream_text', text: chunk });
          }
          return events;
        }

        case 'tool_call': {
          const info = update._meta?.['x.ai/tool'];
          const silent = GROK_SILENT_TOOLS.has(info?.name ?? '');
          const id = update.toolCallId;
          if (id !== undefined) {
            tools.set(id, { kind: toolKindOf(info), silent });
          }
          if (silent) {
            return [];
          }
          // ツールが動く前に、それまでの本文と思考をログへ確定させる。
          const events: AgentEvent[] = [...flushText(), ...flushThought()];
          const command = stringField(update.rawInput, 'command');
          events.push({
            kind: 'tool_use',
            id,
            summary: summarizeToolCall(info, update.rawInput, update.title),
            tool: toolKindOf(info),
            // 「このセッションが出した PR」は結果にしか URL が無いので、作成コマンドの
            // id を控えて結果側と突き合わせる（core/pr-detect.ts）。
            prCreate: command !== undefined && isPrCreateCommand(command) ? true : undefined,
          });
          return events;
        }

        case 'tool_call_update': {
          const status = update.status;
          // 実行中の出力は何度も届く（`in_progress`）。ログ行は終端でだけ 1 本出す。
          if (status !== 'completed' && status !== 'failed') {
            return [];
          }
          const id = update.toolCallId;
          const pending = id === undefined ? undefined : tools.get(id);
          if (pending?.silent) {
            tools.delete(id as string);
            return [];
          }
          if (id !== undefined) {
            tools.delete(id);
          }
          const output = toolOutputText(update.content);
          // 要約は先頭 1 行だが、PR の URL は数行下に出るので少し深く読む（上限付き）。
          const head = output.slice(0, PR_DETECT_SCAN_CHARS);
          return [
            {
              kind: 'tool_result',
              toolUseId: id,
              summary: resultSummary(head, status === 'failed', exitCodeOf(update.rawOutput)),
              scanText: head,
            },
          ];
        }

        case 'plan': {
          const entries = update.entries ?? [];
          return [
            ...flushText(),
            ...flushThought(),
            {
              kind: 'tool_use',
              summary: summarizePlan(entries),
              tool: 'todo',
              todo: todoOpOf(entries),
            },
          ];
        }

        case 'retry_state': {
          // **これは終了ではない**。再接続の実況が同じ通知で来るし、本当に落ちたときは
          // `session/prompt` の応答がエラーになる（アダプタが分類する）。1 行残すだけ。
          const message = update.message ?? '';
          return [
            {
              kind: 'notice',
              text: `${GROK_RETRY_PREFIX} ${firstLine(message)}`,
              coalesceKey: GROK_RETRY_PREFIX,
            },
          ];
        }

        default:
          return [];
      }
    },

    flush(): AgentEvent[] {
      return [...flushText(), ...flushThought()];
    },
  };
}
