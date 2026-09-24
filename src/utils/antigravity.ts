import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import {
  type AgentAvailability,
  type AntigravityProcess,
  type AntigravitySpawnRequest,
  createJsonlSplitter,
  type EffortLevel,
  type PermissionMode,
} from '@/core';
import { childProcessEnv } from './child-env';

const execFileAsync = promisify(execFile);

/**
 * Antigravity CLI（`agy`）の起動（唯一の I/O 実装）。純粋な写像は
 * `core/antigravity-parse.ts`、アダプタの制御は `core/antigravity-adapter.ts` にある。
 *
 * `git` / `gh` / `codex` と同じ方針で **ユーザーがインストールした `agy` を起動する**
 * （Google のバイナリを同梱しない）。認証もユーザーのサインインに従う。
 *
 * **実測（agy 1.2.10, darwin/arm64）**:
 * - `agy --version` → `1.2.10` / exit 0
 * - `agy models`（未サインイン）→ exit 1 +
 *   `Error: Please sign in to view available models. Launch the CLI without arguments to sign in.`
 * - `agy --print --input-format stream-json …` は **`--print` が次のフラグを
 *   プロンプトとして食う**（`Error: --print took "--input-format" as its prompt …`）。
 *   そのため `--print` は渡さず、`--input-format=stream-json` だけで print モードに入る
 *   （stdin がパイプのとき実際に stream-json の `result` が返ることを確認済み）。
 *   値を取るフラグは**すべて `--flag=value` 形**にして、同じ食い違いを起こさない。
 */

/** stderr をどれだけ覚えておくか（失敗理由の診断用。ログの氾濫は防ぐ）。 */
const MAX_STDERR_CHARS = 4000;

/** SIGTERM で死ななかったときに SIGKILL へ上げるまでの猶予。 */
const KILL_ESCALATE_MS = 2000;

/**
 * 1 行（= 1 JSON イベント）の上限。`step_update.tool_info.output` はコマンド出力を
 * 丸ごと 1 行で運ぶので、長時間走るビルドの出力が巨大な 1 行になりうる。
 * 溜め切ってから `JSON.parse` すると**同じものを 2 部**ヒープに置くことになるため、
 * 超えた行は捨てる（このリポジトリは同種の積み上げで実際に OOM している）。
 */
const MAX_LINE_CHARS = 1024 * 1024;

/**
 * codiva の effort（5 段）→ `agy --effort`（3 段）。
 * `agy` は `low|medium|high` しか受けないので、上 3 段は `high` に丸める。
 */
function toAgyEffort(effort: EffortLevel | undefined): string | undefined {
  switch (effort) {
    case 'low':
      return 'low';
    case 'medium':
      return 'medium';
    case 'high':
    case 'xhigh':
    case 'max':
      return 'high';
    default:
      return undefined;
  }
}

/**
 * codiva の許可モード → `agy` の実行モード。
 *
 * **`--dangerously-skip-permissions` を既定にしない**（issue #140）。全許可は
 * ユーザーが `permissionMode: "bypassPermissions"` を明示したときだけに限り、
 * それ以外は `--mode=accept-edits`（codiva の既定 `acceptEdits` に対応）へ倒す。
 */
export function antigravityModeArgs(mode: PermissionMode | undefined): string[] {
  switch (mode) {
    case 'plan':
      return ['--mode=plan'];
    case 'bypassPermissions':
      return ['--dangerously-skip-permissions'];
    default:
      return ['--mode=accept-edits'];
  }
}

/** `agy` の引数を組み立てる。**シェルは使わない**（引数配列で渡す）。 */
export function antigravityArgs(request: AntigravitySpawnRequest): string[] {
  const args = ['--input-format=stream-json', '--output-format=stream-json'];
  // 0 は「ターンが終わるまで待つ」。既定も 0 だが、将来変わっても止まらないよう明示する。
  args.push('--print-timeout=0');
  args.push(...antigravityModeArgs(request.permissionMode));
  if (request.model) {
    args.push(`--model=${request.model}`);
  }
  const effort = toAgyEffort(request.effort);
  if (effort) {
    args.push(`--effort=${effort}`);
  }
  if (request.resume) {
    args.push(`--conversation=${request.resume}`);
  }
  return args;
}

/**
 * 1 セッションぶんの `agy` を起動する。stdout を行単位に割って JSON を流し、
 * stdin へ NDJSON の指示を 1 行ずつ書く。
 *
 * `env` は `childProcessEnv()`。エージェントのシェルはこのプロセスの子なので、
 * codiva が立てた `NODE_ENV=production` を継がせない（issue #103）。
 */
