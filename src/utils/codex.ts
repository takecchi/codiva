import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import {
  type CodexProcess,
  type CodexSpawnRequest,
  type ModelOption,
  toCodexModelOptions,
} from '@/core';

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
 */
export function spawnCodex(request: CodexSpawnRequest, command = 'codex'): CodexProcess {
  const child = spawn(command, codexArgs(request), {
    cwd: request.cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stderr = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    if (stderr.length < MAX_STDERR_CHARS) {
      stderr += chunk;
    }
  });

  let code: number | null = null;
  let spawnError: Error | undefined;
  child.on('error', (err) => {
    // `codex` が入っていない等。ストリームは close で閉じるので、理由だけ残す。
    spawnError = err;
  });

  async function* lines(): AsyncGenerator<unknown> {
    let buffer = '';
    child.stdout?.setEncoding('utf8');
    // stdout が尽きるまで読む。プロセスの終了は下の `closed` で待つ。
    for await (const chunk of child.stdout ?? []) {
      buffer += chunk as string;
      let nl = buffer.indexOf('\n');
      while (nl !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line.length > 0) {
          try {
            yield JSON.parse(line);
          } catch {
            // JSONL 以外の行（想定外）は捨てる。TUI を落とさない。
          }
        }
        nl = buffer.indexOf('\n');
      }
    }
    const tail = buffer.trim();
    if (tail.length > 0) {
      try {
        yield JSON.parse(tail);
      } catch {
        // 末尾の切れた行は捨てる。
      }
    }
    // 終了コードが確定するまで待つ（`result()` が読めるようにする）。
    code = await new Promise<number | null>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve(child.exitCode);
        return;
      }
      child.once('close', (c) => resolve(c));
    });
  }

  return {
    [Symbol.asyncIterator]: () => lines()[Symbol.asyncIterator](),
    kill: () => {
      child.kill('SIGTERM');
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
    });
    return toCodexModelOptions(JSON.parse(stdout) as unknown);
  } catch {
    // `codex` 未導入・タイムアウト・JSON 破損。どれも /model を壊さない。
    return [];
  }
}
