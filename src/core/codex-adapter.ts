import type { AgentEvent } from './agent-events';
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

/** `AgentAdapter` を Codex 用に組み立てる。`spawn` は DI（テストはフェイクを注入）。 */
export function createCodexAdapter(deps: {
  spawn: CodexSpawn;
  sandbox?: CodexSandbox;
  networkAccess?: boolean;
  generateTitle?: (prompt: string) => Promise<string | null | undefined>;
  /** 導入・ログイン検出（I/O は `utils/codex.ts` の `detectCodexAvailability`）。 */
  checkAvailability?: () => Promise<AgentAvailability>;
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
      let model = request.options.model;
      // `Ctrl+C` で殺したターンは失敗ではない（Session が先に `interrupted` を確定させる）。
      let interrupted = false;
      let current: CodexProcess | undefined;

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
              const prompt = threadId ? text : withSystemPrompt(text, request.options.systemPrompt);

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
                  } else if (event.type === 'turn.completed' || event.type === 'turn.failed') {
                    sawTerminal = true;
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

              if (interrupted || request.abortController.signal.aborted) {
                // 中断は Session 側で既に `interrupted` を確定させてある。
                continue;
              }
              if (!sawTerminal) {
                const { code, stderr } = proc.result();
                const detail = stderr.trim() || `codex exited with code ${code ?? 'null'}`;
                yield code === 0
                  ? { kind: 'turn_completed', text: '' }
                  : { kind: 'turn_stopped', cause: classifyCodexError(detail), detail };
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
        },
      };
    },
  };
}
