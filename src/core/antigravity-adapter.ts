import type { AgentEvent } from './agent-events';
import { attachHandoff } from './agent-handoff';
import type {
  AgentAdapter,
  AgentAvailability,
  AgentCapabilities,
  AgentRun,
  AgentRunRequest,
} from './agent-ports';
import { classifyAntigravityError } from './antigravity-errors';
import { type AntigravityEvent, toAntigravityEvent } from './antigravity-events';
import { createAntigravityParser } from './antigravity-parse';
import type { EffortLevel, PermissionMode } from './config';

/**
 * Antigravity CLI（`agy --input-format stream-json --output-format stream-json`）用の
 * {@link AgentAdapter}。
 *
 * プロセスの粒度は **1 セッション = 1 プロセス**（Grok と同じ側）。`agy` は
 * stdin から NDJSON を 1 行受け取るたびに 1 ターンを走らせ、同じ `conversation_id` を
 * 共有し続ける。ただし Grok のような双方向 RPC ではなく**ただの行ストリーム**なので、
 * 要求 ↔ 応答の対応表は要らない（`core/jsonl.ts` の枠切りだけ共用する）。
 *
 * **ターンは直列化する**（1 指示 → `result` を見る → 次の指示）。CLI 側も 1 行 1 ターンで
 * 順に処理するので投げっぱなしでも動くが、直列にしておくと (1) プロセスが死んだときに
 * 書き損じた指示を失わない、(2) `AsyncQueue.pending` に積み残しが残るのでエージェント
 * 切替時に `drain()` で新しいエージェントへ渡せる（`.claude/rules/session-domain.md`）、
 * の 2 つが成り立つ。
 *
 * **許可要求は上げられない**（`capabilities.permissions` は false）。headless の `agy` は
 * 許可ポリシーを CLI 内部で処理し、個々の tool call を外部へ中継する仕組みを持たない。
 * ここで「それらしい許可ダイアログ」を出すとユーザーが許可したのに実際は別の判断が
 * 行われるという嘘になるので、出さない側に倒して安全弁は `--mode` に寄せる。
 */

/** 1 セッションぶんの `agy` を起動するための入力（I/O 実装は `utils/antigravity.ts`）。 */
export interface AntigravitySpawnRequest {
  /** セッションの worktree。 */
  cwd: string;
  /** 継続する会話 id。あれば `--conversation <id>` が付く。 */
  resume?: string;
  model?: string;
  effort?: EffortLevel;
  /** codiva の許可モード。`--mode` / `--dangerously-skip-permissions` へ写す。 */
  permissionMode?: PermissionMode;
}

/**
 * 起動中の `agy` プロセス。stdout の NDJSON を 1 行 1 オブジェクトで流し、
 * stdin へ 1 行ずつ指示を書く。
 */
export interface AntigravityProcess extends AsyncIterable<unknown> {
  /** 指示を 1 行送る（NDJSON。改行はこちらで付ける）。 */
  send(message: unknown): void;
  /** stdin を閉じる（これ以上ターンを送らない）。 */
  endInput(): void;
  /**
   * まだ生きているか。**ターンとターンの合間に死んだプロセスを検出する**ために要る:
   * `result` を見て読むのをやめたあとは誰も stdout を待っていないので、そこで死んでも
   * アダプタは気付けない。気付かずに次の指示を書くと EPIPE で黙って捨てられ、
   * ユーザーには「送ったのに何も起きない」ターンとして見える。
   */
  alive(): boolean;
  /** プロセスを殺す（`Ctrl+C` / 破棄）。 */
  kill(): void;
  /** 終了コードと stderr の末尾。ストリームを最後まで読んだあとに呼ぶ。 */
  result(): { code: number | null; stderr: string };
}

/** `agy` を起動する I/O 境界（DI。テストはフェイクを注入する）。 */
export type AntigravitySpawn = (request: AntigravitySpawnRequest) => AntigravityProcess;

