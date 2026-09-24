import type { AgentEvent } from './agent-events';
import { classifyAntigravityError } from './antigravity-errors';
import {
  type AntigravityEvent,
  type AntigravityStepUpdate,
  antigravityConversationId,
} from './antigravity-events';
import { MAX_LOG_ENTRY_CHARS } from './log-buffer';
import { isPrCreateCommand, PR_DETECT_SCAN_CHARS } from './pr-detect';
import type { AgentToolKind } from './types';

/**
 * Antigravity の stream-json（`core/antigravity-events.ts`）の**形**を知る唯一の場所。
 * `codex-parse.ts` / `grok-parse.ts` と対で、`AntigravityEvent` を中立の
 * {@link AgentEvent} 列へ写すだけ。状態遷移は持たない（畳み込みは共通の `applyAgentEvent`）。
 *
 * **Grok と同じく状態を持つ**（`createAntigravityParser`）。理由は step が
 * 「同じ `step_index` に対する ACTIVE の連打 → DONE」という形で届くため:
 * - 本文（`agent_response`）は `text_delta` の積み上げなので、DONE まで溜めて
 *   確定した 1 件の `assistant_text` にする必要がある。
 * - ツール（`tool`）は開始と結果が同じ step の ACTIVE / DONE に分かれるので、
 *   codiva のログが基準にしている tool_use ↔ tool_result の 2 段組みへ割り直す。
 */

/** ログ 1 行に載せる本文の上限。 */
function clip(text: string): string {
  return text.slice(0, MAX_LOG_ENTRY_CHARS);
}

/** tool_result 相当の要約に使う先頭文字数（他 provider と揃える）。 */
const RESULT_SUMMARY_CHARS = 200;

/** 先頭 1 行だけを、上限付きで取り出す。 */
function firstLine(text: string): string {
  const cut = text.slice(0, RESULT_SUMMARY_CHARS);
  const br = cut.search(/[\r\n]/);
  return br === -1 ? cut : cut.slice(0, br);
}

/**
 * Antigravity のツール名 → 中立の {@link AgentToolKind}。
 *
 * 名前は**実バイナリから採取**した（`strings agy | grep ...`、agy 1.2.10）:
 * `run_command` / `command_status` / `view_file` / `view_code_item` / `read_url_content` /
 * `edit_file` / `create_file` / `write_to_file` / `grep_search` / `list_dir` /
 * `search_web` / `ask_permission` / `suggested_responses` / `browser_*`。
 *
 * 種類は「まとめ行に出したい粒度」で切ってあるので（`core/log-collapse.ts`）、
 * 分かる範囲で `read` / `search` まで写し、分からないものは `other` にする。
 * **接頭辞・部分一致で見る** — CLI 側でツールが増えても近い種類へ寄せるため。
 */
export function antigravityToolKind(name: string | undefined): AgentToolKind {
  if (!name) {
    return 'other';
  }
  const n = name.toLowerCase();
  if (n.includes('todo') || n.includes('task_list') || n.includes('plan')) {
    return 'todo';
  }
  // 「書く」を先に見る（`write_to_file` は `file` を含むので読み取り判定に食われる）。
  if (
    n.startsWith('edit') ||
    n.startsWith('create_file') ||
    n.startsWith('write') ||
    n.includes('replace_file') ||
    n.includes('apply_patch')
  ) {
    return 'edit';
  }
  if (n.startsWith('run_command') || n.startsWith('command_') || n.includes('terminal')) {
    return 'shell';
  }
  if (
    n.includes('search') ||
    n.startsWith('grep') ||
    n.startsWith('list_dir') ||
    n.startsWith('find_')
  ) {
    return 'search';
  }
  if (n.startsWith('view') || n.startsWith('read') || n.startsWith('open_document')) {
    return 'read';
  }
  return 'other';
}

/**
 * ツール入力から「ログ 1 行に出す代表の値」を選ぶ。
 *
 * Antigravity のパラメータは Windsurf 系の **PascalCase**（実測のドキュメント例:
 * `{"CommandLine":"echo hello"}`）。既知のキーを優先順に見て、当たらなければ
 * 最初の文字列値へ落とす（未知のツールでも空行にしない）。
 */
