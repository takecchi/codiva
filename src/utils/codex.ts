import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import {
  type AgentAvailability,
  type CodexProcess,
  type CodexSpawnRequest,
  createJsonlSplitter,
  type ModelOption,
  toCodexModelOptions,
} from '@/core';
import { childProcessEnv } from './child-env';

const execFileAsync = promisify(execFile);

/**
 * `codex exec --json` の起動（唯一の I/O 実装）。純粋な写像は `core/codex-parse.ts`、
 * アダプタの制御は `core/codex-adapter.ts` にある。
 *
 * `gh` / `git` と同じ方針で **ユーザーがインストールした `codex` を起動する**
 * （`@openai/codex` を依存に持たない）。認証もユーザーの `codex login` に従う。
 */

/** stderr をどれだけ覚えておくか（失敗理由の診断用。ログの氾濫は防ぐ）。 */
const MAX_STDERR_CHARS = 4000;

/** SIGTERM で死ななかったときに SIGKILL へ上げるまでの猶予。 */
const KILL_ESCALATE_MS = 2000;

/**
 * 1 行（= 1 JSON イベント）の上限。`command_execution` は `aggregated_output` を
 * 丸ごと 1 行で運ぶので、長時間走るビルドの出力が数十 MB の 1 行になりうる。
 * バッファに溜め切ってから `JSON.parse` すると**同じものを 2 部**ヒープに置くことに
 * なるため、超えた行は捨てる（このリポジトリは同種の積み上げで実際に OOM している）。
 */
const MAX_LINE_CHARS = 1024 * 1024;

/** `codex exec` の引数を組み立てる。**シェルは使わない**（引数配列で渡す）。 */
export function codexArgs(request: CodexSpawnRequest): string[] {
  const args = [
    'exec',
    '--json',
    // codiva の worktree は自分で作った git worktree なので信頼してよい。linked worktree の
    // `.git` は**ファイル**なので、CLI 側のリポジトリ判定に引っかかる余地を残さない。
    '--skip-git-repo-check',
    '--sandbox',
    request.sandbox,
    // 承認要求は exec の JSON モードでは上げられない（CLI が自動 reject する）ので、
    // 明示的に never にして「聞かれて止まる」経路を作らない。
    '-c',
    'approval_policy="never"',
  ];
  if (request.sandbox === 'workspace-write') {
    // 既定でネットワークが遮断されると `npm install` / `gh` が失敗する。
    args.push('-c', `sandbox_workspace_write.network_access=${request.networkAccess}`);
  }
  if (request.model) {
    args.push('--model', request.model);
  }
  if (request.effort) {
    args.push('-c', `model_reasoning_effort="${request.effort}"`);
  }
  // `codex exec [OPTIONS] resume <id> <prompt>`。オプションは global なので前に置ける。
  if (request.resume) {
    args.push('resume', request.resume);
  }
  // **指示文の前に `--` を必ず置く**。ユーザーの入力は任意の文字列で、`-` で始まると
  // clap がオプションとして解釈して起動が失敗する（実測: `--fix the thing` で
  // "error: unexpected argument"）。`--` 以降は必ず値として扱われる。
  args.push('--', request.prompt);
  return args;
}

/**
 * 1 ターンぶんの `codex exec` を起動する。stdout を行単位に割って JSON を流す。
 *
 * stdin は **`'ignore'`（= 空）**にする — 引数で指示文を渡していても、
 * codex はパイプされた stdin を追加入力として読もうとしてブロックする。
 *
 * `env` は `childProcessEnv()`。エージェントのシェルはこのプロセスの子なので、
 * codiva が立てた `NODE_ENV=production` を継がせない（issue #103）。
 */
