import { execFile, spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  type AgentAvailability,
  createJsonlSplitter,
  type GrokProcess,
  type GrokSpawnRequest,
  type ModelOption,
  toGrokModelOptions,
  toGrokModelState,
} from '@/core';
import { childProcessEnv } from './child-env';

const execFileAsync = promisify(execFile);

/**
 * `grok agent stdio` の起動（唯一の I/O 実装）。純粋な写像は `core/grok-parse.ts`、
 * 制御は `core/grok-adapter.ts` にある。
 *
 * `gh` / `git` / `codex` と同じ方針で **ユーザーがインストールした `grok` を起動する**
 * （xAI の CLI を依存に持たない）。認証もユーザーの `grok login` に従う。
 */

/** stderr をどれだけ覚えておくか（失敗理由の診断用。ログの氾濫は防ぐ）。 */
const MAX_STDERR_CHARS = 4000;

/** SIGTERM で死ななかったときに SIGKILL へ上げるまでの猶予。 */
const KILL_ESCALATE_MS = 2000;

/**
 * 1 行（= JSON-RPC 1 通）の上限。ツール出力は `tool_call_update` に丸ごと載るので、
 * 長時間走るビルドの出力が数 MB の 1 行になりうる。
 */
const MAX_LINE_CHARS = 1024 * 1024;

/** 導入・ログイン検出のタイムアウト。 */
const PROBE_TIMEOUT_MS = 5000;

/** モデルカタログ取得のタイムアウト（Claude / Codex 側と揃える）。 */
const CATALOG_TIMEOUT_MS = 10_000;

/**
 * `grok agent stdio` の引数。**サブコマンドより前に置く必要がある**フラグがあるので
 * （`grok agent --reasoning-effort high stdio`）、順序を変えない。
 */
export function grokAgentArgs(request: GrokSpawnRequest): string[] {
  const args = ['agent'];
  if (request.effort) {
    args.push('--reasoning-effort', request.effort);
  }
  // 共有 leader プロセスに相乗りしない。codiva は worktree ごとに独立した
  // セッションを持つので、他のクライアントと backend を共有する意味が無い
  // （相乗りすると別セッションの状態変化まで流れ込む）。
  args.push('--no-leader', 'stdio');
  return args;
}

/** `grok agent stdio` を起動する。**シェルは使わない**（引数配列で渡す）。 */
export function spawnGrok(request: GrokSpawnRequest, command = 'grok'): GrokProcess {
  const child = spawn(command, grokAgentArgs(request), {
    cwd: request.cwd,
    // stdin へ JSON-RPC を書くので pipe（Codex と違い双方向）。
    stdio: ['pipe', 'pipe', 'pipe'],
    env: childProcessEnv(),
  });

  let stderr = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    // **必ず上限で切る**。1 チャンクは 64KB になりうる（`turn_stopped.detail` は
    // ログ行と違ってクリップされない）。
    if (stderr.length < MAX_STDERR_CHARS) {
      stderr = (stderr + chunk).slice(0, MAX_STDERR_CHARS);
    }
  });
  // パイプ自体のエラー（kill/exit 前後の EPIPE）。listener が無いと EventEmitter は
  // throw し、TUI ではプロセス死になる。
  child.stderr?.on('error', () => {});
  child.stdin?.on('error', () => {});

  let code: number | null = null;
  let spawnError: Error | undefined;
  child.on('error', (err) => {
    // `grok` が入っていない等。ストリームは close で閉じるので理由だけ残す。
    spawnError = err;
  });

  async function* lines(): AsyncGenerator<unknown> {
    const splitter = createJsonlSplitter(MAX_LINE_CHARS);
    child.stdout?.setEncoding('utf8');
    for await (const chunk of child.stdout ?? []) {
      for (const message of splitter.push(chunk as string)) {
        yield message;
      }
    }
    for (const message of splitter.flush()) {
      yield message;
    }
    code = await new Promise<number | null>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve(child.exitCode);
        return;
      }
      child.once('close', (c) => resolve(c));
      child.once('exit', (c) => resolve(c));
    });
  }

  return {
    [Symbol.asyncIterator]: () => lines()[Symbol.asyncIterator](),
    send: (message: unknown) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        return;
      }
      // 書けなくても落とさない（相手が既に死んでいるだけ。要求側は応答待ちの
      // タイムアウトではなくプロセス終了で起こされる）。
      child.stdin?.write(`${JSON.stringify(message)}\n`, () => {});
    },
    kill: () => {
      if (child.exitCode !== null || child.signalCode !== null) {
        return;
      }
      child.kill('SIGTERM');
      // SIGTERM を無視されると stdout が閉じず `for await` が返らない（= ターンが
      // 二度と進まない）ので追い討ちをかける。
      const escalate = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL');
        }
      }, KILL_ESCALATE_MS);
      escalate.unref?.();
      child.once('exit', () => clearTimeout(escalate));
    },
    result: () => ({
      code,
      stderr: spawnError ? `${spawnError.message}\n${stderr}` : stderr,
    }),
  };
}