/**
 * Antigravity ができること。`NO_CAPABILITIES` から始めて、実装できたものだけ true にする。
 *
 * - `permissions`: **false**。headless は許可要求を外部へ中継できない（上記）。
 * - `setModel` / `modelCatalog`: **false**。`--model` は**起動時のフラグ**でターン中に
 *   変えられず、`agy models` は人間向けのテキストしか出さない（実測: JSON 出力の
 *   フラグが無い）。カタログを出せないのに `/model` を出すと選択肢が空か他 provider の
 *   モデル名になるので、両方 false にして設定値をそのまま `--model` へ渡す。
 * - `usage` / `cost`: **false**。`usage` はトークン数だけで、アカウント全体の使用状況も
 *   USD のコストも運ばない。
 * - `transcript`: **false**。CLI 側のトランスクリプト（`.gemini/antigravity/`）からの
 *   ログ復元は未対応。
 * - `subagents`: **false**。`step_update.subagent_info` は存在するが、実データで
 *   開始/決着の対を確かめられていないので、**ゲートに積まない**
 *   （解けないゲートはセッションを永久に `running` にする ＝ 早すぎる完了より危険）。
 */
export const ANTIGRAVITY_CAPABILITIES: AgentCapabilities = {
  permissions: false,
  interrupt: true,
  setModel: false,
  resume: true,
  modelCatalog: false,
  usage: false,
  cost: false,
  transcript: false,
  subagents: false,
};

/**
 * codiva の systemPrompt を Antigravity へ渡す。`agy` には `--system-prompt` 相当が
 * 無いので**最初のターンの指示文の前に差し込む**（2 ターン目以降は同じ会話を
 * 続けるので、モデルは既に読んでいる）。対象リポジトリの `AGENTS.md` /
 * `.gemini/` を codiva が書き換える方法は取らない。
 */
function withSystemPrompt(prompt: string, systemPrompt: string | undefined): string {
  return systemPrompt ? `${systemPrompt}\n\n---\n\n${prompt}` : prompt;
}

/** その `result` がターンの決着か（`WAITING` / `RUNNING` は途中経過）。 */
function isTerminalResult(event: AntigravityEvent): boolean {
  if (event.event !== 'result') {
    return false;
  }
  const status = event.result?.status;
  return status !== 'WAITING' && status !== 'RUNNING';
}