export function spawnCodex(request: CodexSpawnRequest, command = 'codex'): CodexProcess {
  const child = spawn(command, codexArgs(request), {
    cwd: request.cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: childProcessEnv(),
  });

  let stderr = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    // **必ず上限で切る**。1 チャンクは 64KB になりうるので `if (短ければ足す)` だけだと
    // その 1 回で大きく超え、それがそのまま `turn_stopped.detail` → `state.error` に載る
    // （ログ行と違って state.error はクリップされない）。
    if (stderr.length < MAX_STDERR_CHARS) {
      stderr = (stderr + chunk).slice(0, MAX_STDERR_CHARS);
    }
  });
  // パイプ自体のエラー（kill/exit 前後の EPIPE・ECONNRESET）。**listener が無いと
  // EventEmitter は throw し、TUI ではプロセス死になる**（stdout は for-await 中の
  // 非同期イテレータが面倒を見るので、素の emitter はここだけ）。
  child.stderr?.on('error', () => {
    // 診断以上の意味は無いので握り潰す。
  });

  let code: number | null = null;
  let spawnError: Error | undefined;
  child.on('error', (err) => {
    // `codex` が入っていない等。ストリームは close で閉じるので、理由だけ残す。
    spawnError = err;
  });

  async function* lines(): AsyncGenerator<unknown> {
    // 枠切りは純粋な `createJsonlSplitter`（`core/codex-events.ts`）へ委譲する。
    const splitter = createJsonlSplitter(MAX_LINE_CHARS);
    child.stdout?.setEncoding('utf8');
    // stdout が尽きるまで読む。プロセスの終了は下で待つ。
    for await (const chunk of child.stdout ?? []) {
      for (const event of splitter.push(chunk as string)) {
        yield event;
      }
    }
    for (const event of splitter.flush()) {
      yield event;
    }
    // 終了コードが確定するまで待つ（`result()` が読めるようにする）。
    // `'close'` は**全 stdio が閉じてから**なので、それだけに賭けない — 何かが stderr を
    // 掴んだままだとターンが永久に止まる。`'exit'` でも解決させる（どちらか早い方）。
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
    kill: () => {
      if (child.exitCode !== null || child.signalCode !== null) {
        return;
      }
      child.kill('SIGTERM');
      // SIGTERM を無視するプロセスに備えて追い討ちをかける。掛けないと stdout が
      // 閉じず `for await` が返らないため、**ターンが二度と進まない**（中断したはずの
      // セッションへ次の指示を送っても、その裏で古いループが生き続ける）。
      const escalate = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL');
        }
      }, KILL_ESCALATE_MS);
      // TUI を終了させない（タイマーだけでイベントループを起こし続けない）。
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
 * `codex debug models` の出力上限。カタログは `base_instructions`（モデルごとの
 * システムプロンプト全文）を含むため実測で ~280KB ある。既定の maxBuffer では
 * 足りないので明示的に広げる。
 */
const CATALOG_MAX_BUFFER = 8 * 1024 * 1024;

/** カタログ取得のタイムアウト（`fetchModelCatalog` と揃える）。 */
const CATALOG_TIMEOUT_MS = 10_000;

/**
 * Codex が選べるモデルの一覧を取得する（`/model` の選択肢）。
 *
 * `codex debug models` はローカルのモデルカタログを JSON で吐くだけで、**推論は
 * 走らない**（トークン消費もコストも無い）。Claude 側の `fetchModelCatalog` と
 * 同じく、失敗・タイムアウトでは投げずに空配列を返す（呼び出し側がフォールバックする）。
 */
export async function fetchCodexModelCatalog(opts?: {
  cwd?: string;
  signal?: AbortSignal;
  command?: string;
}): Promise<ModelOption[]> {
  try {
    const { stdout } = await execFileAsync(opts?.command ?? 'codex', ['debug', 'models'], {
      cwd: opts?.cwd,
      signal: opts?.signal,
      maxBuffer: CATALOG_MAX_BUFFER,
      timeout: CATALOG_TIMEOUT_MS,
      env: childProcessEnv(),
    });
    return toCodexModelOptions(JSON.parse(stdout) as unknown);
  } catch {
    // `codex` 未導入・タイムアウト・JSON 破損。どれも /model を壊さない。
    return [];
  }
}

/** 導入・ログイン確認の上限（サブプロセスが固まっても TUI を止めない）。 */
const PROBE_TIMEOUT_MS = 4000;

/**
 * Codex CLI が使える状態かを調べる（`AgentAdapter.checkAvailability` の実体）。
 *
 * - 導入: `codex --version` が 0 で返るか（PATH 直読みより確実 — shim・alias も拾える）。
 * - ログイン: `codex login status` の終了コード。**資格情報の有無**を見るだけで、
 *   トークンの有効性までは分からない（期限切れはセッション実行時に `needs_login` で出る）。
 *
 * throw しない（すべて「導入なし / ログイン不明」へ倒す）。
 */
export async function detectCodexAvailability(command = 'codex'): Promise<AgentAvailability> {
  const probe = { timeout: PROBE_TIMEOUT_MS, env: childProcessEnv() };
  const installed = await execFileAsync(command, ['--version'], probe)
    .then(() => true)
    .catch(() => false);
  if (!installed) {
    return { installed: false, loggedIn: false };
  }
  const loggedIn = await execFileAsync(command, ['login', 'status'], probe)
    .then(() => true)
    .catch(() => false);
  return { installed: true, loggedIn };
}
