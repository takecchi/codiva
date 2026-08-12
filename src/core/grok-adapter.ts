import type { AgentEvent } from './agent-events';
import type {
  AgentAdapter,
  AgentAvailability,
  AgentCapabilities,
  AgentLoginProcess,
  AgentRun,
  AgentRunRequest,
} from './agent-ports';
import { AsyncQueue } from './async-queue';
import type { EffortLevel } from './config';
import { classifyGrokError, grokStopCause } from './grok-errors';
import {
  type GrokMessage,
  type GrokPermissionParams,
  type GrokPromptResult,
  type GrokQuestionParams,
  type GrokSessionResult,
  grokUpdateOf,
  toGrokMessage,
  toGrokModelState,
  toGrokPermissionParams,
  toGrokQuestionParams,
} from './grok-events';
import { createGrokParser } from './grok-parse';
import type { QuestionSpec } from './types';

/**
 * Grok Build CLI（`grok agent stdio`）用の {@link AgentAdapter}。
 *
 * 形は Claude / Codex のどちらとも違う **JSON-RPC の双方向ストリーム**（ACP）:
 *
 * - プロセスは**セッションに 1 本**（Codex の「1 ターン 1 プロセス」ではない）。
 * - ターンは `session/prompt` の 1 往復で、応答の `stopReason` が終わりを告げる。
 * - **エージェント側からも要求が飛んでくる**（`session/request_permission` /
 *   `_x.ai/ask_user_question`）。これが Codex に無い許可・質問ダイアログの実装点で、
 *   応答するまで向こうは止まっているので、codiva の `requestPermission` へそのまま繋ぐ。
 *
 * ここが「Grok の ACP を codiva の中立語彙へ翻訳する」層で、`grok` CLI の形の知識が
 * 出てよいのはこのファイルと `grok-events.ts` / `grok-parse.ts` / `grok-errors.ts` /
 * `grok-models.ts`（と I/O の `utils/grok.ts`）だけ。
 */

/** `grok agent stdio` の起動要求。 */
export interface GrokSpawnRequest {
  cwd: string;
  /** `--reasoning-effort`。CLI が解釈できない値は無視される。 */
  effort?: EffortLevel;
}

/**
 * 起動中の `grok agent stdio` プロセス。stdout の JSON-RPC を 1 行 1 オブジェクトで流し、
 * {@link send} で 1 行送る。ストリームが尽きたあとに {@link result} を読む。
 */
export interface GrokProcess extends AsyncIterable<unknown> {
  /** JSON-RPC メッセージを 1 通送る（改行区切り）。 */
  send(message: unknown): void;
  /** プロセスを殺す。 */
  kill(): void;
  /** 終了コードと stderr の末尾。ストリームを最後まで読んだあとに呼ぶ。 */
  result(): { code: number | null; stderr: string };
}

/** `grok agent stdio` を起動する I/O 境界（DI。テストはフェイクを注入する）。 */
export type GrokSpawn = (request: GrokSpawnRequest) => GrokProcess;

/**
 * Grok ができること。
 *
 * - `permissions`: **true**。ACP の `session/request_permission` と xAI 拡張の
 *   `_x.ai/ask_user_question` が実際に飛んでくる（実測。`__fixtures__/grok-permission.jsonl` /
 *   `grok-question.jsonl`）ので、許可・質問ダイアログをそのまま出せる。
 * - `usage` / `cost`: **false**。ターンの応答はトークン数を運ぶが、アカウント全体の
 *   使用状況（ヘッダのゲージ）も USD のコストも無い。
 * - `transcript`: **false**。`~/.grok/sessions` 配下の `updates.jsonl` に会話は残るが、
 *   復元したセッションのログ再構築は未対応。
 */
export const GROK_CAPABILITIES: AgentCapabilities = {
  permissions: true,
  interrupt: true,
  setModel: true,
  resume: true,
  modelCatalog: true,
  usage: false,
  cost: false,
  transcript: false,
};

