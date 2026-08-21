import type { AgentEvent } from './agent-events';
import { attachHandoff, fitHandoff } from './agent-handoff';
import type {
  AgentAdapter,
  AgentAvailability,
  AgentCapabilities,
  AgentLoginProcess,
  AgentRun,
  AgentRunRequest,
} from './agent-ports';
import { classifyCodexError } from './codex-errors';
import { toCodexEvent } from './codex-events';
import { parseCodexEvent } from './codex-parse';
import type { CodexSandbox, EffortLevel } from './config';

/**
 * Codex CLI（`codex exec --json`）用の {@link AgentAdapter}。
 *
 * Claude と決定的に違うのが**プロセスの粒度**: Claude Agent SDK は 1 本の
 * streaming-input セッションが何ターンでも続くが、`codex exec` は
 * **1 ターン = 1 プロセス**で、続きは `codex exec resume <thread_id>` として
 * 起動し直す。だからここでは「指示が来るたびにプロセスを起こし、`thread_id` を
 * 引き継ぐ」ループを回して、外からは Claude と同じ 1 本のストリームに見せている。
 *
 * もう 1 つの制約は**許可要求を上げられない**こと。`codex exec` の JSON モードは
 * 承認要求（コマンド実行 / パッチ適用 / MCP）をすべて CLI 内部で自動 reject し、
 * JSONL には何も出さない（`codex-rs/exec/src/lib.rs` の `handle_server_request`）。
 * したがって `capabilities.permissions` は false で、`requestPermission` は呼ばれない。
 */

/**
 * 解決済みモデルの問い合わせが**空振り**してよい回数の上限。そもそも取れない環境
 * （rollout を書かない設定・別レイアウト）で毎ターン探し回らないための予算で、
 * 1 ターンにつき最大 2 回（ターン中 + ターン終了後の引き直し）消費する。
 */
const MAX_MODEL_PROBES = 4;

/**
 * 問い合わせに与える猶予（実 I/O 側の `resolveCodexRolloutModel` へ渡す）。
 *
 * - **ターン中**（`thread.started` の直後に張る）は長く待つ。CLI が解決済みモデルを
 *   書き出すのは実測で `thread.started` から**約 3 秒後**なので、短く切ると必ず空振りする。
 *   この問い合わせは**誰も await しない**（ストリームを止めない）ので長くても害が無い。
 * - **ターン終了後の引き直し**は短くする。そこでは既に書かれているので普通は 1 回で
 *   当たり、取れない環境ではターンの合間を長く引き止めない（ここだけは await する）。
 */
const MODEL_PROBE_WAIT_MS = 20_000;
const MODEL_PROBE_TAIL_WAIT_MS = 1_500;

/** 1 ターンぶんの `codex exec` を起動するための入力（I/O 実装は `utils/codex.ts`）。 */
export interface CodexSpawnRequest {
  /** セッションの worktree。 */
  cwd: string;
  /** このターンの指示文（引数として渡す。stdin は使わない）。 */
  prompt: string;
  /** 継続するスレッド id。あれば `codex exec resume <id>` になる。 */
  resume?: string;
  model?: string;
  effort?: EffortLevel;
  sandbox: CodexSandbox;
  /** `workspace-write` のときネットワークを許可するか。 */
  networkAccess: boolean;
}

/**
 * 起動中の `codex exec` プロセス。stdout の JSONL を 1 行 1 オブジェクトで流す。
 * ストリームが尽きたあとに {@link result} で終了コードと stderr を読む。
 */
export interface CodexProcess extends AsyncIterable<unknown> {
  /** プロセスを殺す（`Ctrl+C` による中断）。 */
  kill(): void;
  /** 終了コードと stderr の末尾。ストリームを最後まで読んだあとに呼ぶ。 */
  result(): { code: number | null; stderr: string };
}

/** `codex exec` を起動する I/O 境界（DI。テストはフェイクを注入する）。 */
export type CodexSpawn = (request: CodexSpawnRequest) => CodexProcess;