const PRIMARY_PARAM_KEYS = [
  'CommandLine',
  'Command',
  'AbsolutePath',
  'TargetFile',
  'FilePath',
  'Path',
  'Query',
  'SearchTerm',
  'Url',
  'DirectoryPath',
];

function primaryParam(parameters: Record<string, unknown> | undefined): string | undefined {
  if (!parameters) {
    return undefined;
  }
  for (const key of PRIMARY_PARAM_KEYS) {
    const value = parameters[key];
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }
  for (const value of Object.values(parameters)) {
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

/** シェル実行はコマンドそのもの、それ以外は `<tool> <代表の値>`。 */
function summarizeTool(name: string | undefined, kind: AgentToolKind, arg: string | undefined) {
  if (kind === 'shell' && arg) {
    return clip(`$ ${arg}`);
  }
  const label = name ?? 'tool';
  return clip(arg ? `${label} ${arg}` : label);
}

/** その step が「終わった」か。**知らない値は ACTIVE 側**（早すぎる確定を出さない）。 */
function isDone(state: string | undefined): boolean {
  return state === 'DONE';
}

/** 1 つの step について覚えておくこと。 */
interface StepMemo {
  type: string;
  /** `agent_response` の積み上げ本文。 */
  text: string;
  /** `tool_use` を既に出したか（ACTIVE が複数回届くので 1 回に絞る）。 */
  opened: boolean;
  /** 既に決着させたか（DONE が複数回届いても 2 度出さない）。 */
  settled: boolean;
}

/** `step_index` が無い実装に備えた合成キー。 */
const NO_INDEX = -1;

export function createAntigravityParser(): {
  parse(event: AntigravityEvent): AgentEvent[];
  /** ストリーム終端。DONE を貰えなかった step を確定させる。 */
  flush(): AgentEvent[];
} {
  const steps = new Map<number, StepMemo>();
  /** 最後に報告した conversation id（同じ id で `session_started` を繰り返さない）。 */
  let reportedSessionId: string | undefined;
  /** このターンで `assistant_text` を出したか（`result.response` の二重掲載を避ける）。 */
  let emittedAssistantText = false;

  const toolId = (index: number) => `step-${index}`;

  /** 未確定の step を全部閉じる（ターン終端・ストリーム終端）。 */
  const closeAll = (): AgentEvent[] => {
    const out: AgentEvent[] = [];
    for (const [index, memo] of steps) {
      if (memo.settled) {
        continue;
      }
      if (memo.type === 'agent_response') {
        const text = memo.text.trim();
        if (text.length > 0) {
          out.push({ kind: 'assistant_text', text: clip(text) });
          emittedAssistantText = true;
        }
      } else if (memo.type === 'tool' && memo.opened) {
        // 開いたままのツールは結果行だけ閉じる（対応が取れないと畳み込みが崩れる）。
        out.push({ kind: 'tool_result', toolUseId: toolId(index), summary: '' });
      }
    }
    steps.clear();
    return out;
  };

  const onStep = (step: AntigravityStepUpdate): AgentEvent[] => {
    const out: AgentEvent[] = [];
    const index = step.step_index ?? NO_INDEX;
    const type = step.step_type ?? '';
    // ユーザー発話は codiva 側が既にログへ積んでいる。チェックポイントは表示しない。
    if (type === 'user_input' || type === 'checkpoint') {
      return out;
    }

    let memo = steps.get(index);
    if (!memo) {
      memo = { type, text: '', opened: false, settled: false };
      steps.set(index, memo);
    }
    if (memo.settled) {
      return out;
    }

    if (type === 'agent_response') {
      if (!memo.opened) {
        memo.opened = true;
        // 新しいアシスタントメッセージ = ライブプレビューを白紙に戻し、running へ。
        out.push({ kind: 'stream_reset' }, { kind: 'assistant_message' });
      }
      if (step.text_delta) {
        memo.text += step.text_delta;
        out.push({ kind: 'stream_text', text: step.text_delta });
      }
      if (isDone(step.state)) {
        // **記録は消さない**（`settled` を立てるだけ）。消すと同じ DONE が 2 回届いた
        // ときに新しい memo が作られ、確定済みの本文をもう一度積んでしまう。
        // 溜まりっぱなしにはならない — `closeAll()` がターンの決着ごとに全部捨てる。
        memo.settled = true;
        const text = memo.text.trim();
        if (text.length > 0) {
          out.push({ kind: 'assistant_text', text: clip(text) });
          emittedAssistantText = true;
        }
      }
      return out;
    }

    if (type === 'tool') {
      const name = step.tool_name ?? step.tool_info?.name;
      const kind = antigravityToolKind(name);
      if (!memo.opened) {
        memo.opened = true;
        const arg = primaryParam(step.tool_info?.parameters);
        out.push({
          kind: 'tool_use',
          id: toolId(index),
          summary: summarizeTool(name, kind, arg),
          tool: kind,
          // 「このセッションが出した PR」は結果にしか URL が無いので、作成コマンドの
          // id を控えて結果側と突き合わせる（core/pr-detect.ts）。
          prCreate: (kind === 'shell' && arg && isPrCreateCommand(arg)) || undefined,
        });
      }
      if (isDone(step.state)) {
        // 本文と同じ理由で記録は残す（DONE の重複で結果行を 2 度出さない）。
        memo.settled = true;
        const output = step.tool_info?.output ?? '';
        // ログ用の要約は先頭 1 行だが、PR の URL は数行下に出るので少し深く読む（上限付き）。
        const head = output.slice(0, PR_DETECT_SCAN_CHARS);
        out.push({
          kind: 'tool_result',
          toolUseId: toolId(index),
          summary: firstLine(head),
          scanText: head,
        });
      }
      return out;
    }

    return out;
  };

  return {
    parse(event: AntigravityEvent): AgentEvent[] {
      const out: AgentEvent[] = [];
      const conversationId = antigravityConversationId(event);

      switch (event.event) {
        case 'init': {
          reportedSessionId = conversationId;
          out.push({
            kind: 'session_started',
            sessionId: conversationId,
            // `--model` を明示していないと空で来る。空文字はモデル名ではない。
            model: event.init?.model || undefined,
          });
          return out;
        }

        case 'step_update': {
          // `init` を取りこぼしても resume 用の id を拾えるようにする（保険）。
          if (conversationId && conversationId !== reportedSessionId) {
            reportedSessionId = conversationId;
            out.push({ kind: 'session_started', sessionId: conversationId });
          }
          const step = event.step_update;
          return step ? out.concat(onStep(step)) : out;
        }

        case 'result': {
          const result = event.result;
          // **終端イベントより先に** id を確定させる（`session_started` は status を
          // `running` に戻すので、順番を逆にすると完了が巻き戻る）。
          if (conversationId && conversationId !== reportedSessionId) {
            reportedSessionId = conversationId;
            out.push({ kind: 'session_started', sessionId: conversationId });
          }
          // 開いたままの step を閉じてから決着させる。
          out.push(...closeAll());

          const status = result?.status ?? '';
          // 終端ではない状態（実測の schema に `WAITING` / `RUNNING` がある）は
          // ターンの決着として扱わない。
          if (status === 'WAITING' || status === 'RUNNING') {
            return out;
          }
          if (status === 'SUCCESS') {
            const response = result?.response ?? '';
            out.push({
              kind: 'turn_completed',
              // 既に `assistant_text` として積んであるぶんは渡さない（`completeTurn`
              // 側にもエコー除けはあるが、こちらで分かるなら渡さないほうが確実）。
              text: emittedAssistantText ? '' : response,
            });
            emittedAssistantText = false;
            return out;
          }
          const detail = result?.error?.trim() || `agy turn ${status || 'failed'}`;
          out.push({
            kind: 'turn_stopped',
            // **CANCELED / INTERRUPTED は失敗ではない**。`--conversation <id>` で
            // 続けられるので resumable な床（`connection`）へ落とす — `failed` は
            // 終端なので、そこへ丸めると再開の導線が消える（codex-adapter が
            // 終端イベント無しの死に方でやっているのと同じ考え方）。
            cause:
              status === 'CANCELED' || status === 'INTERRUPTED'
                ? 'connection'
                : classifyAntigravityError(detail),
            detail,
          });
          emittedAssistantText = false;
          return out;
        }

        default:
          return out;
      }
    },

    flush(): AgentEvent[] {
      return closeAll();
    },
  };
}