export function spawnAntigravity(
  request: AntigravitySpawnRequest,
  command = 'agy',
): AntigravityProcess {
  const child = spawn(command, antigravityArgs(request), {
    cwd: request.cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: childProcessEnv(),
  });

  let stderr = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    // **必ず上限で切る**。1 チャンクは 64KB になりうるので、切らないと
    // そのまま `turn_stopped.detail` → `state.error` に載る（クリップされない）。
    if (stderr.length < MAX_STDERR_CHARS) {
      stderr = (stderr + chunk).slice(0, MAX_STDERR_CHARS);
    }
  });
  // パイプ自体のエラー（kill/exit 前後の EPIPE・ECONNRESET）。**listener が無いと
  // EventEmitter は throw し、TUI ではプロセス死になる**。
  child.stderr?.on('error', () => {
    // 診断以上の意味は無いので握り潰す。
  });
  child.stdin?.on('error', () => {
    // 死んだプロセスへの書き込み（EPIPE）。ターンの決着は stdout 側で判断する。
  });

  let code: number | null = null;
  let spawnError: Error | undefined;
  child.on('error', (err) => {
    // `agy` が入っていない等。ストリームは close で閉じるので、理由だけ残す。
    spawnError = err;
  });

  async function* lines(): AsyncGenerator<unknown> {
    const splitter = createJsonlSplitter(MAX_LINE_CHARS);
    child.stdout?.setEncoding('utf8');
    for await (const chunk of child.stdout ?? []) {
      for (const event of splitter.push(chunk as string)) {
        yield event;
      }
    }
    for (const event of splitter.flush()) {
      yield event;
    }
    // 終了コードが確定するまで待つ（`result()` が読めるようにする）。
    // `'close'` は全 stdio が閉じてからなので、それだけに賭けない（`'exit'` でも解決）。
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
      child.stdin?.write(`${JSON.stringify(message)}\n`);
    },
    endInput: () => {
      child.stdin?.end();
    },
    alive: () => child.exitCode === null && child.signalCode === null,
    kill: () => {
      if (child.exitCode !== null || child.signalCode !== null) {
        return;
      }
      child.kill('SIGTERM');
      // SIGTERM を無視するプロセスに備えて追い討ちをかける。掛けないと stdout が
      // 閉じず `for await` が返らないため、**ターンが二度と進まない**。
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

/** 導入・ログイン確認の上限（サブプロセスが固まっても TUI を止めない）。 */
const PROBE_TIMEOUT_MS = 4000;

/**
 * ログイン確認に使う `agy models` の上限。**`--version` より長く取る** — こちらは
 * ネットワーク越しにモデル一覧を取りに行くため（実測で数秒かかる）。
 */
const LOGIN_PROBE_TIMEOUT_MS = 8000;

/**
 * 未サインインのときだけ返る文言（実測）。これに当たったときだけ「未ログイン」と
 * 断定し、それ以外の失敗（オフライン・タイムアウト・未知のエラー）は **`'unknown'`**
 * に倒す（規約: 確実に判定できないなら案内を出さない側へ）。
 */
const SIGN_IN_RE = /\b(?:please sign in|sign in to view|not signed in|authentication required)\b/i;

/**
 * Antigravity CLI が使える状態かを調べる（`AgentAdapter.checkAvailability` の実体）。
 *
 * - 導入: `agy --version` が 0 で返るか（PATH 直読みより確実 — shim・alias も拾える）。
 * - ログイン: `agy models` の終了コードと文言。**成功なら true、「サインインしろ」と
 *   言われたら false、それ以外は `'unknown'`**。ネットワーク不通で未ログイン扱いに
 *   すると、使えるはずのエージェントに誤った案内を出してしまう。
 *
 * throw しない（すべて「導入なし / ログイン不明」へ倒す）。
 */
export async function detectAntigravityAvailability(command = 'agy'): Promise<AgentAvailability> {
  const installed = await execFileAsync(command, ['--version'], {
    timeout: PROBE_TIMEOUT_MS,
    env: childProcessEnv(),
  })
    .then(() => true)
    .catch(() => false);
  if (!installed) {
    return { installed: false, loggedIn: false };
  }
  try {
    await execFileAsync(command, ['models'], {
      timeout: LOGIN_PROBE_TIMEOUT_MS,
      env: childProcessEnv(),
    });
    return { installed: true, loggedIn: true };
  } catch (err) {
    // `execFile` の失敗は stdout/stderr を持つ（タイムアウト時は持たないこともある）。
    const detail = `${(err as { stdout?: string }).stdout ?? ''}${(err as { stderr?: string }).stderr ?? ''}${(err as Error).message ?? ''}`;
    return { installed: true, loggedIn: SIGN_IN_RE.test(detail) ? false : 'unknown' };
  }
}