/** `AgentAdapter` を Antigravity 用に組み立てる。`spawn` は DI。 */
export function createAntigravityAdapter(deps: {
  spawn: AntigravitySpawn;
  generateTitle?: (prompt: string) => Promise<string | null | undefined>;
  /** 導入・ログイン検出（I/O は `utils/antigravity.ts` の `detectAntigravityAvailability`）。 */
  checkAvailability?: () => Promise<AgentAvailability>;
}): AgentAdapter {
  return {
    id: 'antigravity',
    displayName: 'Antigravity',
    loginCommand: 'agy',
    capabilities: ANTIGRAVITY_CAPABILITIES,
    classifyError: classifyAntigravityError,
    generateTitle: deps.generateTitle,
    checkAvailability: deps.checkAvailability,
    // `login` は実装しない。`agy` に `login` サブコマンドが無く、素で起動した
    // フル TUI の中でしかサインインできない（実測 1.2.10）ため、端末を明け渡さずに
    // 進める形へ落とせない。規約どおり**省略**して UI にログイン導線を出さない。

    open(request: AgentRunRequest): AgentRun {
      // ターンをまたいで持ち回るもの。
      let conversationId = request.resume;
      let handoff = request.options.handoff;
      // `Ctrl+C` で殺したターンは失敗ではない（Session が先に `interrupted` を確定させる）。
      let interrupted = false;
      let current: AntigravityProcess | undefined;
      let procIter: AsyncIterator<unknown> | undefined;

      const abort = () => {
        current?.kill();
      };
      request.abortController.signal.addEventListener('abort', abort, { once: true });

      /** プロセスを閉じる（次のターンで起こし直す）。 */
      const closeProcess = () => {
        const proc = current;
        current = undefined;
        procIter = undefined;
        proc?.kill();
      };

      return {
        async *[Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
          try {
            for await (const text of request.prompt) {
              if (request.abortController.signal.aborted) {
                return;
              }
              interrupted = false;

              // systemPrompt は「その会話がまだ読んでいないとき」だけ前置する。
              // **フラグで latch しない** — 初回のターンが会話 id を貰う前に落ちる
              // （未導入 / 未ログイン / 即 `Ctrl+C`）と次のターンは新しい会話として
              // 始まるので、latch していると systemPrompt を一度も渡せなくなる
              // （symlink 共有の注意書きが落ちると、リンク越しに元リポジトリを壊しうる）。
              const systemPrompt = conversationId ? undefined : request.options.systemPrompt;
              const composed = withSystemPrompt(attachHandoff(text, handoff), systemPrompt);

              // プロセスが無ければ（初回 / 前のターンで死んだ）起こし直す。
              // **`--conversation` は起動時のフラグ**なので、id が分かっていれば
              // ここで渡すことで会話が途切れない。
              // 前のターンのあとに死んでいたら畳んでから起こし直す（`alive` の理由書き）。
              if (current && !current.alive()) {
                closeProcess();
              }
              if (!current) {
                const proc = deps.spawn({
                  cwd: request.cwd,
                  resume: conversationId,
                  model: request.options.model,
                  effort: request.options.effort,
                  permissionMode: request.options.permissionMode,
                });
                current = proc;
                procIter = proc[Symbol.asyncIterator]();
              }
              const proc = current;
              const iter = procIter;
              if (!proc || !iter) {
                return;
              }

              // ここから 1 ターン。パーサは**プロセスごと**に作る（step_index は
              // プロセス内で通し番号なので、起こし直したら状態も捨てる）。
              const parser = createAntigravityParser();
              proc.send({ event: 'user', message: { content: composed } });

              let sawResult = false;
              let procDead = false;
              for (;;) {
                const next = await iter.next().catch(() => ({ done: true, value: undefined }));
                if (next.done) {
                  procDead = true;
                  break;
                }
                const event = toAntigravityEvent(next.value);
                if (!event) {
                  continue;
                }
                // 引き継ぎは **CLI が確かにターンを始めたとき**だけ落とす。`init` は
                // 指示を読む前にも出るので、そこで落とすと未ログインで即死した初回の
                // ターンが 1 回きりの引き継ぎを空振りで使い切る。
                if (event.event === 'step_update' && handoff !== undefined) {
                  handoff = undefined;
                  request.onHandoffDelivered?.();
                }
                for (const out of parser.parse(event)) {
                  // 会話 id を控える（次のターン・再起動後の resume に使う）。
                  if (out.kind === 'session_started' && out.sessionId) {
                    conversationId = out.sessionId;
                  }
                  yield out;
                }
                if (isTerminalResult(event)) {
                  sawResult = true;
                  break;
                }
              }

              if (procDead) {
                // 途中で書きかけだった step を閉じてから、死因を報告する。
                yield* parser.flush();
                const { code, stderr } = proc.result();
                closeProcess();
                // 中断は Session 側で既に `interrupted` を確定させてあるので何も出さない。
                if (!interrupted && !request.abortController.signal.aborted) {
                  const detail = stderr.trim() || `agy exited with code ${code ?? 'null'}`;
                  const cause = classifyAntigravityError(detail);
                  yield code === 0
                    ? { kind: 'turn_completed', text: '' }
                    : {
                        kind: 'turn_stopped',
                        // **終端イベントを出さずに死んだプロセスは `failed` に落とさない。**
                        // 会話 id が分かっているなら `--conversation` で続けられるので、
                        // resumable な床（`connection`）へ倒す（codex-adapter と同じ）。
                        cause: cause === 'failed' && conversationId ? 'connection' : cause,
                        detail,
                      };
                }
              } else if (interrupted || request.abortController.signal.aborted) {
                // 中断されたターンのプロセスは畳む（次の指示で起こし直す）。
                closeProcess();
              }
              // `sawResult` なら同じプロセスを次のターンでも使い回す。
              void sawResult;
            }
          } finally {
            request.abortController.signal.removeEventListener('abort', abort);
            current?.endInput();
            closeProcess();
          }
        },

        interrupt: async () => {
          interrupted = true;
          // `agy` の headless には「走っているターンだけ止める」入力が無いので、
          // プロセスごと落とす。会話は `--conversation <id>` で続けられるため、
          // 次の指示で起こし直せば文脈は切れない。
          closeProcess();
        },
      };
    },
  };
}