/**
 * `grok` の設定・資格情報の置き場（`GROK_HOME` で移せる）。
 *
 * **空文字は「未設定」として扱う**（`codexHome()` と同じ）。`?? ` だけだと
 * `GROK_HOME=""` で `auth.json` を**相対パス**で読みに行き、リポジトリに同名の
 * ファイルがあるだけで「ログイン済み」と誤判定する。
 */
function grokHome(): string {
  const home = process.env.GROK_HOME?.trim();
  return home && home.length > 0 ? home : join(homedir(), '.grok');
}

/**
 * `grok` が使える状態か。
 *
 * - 導入判定は `grok --version`（Codex / Claude と同じ）。
 * - ログイン判定は**資格情報の有無**。`grok models` は未認証でも終了コード 0 を返す
 *   （実測）ので使えず、`grok -p ...` は本物の推論を 1 回走らせてしまう。`grok login`
 *   が書く `~/.grok/auth.json`（`GROK_HOME` 尊重）か `XAI_API_KEY` の有無で見る。
 *   トークンの有効性までは見ない（期限切れはセッション実行時に `needs_login` として現れる）。
 */
export async function detectGrokAvailability(command = 'grok'): Promise<AgentAvailability> {
  const installed = await execFileAsync(command, ['--version'], {
    timeout: PROBE_TIMEOUT_MS,
    env: childProcessEnv(),
  })
    .then(() => true)
    .catch(() => false);
  if (!installed) {
    return { installed: false, loggedIn: false };
  }
  if ((process.env.XAI_API_KEY ?? '').trim().length > 0) {
    return { installed: true, loggedIn: true };
  }
  const loggedIn = await access(join(grokHome(), 'auth.json'))
    .then(() => true)
    .catch(() => false);
  return { installed: true, loggedIn };
}

/**
 * Grok が選べるモデルの一覧を取得する（`/model` の選択肢）。
 *
 * `grok models` は人間向けのテキストしか出さない（`--json` は無い。実測）ので、
 * **ACP の `initialize` 応答**（`_meta.modelState`）から取る。推論は走らないし
 * セッションも作らない（`session/new` を呼ばずに落とす）ので、コストはプロセス
 * 起動ぶんだけ。Claude / Codex 側と同じく、失敗・タイムアウトでは投げずに空配列を返す。
 */
export function fetchGrokModelCatalog(opts?: {
  cwd?: string;
  signal?: AbortSignal;
  command?: string;
  spawnFn?: (request: GrokSpawnRequest, command?: string) => GrokProcess;
}): Promise<ModelOption[]> {
  const spawnFn = opts?.spawnFn ?? spawnGrok;
  return new Promise<ModelOption[]>((resolve) => {
    let proc: GrokProcess | undefined;
    let done = false;
    const finish = (options: ModelOption[]): void => {
      if (done) {
        return;
      }
      done = true;
      clearTimeout(timer);
      opts?.signal?.removeEventListener('abort', onAbort);
      proc?.kill();
      resolve(options);
    };
    const onAbort = () => finish([]);
    const timer = setTimeout(() => finish([]), CATALOG_TIMEOUT_MS);
    timer.unref?.();
    opts?.signal?.addEventListener('abort', onAbort, { once: true });

    try {
      proc = spawnFn({ cwd: opts?.cwd ?? process.cwd() }, opts?.command);
    } catch {
      finish([]);
      return;
    }
    proc.send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      },
    });
    void (async () => {
      try {
        for await (const raw of proc) {
          if (typeof raw !== 'object' || raw === null) {
            continue;
          }
          const result = (raw as { id?: unknown; result?: unknown }).result;
          if ((raw as { id?: unknown }).id !== 1 || typeof result !== 'object' || result === null) {
            continue;
          }
          const meta = (result as { _meta?: { modelState?: unknown } })._meta;
          finish(toGrokModelOptions(toGrokModelState(meta?.modelState)));
          return;
        }
      } catch {
        // 読めなければフォールバックさせる。
      }
      finish([]);
      // `finish` の中で throw しても TUI を落とさない（未処理の rejection は
      // プロセス死になる）。
    })().catch(() => finish([]));
  });
}