/** ACP のプロトコル版（`initialize` で宣言する）。 */
const PROTOCOL_VERSION = 1;

/**
 * 認証が要るのに資格情報が無いときの `session/new` の失敗。文言判定に頼らず
 * ここで拾って `needs_login` に落とす。
 */
const AUTH_REQUIRED = /authentication required|not signed in|no auth method/i;

/**
 * プロセスが黙って死んだときに合成するエラーの code。`session/prompt` の応答と
 * 区別して、終了コードと stderr から本当の理由を組み立てるために使う。
 */
const EXITED_CODE = -32000;

/** `rpc()` が解決する形（要求・通知はここへ来ない）。 */
type GrokReply = Extract<GrokMessage, { kind: 'response' } | { kind: 'error' }>;

/** 質問の回答を送るまでの待ちに上限は設けない（ユーザーが答えるまで待つのが正しい）。 */
interface Pending {
  resolve(message: GrokReply): void;
}

/**
 * JSON-RPC のエラーを 1 本の文字列に。**両方を残す** — `message` は総称
 * （`Internal error` / `Authentication required`）、`data` に実際の理由が入るので、
 * 片方だけだと分類（`grokStopCause`）も画面の説明も情報を落とす。
 */
function errorText(error: { message: string; data?: unknown }): string {
  const data = error.data;
  if (typeof data === 'string' && data.trim().length > 0) {
    return `${error.message}: ${data}`;
  }
  return error.message;
}

/**
 * `_x.ai/ask_user_question` の質問を UI が扱える {@link QuestionSpec} へ写す。
 * Grok の質問に `header`（短いラベル）は無いので空にする。
 */
function toQuestionSpecs(params: GrokQuestionParams): QuestionSpec[] {
  return (params.questions ?? []).map((q) => ({
    question: q.question ?? '',
    header: '',
    multiSelect: Boolean(q.multiSelect),
    options: (q.options ?? []).map((o) => ({
      label: o.label ?? '',
      description: o.description ?? '',
    })),
  }));
}

/**
 * UI の回答（`{ [質問文]: 'ラベル' | 'ラベルA, ラベルB' }`）を Grok の応答形へ。
 *
 * Grok は `answers` を**質問文をキーにしたマップ**で受け取り、値は選択ラベルの配列
 * （後方互換で単一文字列も通る）。`outcome` が無いと「クライアントの応答が不正」として
 * ツールが失敗する（実測）ので、必ず付ける。
 */
function toGrokAnswers(input: Record<string, unknown> | undefined): Record<string, string[]> {
  const answers: Record<string, string[]> = {};
  const raw = input?.answers;
  if (typeof raw !== 'object' || raw === null) {
    return answers;
  }
  for (const [question, value] of Object.entries(raw as Record<string, unknown>)) {
    if (Array.isArray(value)) {
      answers[question] = value.map((v) => String(v));
    } else if (typeof value === 'string') {
      // codiva の複数選択はカンマ区切りの 1 文字列で来る（Claude 側の形に揃えてある）。
      answers[question] = value
        .split(',')
        .map((v) => v.trim())
        .filter((v) => v.length > 0);
    }
  }
  return answers;
}

/**
 * 許可の選択肢から「1 回だけ許す」「1 回だけ断る」を選ぶ。`optionId` は固定値では
 * なく**その要求が持ってきたもの**を使う（CLI が編集用・コマンド用で違う id を出す）。
 */
function pickOption(params: GrokPermissionParams, allow: boolean): string | undefined {
  const wanted = allow ? 'allow_once' : 'reject_once';
  const fallback = allow ? 'allow_always' : 'reject_always';
  const options = params.options;
  return (
    options.find((o) => o.kind === wanted)?.optionId ??
    options.find((o) => o.kind === fallback)?.optionId ??
    options[0]?.optionId
  );
}