/**
 * Codex ができること。`NO_CAPABILITIES` から始めて、実装できたものだけ true にする。
 *
 * - `permissions`: **false**。exec の JSON モードは承認要求を上げられない（上記）。
 * - `usage` / `cost`: **false**。`turn.completed` はトークン数だけで、アカウント全体の
 *   使用状況も USD のコストも運ばない。
 * - `transcript`: **false**。rollout ファイル（`~/.codex/sessions`）は形式が別なので、
 *   復元したセッションのログ再構築は未対応。
 */
export const CODEX_CAPABILITIES: AgentCapabilities = {
  permissions: false,
  interrupt: true,
  setModel: true,
  resume: true,
  modelCatalog: true,
  usage: false,
  cost: false,
  transcript: false,
};

/**
 * codiva の systemPrompt を Codex へ渡す。Codex には `--system-prompt` 相当が無いので
 * **最初のターンの指示文の前に差し込む**（2 ターン目以降は同じスレッドを resume する
 * ので、モデルは既に読んでいる）。`AGENTS.md` を書き換える方法は取らない —
 * 対象リポジトリのファイルを codiva が勝手に触らないため。
 */
function withSystemPrompt(prompt: string, systemPrompt: string | undefined): string {
  return systemPrompt ? `${systemPrompt}\n\n---\n\n${prompt}` : prompt;
}

/**
 * 指示文 1 本（= argv の 1 引数）に載せてよい最大バイト数。
 *
 * Linux の `execve` は引数 1 本あたり `MAX_ARG_STRLEN`（32 ページ = 131,072 バイト）で
 * 打ち切り、超えると `E2BIG` で**起動そのもの**が失敗する（macOS には per-arg の
 * 上限が無いので手元では再現しない）。余白は引き継ぎの境目の見出しなど数百バイトぶん。
 */
const MAX_PROMPT_BYTES = 128_000;

/** `attachHandoff` が挟む境目（見出し + 空行）ぶんの概算バイト数。 */
const MARKER_BYTES = 64;

const UTF8 = new TextEncoder();

/** UTF-8 のバイト長（argv に載る実サイズ）。 */
function utf8Length(text: string): number {
  return UTF8.encode(text).length;
}