/** `AgentAdapter` を Grok 用に組み立てる。`spawn` は DI（テストはフェイクを注入）。 */
export function createGrokAdapter(deps: {
  spawn: GrokSpawn;
  generateTitle?: (prompt: string) => Promise<string | null | undefined>;
  /** 導入・ログイン検出（I/O は `utils/grok.ts` の `detectGrokAvailability`）。 */
  checkAvailability?: () => Promise<AgentAvailability>;
  /** TUI 内ログインのプロセス起動（I/O は `utils/agent-login.ts` の `spawnLogin`）。 */
  spawnLogin?: (command: string, args: readonly string[]) => AgentLoginProcess;
}): AgentAdapter {
  const spawnLogin = deps.spawnLogin;
  return {
    id: 'grok',
    displayName: 'Grok',
    loginCommand: 'grok',
    capabilities: GROK_CAPABILITIES,
    classifyError: classifyGrokError,
    generateTitle: deps.generateTitle,
    checkAvailability: deps.checkAvailability,
    // `grok login --device-auth` はブラウザで進むデバイスコード認証。stdin もローカル
    // サーバも要らないので、TUI の中で URL とコードを見せるだけで済む（Codex と同じ）。
    login: spawnLogin ? () => spawnLogin('grok', ['login', '--device-auth']) : undefined,

    open(request: AgentRunRequest): AgentRun {
      const events = new AsyncQueue<AgentEvent>();
      const parser = createGrokParser();
      const pending = new Map<number, Pending>();
      let proc: GrokProcess | undefined;
      let sessionId = request.resume;
      let model = request.options.model;
      /** codiva 側から中断したか（そのターンの `cancelled` を静かに終わらせる）。 */
      let interrupted = false;
      /**
       * 中断したいのに `sessionId` がまだ無い（`session/new` の最中）。確立した
       * 直後に `session/cancel` を送るための予約。
       */
      let cancelPending = false;
      /** 直近の `retry_state.error_type`（CLI 自身の失敗分類）。 */
      let lastErrorType: string | undefined;
      let nextId = 1;

      const send = (message: unknown): void => {
        proc?.send(message);
      };

      /** 要求を 1 本投げて応答を待つ。プロセスが死んだら reject される。 */
      const rpc = (method: string, params: unknown): Promise<GrokReply> => {
        const id = nextId++;
        return new Promise<GrokReply>((resolve, reject) => {
          if (!proc) {
            reject(new Error('grok agent is not running'));
            return;
          }
          pending.set(id, { resolve });
          send({ jsonrpc: '2.0', id, method, params });
        });
      };

      const notify = (method: string, params: unknown): void => {
        send({ jsonrpc: '2.0', method, params });
      };

      /** セッション確立前に押された `Ctrl+C` を、確立直後に送り直す。 */
      const flushPendingCancel = (): void => {
        if (cancelPending && sessionId) {
          cancelPending = false;
          notify('session/cancel', { sessionId });
        }
      };

      /** 許可要求 → codiva のダイアログ → ACP の応答。 */
      const answerPermission = async (id: number | string, raw: unknown): Promise<void> => {
        const params = toGrokPermissionParams(raw);
        if (!params) {
          // 選択肢が読めない要求には答えようがない。断って先へ進ませる（放置すると
          // エージェントが永久に待つ）。
          send({ jsonrpc: '2.0', id, result: { outcome: { outcome: 'cancelled' } } });
          return;
        }
        const tool = params.toolCall;
        const decision = await request.requestPermission({
          toolName: tool?._meta?.['x.ai/tool']?.name ?? tool?.title ?? 'tool',
          input: tool?.rawInput ?? {},
          kind: 'tool',
        });
        const optionId = pickOption(params, decision.behavior === 'allow');
        send({
          jsonrpc: '2.0',
          id,
          result:
            optionId === undefined
              ? { outcome: { outcome: 'cancelled' } }
              : { outcome: { outcome: 'selected', optionId } },
        });
      };

      /** 質問要求 → codiva の質問ダイアログ → ACP の応答。 */
      const answerQuestion = async (id: number | string, raw: unknown): Promise<void> => {
        const params = toGrokQuestionParams(raw);
        if (!params) {
          send({ jsonrpc: '2.0', id, result: { outcome: 'cancelled' } });
          return;
        }
        const questions = toQuestionSpecs(params);
        const decision = await request.requestPermission({
          toolName: 'ask_user_question',
          input: { questions: params.questions },
          kind: 'question',
          questions,
        });
        if (decision.behavior !== 'allow') {
          // 断りは `cancelled`（`declined` という値は無い）。エージェントは
          // 「答えないので自分の判断で進めろ」と受け取る。
          send({ jsonrpc: '2.0', id, result: { outcome: 'cancelled' } });
          return;
        }
        send({
          jsonrpc: '2.0',
          id,
          result: { outcome: 'accepted', answers: toGrokAnswers(decision.input) },
        });
      };

      /** stdout を読み続け、通知はイベントへ、要求は応答へ回す。 */
      const readLoop = async (stream: GrokProcess): Promise<void> => {
        for await (const raw of stream) {
          const message = toGrokMessage(raw);
          if (!message) {
            continue;
          }
          if (message.kind === 'response' || message.kind === 'error') {
            const waiter = pending.get(Number(message.id));
            if (waiter) {
              pending.delete(Number(message.id));
              waiter.resolve(message);
            }
            continue;
          }
          if (message.kind === 'request') {
            if (message.method === 'session/request_permission') {
              // 投げても**必ず答える**。放置するとエージェントは待ち続け、ターンが
              // 永久に終わらない（`awaiting_permission` のまま出口が無い）。
              void answerPermission(message.id, message.params).catch(() => {
                send({
                  jsonrpc: '2.0',
                  id: message.id,
                  result: { outcome: { outcome: 'cancelled' } },
                });
              });
            } else if (message.method === '_x.ai/ask_user_question') {
              void answerQuestion(message.id, message.params).catch(() => {
                send({ jsonrpc: '2.0', id: message.id, result: { outcome: 'cancelled' } });
              });
            } else {
              // 知らない要求は「未実装」で返す。黙って捨てるとエージェントが待ち続ける。
              send({
                jsonrpc: '2.0',
                id: message.id,
                error: { code: -32601, message: 'Method not found' },
              });
            }
            continue;
          }
          // 通知: モデルの入れ替えだけ先に拾い、あとはパーサへ。
          if (message.method === '_x.ai/models/update') {
            const state = toGrokModelState(message.params);
            if (state?.currentModelId) {
              events.push({ kind: 'model_resolved', model: state.currentModelId });
            }
            continue;
          }
          const update = grokUpdateOf(message);
          if (update) {
            // CLI 自身の分類（`retry_state.error_type`）を覚えておき、ターンが
            // 落ちたときの分類に使う（文言の正規表現より確か）。
            if (update.sessionUpdate === 'retry_state' && update.error_type) {
              lastErrorType = update.error_type;
            }
            for (const event of parser.parse(update)) {
              events.push(event);
            }
          }
        }
      };

      /**
       * プロセスを起こして `initialize` → セッション確立まで済ませる。
       * 失敗は例外で返す（呼び出し側が `turn_stopped` に写す）。
       */
      const start = async (): Promise<void> => {
        const stream = deps.spawn({ cwd: request.cwd, effort: request.options.effort });
        proc = stream;
        void readLoop(stream)
          .catch(() => {})
          .finally(() => {
            // プロセスが死んだら待っている要求を全部起こす（ぶら下がったままにしない）。
            // **今の担当が自分のときだけ**空に戻す — 起動に失敗して既に別のプロセスへ
            // 差し替わっているとき（`fail()` 後の再起動）に、新しい方を殺してしまわない。
            if (proc === stream) {
              proc = undefined;
            }
            // 理由は**プロセスから**取る（`grok agent exited` のような合成文言だと
            // 分類が効かず、一過性のクラッシュが `failed`（再開不可の終端）になる）。
            const { code, stderr } = stream.result();
            const detail = stderr.trim() || `grok agent exited with code ${code ?? 'null'}`;
            for (const [id, waiter] of pending) {
              pending.delete(id);
              waiter.resolve({
                kind: 'error',
                id,
                error: { code: EXITED_CODE, message: detail },
              });
            }
          })
          // `.finally` の中で throw しても TUI を落とさない（未処理の rejection は
          // プロセス死になる）。catch は**必ず最後**に置く。
          .catch(() => {});

        // 立ち上げに失敗したら**自分で畳む**（起こしっぱなしの `grok` が worktree を
        // 触り続けないように）。次のターンで起こし直せるよう `proc` は空に戻す。
        const fail = (detail: string): never => {
          stream.kill();
          if (proc === stream) {
            proc = undefined;
          }
          throw new Error(detail);
        };

        const init = await rpc('initialize', {
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          },
        });
        if (init.kind === 'error') {
          fail(errorText(init.error));
        }

        // 継続できるなら継続する。`session/load` ではなく `session/resume` を使うのは、
        // load が**過去の会話を通知として全部流し直す**ため（codiva のログは自前で
        // 持っているので二重になる）。resume は文脈だけ戻す（実測）。
        const attach = sessionId
          ? await rpc('session/resume', { sessionId, cwd: request.cwd, mcpServers: [] })
          : undefined;
        if (attach && attach.kind === 'response') {
          const state = toGrokModelState((attach.result as GrokSessionResult | undefined)?.models);
          if (state?.currentModelId) {
            events.push({ kind: 'model_resolved', model: state.currentModelId });
          }
          flushPendingCancel();
          return;
        }
        // resume できなかった（セッションが消えている等）ときは新しく開く。
        const created = await rpc('session/new', {
          cwd: request.cwd,
          mcpServers: [],
          _meta: {
            // worktree の注意書き + リポジトリ追加指示。`systemPromptOverride` は
            // **使わない**（Grok 自身の system prompt を丸ごと潰してしまう）。
            // `rules` は末尾に足されるだけなので安全（実測で反映を確認）。
            ...(request.options.systemPrompt ? { rules: request.options.systemPrompt } : {}),
            ...(model ? { modelId: model } : {}),
          },
        });
        if (created.kind === 'error') {
          fail(errorText(created.error));
          return;
        }
        const result = created.result as GrokSessionResult | undefined;
        if (typeof result?.sessionId === 'string') {
          sessionId = result.sessionId;
          events.push({ kind: 'session_started', sessionId: result.sessionId });
        }
        const state = toGrokModelState(result?.models);
        if (state?.currentModelId) {
          events.push({ kind: 'model_resolved', model: state.currentModelId });
        }
        flushPendingCancel();
      };

      /** 1 ターン。`session/prompt` の応答が終わりを告げる。 */
      const runTurn = async (text: string): Promise<void> => {
        const response = await rpc('session/prompt', {
          sessionId,
          prompt: [{ type: 'text', text }],
        });
        // 途中の本文・思考をログへ確定させてから終端イベントを出す。
        for (const event of parser.flush()) {
          events.push(event);
        }
        if (response.kind === 'error') {
          const detail = errorText(response.error);
          if (interrupted || request.abortController.signal.aborted) {
            // 中断は Session 側で既に確定させてある（二重にログを出さない）。
            return;
          }
          // プロセスが黙って死んだ（終端イベントも応答も無い）ときは、文言から
          // 何も読み取れなくても**再開できる中断**に倒す。`failed` は終端 =
          // 再開の導線が消えるので、一過性のクラッシュをそこへ落とさない。
          const cause =
            grokStopCause(detail, lastErrorType) === 'failed' && response.error.code === EXITED_CODE
              ? 'connection'
              : grokStopCause(detail, lastErrorType);
          events.push({ kind: 'turn_stopped', cause, detail });
          return;
        }
        const result = response.result as GrokPromptResult | undefined;
        const model_ = result?._meta?.modelId;
        if (typeof model_ === 'string') {
          events.push({ kind: 'model_resolved', model: model_ });
        }
        const stop = result?.stopReason;
        if (stop === 'cancelled') {
          if (!interrupted) {
            // 自分で止めていないのに cancelled = 外から止められた。resumable にする。
            events.push({
              kind: 'turn_stopped',
              cause: 'connection',
              detail: 'turn cancelled by the agent',
            });
          }
          return;
        }
        if (interrupted || request.abortController.signal.aborted) {
          // **中断が競り勝つ**。`Ctrl+C` と `end_turn` が同時に届くことがあり、
          // ここで完了にすると `interrupted` が `completed` に化けて auto-PR まで
          // 走ってしまう（ユーザーは止めたつもりでいる）。
          return;
        }
        if (stop !== undefined && stop !== 'end_turn') {
          // `max_tokens` / `max_turn_requests` / `refusal`。失敗ではないので
          // 理由を 1 行残して完了にする（そのまま追加指示を送れる）。
          events.push({ kind: 'notice', text: `stopped: ${stop}` });
        }
        events.push({ kind: 'turn_completed', text: '' });
      };

      /** プロンプトの流れを 1 本のターン列として回す。 */
      const drive = async (): Promise<void> => {
        try {
          for await (const text of request.prompt) {
            if (request.abortController.signal.aborted) {
              return;
            }
            interrupted = false;
            cancelPending = false;
            lastErrorType = undefined;
            if (!proc) {
              try {
                await start();
              } catch (error) {
                const detail = error instanceof Error ? error.message : String(error);
                // プロセスは `start()` が畳んである（次のターンで起こし直せる）。
                events.push({
                  kind: 'turn_stopped',
                  cause: AUTH_REQUIRED.test(detail) ? 'auth' : grokStopCause(detail),
                  detail,
                });
                continue;
              }
            }
            await runTurn(text);
          }
        } catch (error: unknown) {
          // **`finally` で閉じる前に積む**。閉じたキューへの push は黙って捨てられる
          // ので、外側の `.catch()` に任せると理由がどこにも残らない。
          if (!request.abortController.signal.aborted) {
            const detail = error instanceof Error ? error.message : String(error);
            events.push({
              kind: 'turn_stopped',
              cause: grokStopCause(detail, lastErrorType),
              detail,
            });
          }
        } finally {
          events.close();
        }
      };

      const abort = () => {
        proc?.kill();
        events.close();
      };
      request.abortController.signal.addEventListener('abort', abort, { once: true });

      // `drive` は自分で catch するので、ここは保険（未処理 rejection で TUI を
      // 落とさないため）。
      void drive().catch(() => {
        events.close();
      });

      return {
        async *[Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
          try {
            for await (const event of events) {
              yield event;
            }
          } finally {
            request.abortController.signal.removeEventListener('abort', abort);
            // 消費側に捨てられたら CLI も畳む（worktree を触り続けさせない）。
            proc?.kill();
          }
        },

        interrupt: async () => {
          interrupted = true;
          // `session/cancel` は**通知**（id を付けると Method not found になる。実測）。
          if (sessionId) {
            notify('session/cancel', { sessionId });
            return;
          }
          // まだ `session/new` の最中。ここで黙って何もしないと、UI は「中断した」と
          // 言っているのにエージェントは走り切り、完了扱いで auto-PR まで進む。
          // セッションが確立し次第送れるよう予約しておく。
          cancelPending = true;
        },

        setModel: async (next) => {
          model = next;
          if (!sessionId || !proc || next === undefined) {
            // 「既定に戻す」は次のセッションから（ACP に「既定へ戻す」要求は無い）。
            return;
          }
          const response = await rpc('session/set_model', { sessionId, modelId: next });
          if (response.kind === 'response') {
            events.push({ kind: 'model_resolved', model: next });
          }
        },
      };
    },
  };
}