/** `AgentAdapter` を Codex 用に組み立てる。`spawn` は DI（テストはフェイクを注入）。 */
export function createCodexAdapter(deps: {
  spawn: CodexSpawn;
  sandbox?: CodexSandbox;
  networkAccess?: boolean;
  generateTitle?: (prompt: string) => Promise<string | null | undefined>;
  /** 導入・ログイン検出（I/O は `utils/codex.ts` の `detectCodexAvailability`）。 */
  checkAvailability?: () => Promise<AgentAvailability>;
  /**
   * そのスレッドが実際に使っているモデルを調べる（I/O は `utils/codex.ts` の
   * `resolveCodexRolloutModel`）。`codex exec --json` はモデル名を運ばないので、
   * `--model` を明示していないセッションはこれが唯一の出所になる。
   * 省略可（渡さなければモデル欄は空のまま = 従来どおり）。
   *
   * `waitMs` は「答えが出るまで待ってよい上限」。答えは CLI が非同期に書き出すので、
   * 待たずに聞くと空振りする（{@link MODEL_PROBE_WAIT_MS}）。
   */
  resolveModel?: (threadId: string, waitMs: number) => Promise<string | undefined>;
  /** TUI 内ログインのプロセス起動（I/O は `utils/agent-login.ts` の `spawnLogin`）。 */
  spawnLogin?: (command: string, args: readonly string[]) => AgentLoginProcess;
}): AgentAdapter {
  const sandbox = deps.sandbox ?? 'workspace-write';
  const networkAccess = deps.networkAccess ?? true;
  const spawnLogin = deps.spawnLogin;

  return {
    id: 'codex',
    displayName: 'Codex',
    loginCommand: 'codex',
    capabilities: CODEX_CAPABILITIES,
    classifyError: classifyCodexError,
    generateTitle: deps.generateTitle,
    checkAvailability: deps.checkAvailability,
    // `--device-auth` を選ぶのは、端末を明け渡さない TUI 内ログインに最も素直だから:
    // ローカルのブラウザ起動やコールバックサーバ・stdin 入力を必要とせず、認証 URL と
    // デバイスコードを標準出力に出して待つ（codiva がその URL を拾って開く）。
    login: spawnLogin ? () => spawnLogin('codex', ['login', '--device-auth']) : undefined,

    open(request: AgentRunRequest): AgentRun {
      // ターンをまたいで持ち回るもの。`threadId` は resume の鍵で、`thread.started` を
      // 見るたびに更新する（初回は request.resume = 復元されたセッションの id）。
      let threadId = request.resume;
      let handoff = request.options.handoff;
      let model = request.options.model;
      // `Ctrl+C` で殺したターンは失敗ではない（Session が先に `interrupted` を確定させる）。
      let interrupted = false;
      let current: CodexProcess | undefined;

      // 解決済みモデルの遅延問い合わせ。`codex exec --json` はモデル名を運ばないので、
      // `--model` を明示していないセッション（= CLI の既定に任せている）のモデル欄は
      // これでしか埋まらない。**ストリームは止めない** — 問い合わせは走らせておいて、
      // answered ぶんを後続イベントの合間に流す。
      let pendingModel: string | undefined;
      /** ターン中に張っている問い合わせ（1 本だけ）。 */
      let inTurnProbe: Promise<void> | undefined;
      /** 一度でも読めたか（読めたらそのセッションでは以後探さない）。 */
      let resolvedOnce = false;
      /** 空振り（+ 失敗）した回数。{@link MAX_MODEL_PROBES} で打ち切る。 */
      let misses = 0;

      /**
       * 問い合わせを 1 本張る（呼ばなくてよいときは undefined を返す）。
       *
       * **空振りは記憶しない** — 答えは CLI が遅れて書き出すので、早すぎた問い合わせが
       * 空振りするのは正常な経路。latch すると「次に聞けば読めるのに二度と聞かない」
       * セッションになる。歯止めは回数の予算（{@link MAX_MODEL_PROBES}）だけにする。
       */
      const startProbe = (id: string, waitMs: number): Promise<void> | undefined => {
        const resolve = deps.resolveModel;
        // 明示指定があるときは Session が先に表示済みなので問い合わせない。
        if (!resolve || model !== undefined || resolvedOnce || misses >= MAX_MODEL_PROBES) {
          return undefined;
        }
        return resolve(id, waitMs)
          .then((found) => {
            if (found === undefined) {
              misses += 1;
              return;
            }
            resolvedOnce = true;
            pendingModel = found;
          })
          .catch(() => {
            misses += 1;
          });
      };

      /** ターン中の問い合わせ（走っていれば何もしない。答えは後続イベントの合間に流れる）。 */
      const probeDuringTurn = (id: string): void => {
        if (inTurnProbe) {
          return;
        }
        inTurnProbe = startProbe(id, MODEL_PROBE_WAIT_MS)?.finally(() => {
          inTurnProbe = undefined;
        });
      };

      /**
       * 解決済みモデルを 1 回だけ流す。**答えが古くなっていたら捨てる** — 問い合わせ中に
       * `/model` で明示選択されたり（そちらが正しい）、中断・エージェント切替が起きたり
       * （切替先は別 provider なので Codex の slug は嘘になる）した後に流すと、
       * 一覧に間違ったモデル名が出たまま `state.json` にも焼き付く。
       */
      const takeResolvedModel = (): AgentEvent | undefined => {
        const found = pendingModel;
        pendingModel = undefined;
        if (
          found === undefined ||
          model !== undefined ||
          interrupted ||
          request.abortController.signal.aborted
        ) {
          return undefined;
        }
        return { kind: 'model_resolved', model: found };
      };

      const abort = () => {
        current?.kill();
      };
      request.abortController.signal.addEventListener('abort', abort, { once: true });

      return {
        async *[Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
          try {
            for await (const text of request.prompt) {
              if (request.abortController.signal.aborted) {
                return;
              }
              interrupted = false;
              // systemPrompt は「そのスレッドがまだ読んでいないとき」だけ前置する。
              // **フラグで latch しない** — 初回のターンが `thread.started` より前に落ちる
              // （`codex` 未導入 / 未ログイン / 不正な `--model` / 即 `Ctrl+C`）と threadId が
              // 付かず、次のターンは**新しいスレッド**として始まる。latch していると
              // そこで前置されず、systemPrompt を一度も渡せないセッションになる
              // （symlink 共有の注意書きが落ちると、リンク越しに元リポジトリを壊しうる）。
              const systemPrompt = threadId ? undefined : request.options.systemPrompt;

              // **argv 1 本の上限に収める**。指示文は systemPrompt と引き継ぎもろとも
              // 1 つの引数として渡るので（`utils/codex.ts` の `codexArgs`）、超えると
              // `spawn` が `E2BIG` で落ちる。しかも引き継ぎの解除点は `thread.started`
              // なので、落ちるとスレッドが付かず**以後のターンも同じ理由で落ち続ける**
              // （= セッションが詰む）。削るのは引き継ぎの会話履歴だけで、ユーザーの
              // 指示文と systemPrompt は削らない。
              const overhead =
                utf8Length(text) + (systemPrompt ? utf8Length(systemPrompt) + 7 : 0) + MARKER_BYTES;
              const fitted =
                handoff === undefined
                  ? undefined
                  : fitHandoff(handoff, Math.max(0, MAX_PROMPT_BYTES - overhead));
              if (handoff !== undefined && fitted === undefined) {
                // 会話を 1 ターンも載せられない（巨大な `.codiva/prompt.md` / 長文の指示）。
                // 黙って捨てず 1 行残す。引き継ぎはここで諦める（持ち続けても毎ターン
                // 同じ理由で落とすだけ）。
                yield {
                  kind: 'notice',
                  text: 'handover skipped: the prompt would exceed the argument size limit',
                };
                handoff = undefined;
                request.onHandoffDelivered?.();
              }
              const userPrompt = attachHandoff(text, fitted);
              const prompt = withSystemPrompt(userPrompt, systemPrompt);

              const proc = deps.spawn({
                cwd: request.cwd,
                prompt,
                resume: threadId,
                model,
                effort: request.options.effort,
                sandbox,
                networkAccess,
              });
              current = proc;

              // ターンの終わりを CLI が明示したか。`turn.completed` / `turn.failed` の
              // どちらも来ずにプロセスが終わることがある（中断・起動失敗）ので、
              // その場合だけ終了コードから補う。
              let sawTerminal = false;
              try {
                for await (const raw of proc) {
                  const event = toCodexEvent(raw);
                  if (!event) {
                    continue;
                  }
                  if (event.type === 'thread.started') {
                    threadId = event.thread_id;
                    // 引き継ぎは CLI が確かに受け取ったときだけ落とす（systemPrompt の
                    // 前置と同じ理由 = 初回のターンが起動前に落ちたら次で渡し直す）。
                    // **`codex exec resume` も `thread.started` を出す**ので、往復切替で
                    // 既存スレッドへ戻る場合もここを通る（実測: codex 0.147 系。同じ
                    // thread_id が返る）。ここが唯一の解除点なので、出さなくなったら
                    // 引き継ぎが毎ターン前置され続ける。
                    if (handoff !== undefined) {
                      handoff = undefined;
                      // `Session` 側も同じ条件で落とす（渡る前に run が死んだら
                      // 次の run で渡し直せるように、持ち主は Session のまま）。
                      request.onHandoffDelivered?.();
                    }
                    probeDuringTurn(event.thread_id);
                  } else if (event.type === 'turn.completed' || event.type === 'turn.failed') {
                    sawTerminal = true;
                  }
                  // 解決済みモデルが届いていれば先に流す（長いターンでも一覧が早く埋まる）。
                  const resolvedMid = takeResolvedModel();
                  if (resolvedMid) {
                    yield resolvedMid;
                  }
                  yield* parseCodexEvent(event);
                }
              } finally {
                current = undefined;
                // **必ず殺す**。正常に読み切ったあとは no-op だが、途中で捨てられた場合
                // （`parseCodexEvent` の throw / 消費側の throw で `run.return()` が呼ばれる）
                // ここを通らないと `codex exec` が worktree を触ったまま残る。パイプが
                // 壊れても死なない（Rust は SIGPIPE を無視する）ので、放置は効かない。
                proc.kill();
              }

              // 中断は Session 側で既に `interrupted` を確定させてあるので何も出さない。
              if (!interrupted && !request.abortController.signal.aborted && !sawTerminal) {
                const { code, stderr } = proc.result();
                const detail = stderr.trim() || `codex exited with code ${code ?? 'null'}`;
                // **終端イベントを出さずに死んだプロセスは `failed` に落とさない。**
                // Rust の panic（exit 101）や外からの SIGKILL（code null）は
                // どの分類パターンにも当たらないので `failed` = **終端**になり、
                // `codex exec resume <thread_id>` で続けられるのに再開の導線が消える。
                // スレッド id が分かっているなら resumable な `connection` に倒す
                // （Grok アダプタが `EXITED_CODE` でやっているのと同じ床）。
                const cause = classifyCodexError(detail);
                yield code === 0
                  ? { kind: 'turn_completed', text: '' }
                  : {
                      kind: 'turn_stopped',
                      cause: cause === 'failed' && threadId ? 'connection' : cause,
                      detail,
                    };
              }

              // 問い合わせの回収は**終端イベントを流したあと**。`model_resolved` は
              // status を触らないので、完了イベントの後に流しても巻き戻さない。
              //
              // **ここで引き直すのが本命**。CLI が解決済みモデルを書き出すのは
              // `thread.started` から約 3 秒後（実測）なので、ターン中に張った
              // 問い合わせは空振りしうる。一方**ターンが終わった時点なら必ず書かれている**
              // ので、ここで聞けば当たる。これが無いと 1 ターンで idle になった
              // セッションのモデル欄が次の指示まで（1 回きりのセッションなら永久に）
              // 空のままになる — 実際にそうなっていた。
              //
              // 走っている問い合わせは**待たない**（あちらは長い猶予を持つので、待つと
              // ターンの合間を最大その猶予ぶん引き止める）。同じファイルを読むだけなので
              // 二重に走っても害は無い。
              //
              // 中断・破棄のときは**そもそも聞かない**（`Ctrl+C` の直後や終了処理を、
              // 表示用の問い合わせで引き止めない）。タイマーは unref してあるので、
              // 置き去りにした問い合わせが TUI の終了を止めることもない。
              if (threadId && !interrupted && !request.abortController.signal.aborted) {
                await startProbe(threadId, MODEL_PROBE_TAIL_WAIT_MS);
              }
              const resolved = takeResolvedModel();
              if (resolved) {
                yield resolved;
              }
            }
          } finally {
            request.abortController.signal.removeEventListener('abort', abort);
          }
        },

        interrupt: async () => {
          interrupted = true;
          current?.kill();
        },

        // Codex はターンごとにプロセスを起こすので、モデルの切替は「次のターンから」。
        // 走っているターンには反映されない（`setModel` の契約としては許容範囲）。
        setModel: (next) => {
          model = next;
          // 「既定に戻す」を選んだら、その CLI 既定が何なのかを次のターンで引き直す
          // （前回の解決結果は、明示指定していた別モデルのものかもしれない）。
          //
          // **探索予算も戻す**。`MAX_MODEL_PROBES` は「そもそも rollout を読めない環境で
          // 毎ターン探し回らない」ための上限で、ユーザーが明示的に既定へ戻す操作まで
          // 縛るためのものではない。残したままだと、序盤に空振りして予算を使い切った
          // セッションでは「明示モデルを選ぶ → 既定へ戻す」としてもモデル欄が明示モデルの
          // 表示から二度と更新されない（予算はユーザーの操作回数で自然に頭打ちになる）。
          if (next === undefined) {
            resolvedOnce = false;
            misses = 0;
          }
        },
      };
    },
  };
}
