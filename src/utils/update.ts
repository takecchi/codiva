import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  canSelfUpdate,
  type InstallKind,
  isUpdateAvailable,
  resolveUpdateCheck,
  type UpdateCheck,
  type UpdateInfo,
  type UpdateRun,
  type UpdateService,
  updateCommandFor,
} from '@/core';
import { childProcessEnv } from './child-env';

const execFileAsync = promisify(execFile);

/** レジストリ問い合わせの上限。起動を待たせないので短くてよい。 */
const CHECK_TIMEOUT_MS = 3_000;
/** `npm install` の上限。tarball 取得を含むので長めに取る。 */
const INSTALL_TIMEOUT_MS = 180_000;

/**
 * npm レジストリの「最新版だけ」を返すエンドポイント。パッケージ全体の
 * packument（codiva で実測 21KB、バージョンが増え続ける）ではなく `latest` タグの
 * 1 バージョン分（実測 2.3KB）で済むので、こちらを使う。認証は不要。
 */
function latestUrl(pkg: string): string {
  return `https://registry.npmjs.org/${encodeURIComponent(pkg)}/latest`;
}

/** `/latest` レスポンスのうち読む唯一のフィールド。 */
interface LatestJson {
  version?: unknown;
}

function toVersion(json: unknown): string | undefined {
  if (typeof json !== 'object' || json === null) {
    return undefined;
  }
  const version = (json as LatestJson).version;
  return typeof version === 'string' && version.trim().length > 0 ? version.trim() : undefined;
}

/**
 * npm レジストリから `latest` タグのバージョンを取る。**throw しない**
 * （オフライン・DNS 失敗・レジストリ障害・タイムアウトはすべて undefined）。
 *
 * タイムアウトは自前の AbortController で決着させる（`AbortSignal.any` は
 * Node 20.3+ で、engines の `>=20` を満たさない環境があるため使わない）。
 * タイマーは unref するので、取得中に終了してもプロセスを生かし続けない。
 */
export async function fetchLatestVersion(
  pkg: string,
  opts: { signal?: AbortSignal; fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<string | undefined> {
  const doFetch = opts.fetchImpl ?? globalThis.fetch;
  if (typeof doFetch !== 'function') {
    return undefined;
  }
  // 既に abort 済みのシグナルには 'abort' が飛んでこないので、先に弾く
  // （終了処理のあとにチェックを始めても通信しない）。
  if (opts.signal?.aborted) {
    return undefined;
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  opts.signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, opts.timeoutMs ?? CHECK_TIMEOUT_MS);
  timer.unref?.();
  try {
    const res = await doFetch(latestUrl(pkg), {
      signal: controller.signal,
      // 省略版の packument を明示。`/latest` では実質同じだが、レジストリ側の
      // キャッシュに乗りやすい標準ヘッダなので付けておく。
      headers: { accept: 'application/vnd.npm.install-v1+json, application/json' },
    });
    if (!res.ok) {
      // 読まないボディはソケットを掴んだままになるので明示的に捨てる。
      await res.body?.cancel().catch(() => {});
      return undefined;
    }
    return toVersion(await res.json());
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', abort);
  }
}

/** `a` が `b` の中（または同一）かを OS のパス区切りで判定する。 */
function isInside(parent: string, child: string): boolean {
  const p = resolve(parent);
  const c = resolve(child);
  return c === p || c.startsWith(p.endsWith(sep) ? p : p + sep);
}

/**
 * node のインストール先から推測されるグローバル `node_modules`。
 * posix は `<prefix>/lib/node_modules`、Windows は `<prefix>/node_modules`
 * （`global-dirs` パッケージと同じ導出。サブプロセスを起こさずに済ませたい）。
 */
function globalNodeModules(execPath: string, platform: string): string {
  const binDir = dirname(execPath);
  return platform === 'win32'
    ? join(binDir, 'node_modules')
    : join(dirname(binDir), 'lib', 'node_modules');
}

/**
 * 使い捨て実行（npx / dlx / bunx）のキャッシュを示すディレクトリ名か。
 * bun のキャッシュは `bunx-<uid>-<pkg>` 形なので uid まで含めて照合する
 * （`bunx-` の前方一致だけだと `bunx-tools` のような普通のディレクトリを誤検出する）。
 */
function isDisposableSegment(segment: string): boolean {
  return (
    segment === '_npx' || segment === 'dlx' || segment === '.dlx' || /^bunx-\d+-/.test(segment)
  );
}

/**
 * 実行中の codiva がどう入っているかを判定する（パス比較のみ・I/O なし）。
 * 環境依存の入力（`packageRoot` / `execPath` / `cwd` / `platform`）は引数で受けるので
 * テストしやすい（`utils/notify.ts` の `notifyCommand(spec, platform)` と同じ方針）。
 *
 * 返すのは「codiva が更新を実行してよい経路か」まで込みの判定で、確信が持てない
 * ものは必ず `'unknown'` に落とす。`'unknown'` では `npm install` を実行せず手順の
 * 提示だけに留めるので、**誤検出のコストは「自動化されない」だけ**（逆に取り違えると
 * 別の場所へ入れて環境を壊す）。`'global'` を名乗れなかったケースは
 * `resolveInstallKind` が `npm root -g` に問い合わせて拾い直す。
 *
 * Windows では `'global'` を返さない。`npm` は `npm.cmd` で、Node 18.20/20.12 の
 * CVE-2024-27980 修正以降 `shell: true` なしに `.cmd` を spawn できないが、
 * シェル経由の実行はこのリポジトリの方針で禁止しているため（git-and-io.md）、
 * 実行はせずコマンドの提示に留める。
 */
export function installKindFor(input: {
  packageRoot: string;
  execPath: string;
  cwd: string;
  platform: string;
}): InstallKind {
  const root = resolve(input.packageRoot);
  // npx / dlx の使い捨てキャッシュ。npm は `<cache>/_npx/<hash>/node_modules/<pkg>`、
  // pnpm/yarn は `dlx`、bun は `bunx…` に展開する。ここへ `-g` するとキャッシュでは
  // なく本体を書き換えてしまうので、必ず先に弾く。判定は**パス要素の完全一致**で行う
  // （部分一致だと `/work/bunx-tools/…` のような無関係なパスを誤って npx と見なす）。
  if (root.split(sep).some(isDisposableSegment)) {
    return 'npx';
  }
  if (isInside(join(input.cwd, 'node_modules'), root)) {
    return 'local';
  }
  if (input.platform === 'win32') {
    return 'unknown';
  }
  // volta / asdf などのツールマネージャ配下は `npm i -g` の宛先が node の prefix と
  // 一致しないため、判定を主張せず手動案内に落とす。
  const segments = root.split(sep);
  if (segments.includes('.volta') || segments.includes('.asdf')) {
    return 'unknown';
  }
  if (isInside(globalNodeModules(input.execPath, input.platform), root)) {
    return 'global';
  }
  // ソースから直接動かしている開発時（tsx / npm run dev）や、node の prefix から
  // 導けない配置（homebrew の Cellar、`npm config set prefix`、pnpm/yarn global 等）。
  return 'unknown';
}

/**
 * 実行中バンドルの位置からパッケージルートを求める。呼ぶのは合成ルート
 * （dev が `src/main.tsx`、配信物が `dist/main-<hash>.js`）で、どちらも
 * `package.json` の 1 つ下なので親ディレクトリがパッケージルートになる
 * （`main.tsx` の `createRequire('../package.json')` と同じ前提）。
 *
 * `fileURLToPath` を使うのは、Windows で `URL.pathname` が `/C:/…` になり
 * パス比較（`isInside`）が成立しなくなるため。
 */
export function packageRootFrom(moduleUrl: string): string {
  return dirname(dirname(fileURLToPath(moduleUrl)));
}

/** 現在のプロセスから見たインストール経路。 */
export function detectInstallKind(packageRoot: string): InstallKind {
  return installKindFor({
    packageRoot,
    execPath: process.execPath,
    cwd: process.cwd(),
    platform: process.platform,
  });
}

/**
 * `execFile` の必要な部分だけ（テストでフェイクを注入するための seam）。
 * `pr.ts` の `ExecLike`（cwd を取る gh/git 用）とは別物なので名前を分けている。
 */
export type UpdateExec = (
  file: string,
  args: readonly string[],
  opts: { timeout: number; cwd: string },
) => Promise<{ stdout: string; stderr: string }>;

const defaultExec: UpdateExec = (file, args, opts) =>
  execFileAsync(file, [...args], {
    timeout: opts.timeout,
    cwd: opts.cwd,
    maxBuffer: 8 * 1024 * 1024,
    // `npm` を起こすので `NODE_ENV` を継がせない（`childProcessEnv()` の理由は issue #103）。
    env: childProcessEnv(),
  });

/** `npm root -g` の上限。npm の起動ぶんだけ見ておけば足りる。 */
const NPM_ROOT_TIMEOUT_MS = 15_000;

/**
 * npm 自身に聞いたグローバル `node_modules` のパス。**throw しない**（失敗は undefined）。
 *
 * `process.execPath` からの導出では拾えない配置（homebrew の Cellar、
 * `npm config set prefix` / `NPM_CONFIG_PREFIX`、pnpm/yarn の global）を拾うための
 * 最終手段。サブプロセスを 1 本起こすので、**静的判定が `unknown` のときだけ**呼ぶ。
 * cwd をホームに固定するのは、対象リポジトリの `.npmrc`（registry / prefix）に
 * 結果を左右されないため。
 */
export async function npmGlobalRoot(exec: UpdateExec = defaultExec): Promise<string | undefined> {
  try {
    const { stdout } = await exec('npm', ['root', '-g'], {
      timeout: NPM_ROOT_TIMEOUT_MS,
      cwd: homedir(),
    });
    const root = stdout.trim();
    return root.length > 0 ? root : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 静的判定を、必要なときだけ `npm root -g` で補強する。
 *
 * `installKindFor` が `'unknown'` を返したときに限り npm へ問い合わせ、そこに
 * 入っていれば `'global'` に格上げする。npm を唯一の出所にするので、
 * `prefix` を変えている環境でも「入っている場所」と「入れる場所」が一致する。
 */
export async function resolveInstallKind(
  packageRoot: string,
  staticKind: InstallKind,
  opts: { platform?: string; exec?: UpdateExec } = {},
): Promise<InstallKind> {
  if (staticKind !== 'unknown') {
    return staticKind;
  }
  // Windows は実行しない方針なので問い合わせる意味がない（installKindFor 参照）。
  if ((opts.platform ?? process.platform) === 'win32') {
    return 'unknown';
  }
  const root = await npmGlobalRoot(opts.exec);
  return root !== undefined && isInside(root, resolve(packageRoot)) ? 'global' : 'unknown';
}

/**
 * 更新コマンド（`npm install -g <pkg>@latest` など）を実行する。**throw しない**。
 * シェルは通さず argv で渡す（規約: git-and-io.md）。
 *
 * 実行するのは経路が確定しているとき（global / local）だけ。npx や判定不能では
 * `ok: false` を返し、UI は手動手順を出す。
 */
export async function runUpdate(
  info: UpdateInfo,
  opts: { exec?: UpdateExec; timeoutMs?: number } = {},
): Promise<UpdateRun> {
  // UI は `canSelfUpdate` な経路でしか確認を出さないので、ここは防御。理由の文字列は
  // 作らない（UI 側がカタログの「理由不明」を出す。規約: i18n.md）。
  if (!canSelfUpdate(info.install)) {
    return { ok: false, detail: '' };
  }
  const command = updateCommandFor(info.install, info.pkg);
  if (!command) {
    return { ok: false, detail: '' };
  }
  try {
    await (opts.exec ?? defaultExec)(command.file, command.args, {
      timeout: opts.timeoutMs ?? INSTALL_TIMEOUT_MS,
      // グローバル install を対象リポジトリの cwd で走らせると、そのリポジトリの
      // `.npmrc`（registry / prefix）に宛先を書き換えられてしまう。ホームに固定する。
      cwd: homedir(),
    });
    return { ok: true };
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    // stderr を握り潰さない（EACCES など、利用者が手を打つべき理由がここに出る）。
    // 取れなければ空文字を返し、UI がカタログの「理由不明」を出す。
    const detail = (e.stderr ?? '').trim() || (e.message ?? '').trim();
    // 1 行に畳んで UI の 1 行表示に載せる（npm のログは長大）。
    return { ok: false, detail: detail.split('\n').filter(Boolean).slice(-1)[0] ?? detail };
  }
}

/**
 * `UpdateService` の実装を組み立てる（合成ルートから注入する）。
 *
 * 起動時に 1 回チェックを投げ（`initial`。await しないので起動はブロックしない）、
 * `/update` を打つたびに `check()` で問い合わせ直す。どの経路も throw せず、
 * 失敗は `unavailable` / `ok: false` として返るので TUI を壊さない。
 */
export function createUpdateService(opts: {
  /** パッケージ名（レジストリのキー）。 */
  pkg: string;
  /** 実行中のバージョン（package.json 由来）。 */
  current: string | undefined;
  /** パス比較で分かったインストール経路（`installKindFor`）。 */
  install: InstallKind;
  /** バンドルの位置（`unknown` を `npm root -g` で拾い直すのに使う）。 */
  packageRoot?: string;
  /** 終了時に取得を打ち切るためのシグナル。 */
  signal?: AbortSignal;
  /** テスト用の seam。 */
  fetchImpl?: typeof fetch;
  exec?: UpdateExec;
}): UpdateService {
  // 経路の確定は 1 度だけ。`unknown` のときに限り `npm root -g` を 1 本起こすので、
  // 標準的な配置では常にサブプロセス 0 本で済む（無駄にプロセスを立てない方針）。
  let installed: Promise<InstallKind> | undefined;
  const install = (): Promise<InstallKind> => {
    installed ??=
      opts.packageRoot === undefined
        ? Promise.resolve(opts.install)
        : resolveInstallKind(opts.packageRoot, opts.install, { exec: opts.exec });
    return installed;
  };
  const check = async (): Promise<UpdateCheck> => {
    const latest = await fetchLatestVersion(opts.pkg, {
      signal: opts.signal,
      fetchImpl: opts.fetchImpl,
    });
    // 更新が無い/確認できないなら経路を調べる必要すら無い（npm を起こさない）。
    if (latest === undefined || !isUpdateAvailable(opts.current, latest)) {
      return resolveUpdateCheck({
        pkg: opts.pkg,
        current: opts.current,
        latest,
        install: opts.install,
      });
    }
    return resolveUpdateCheck({
      pkg: opts.pkg,
      current: opts.current,
      latest,
      install: await install(),
    });
  };
  return {
    initial: check(),
    check,
    install: (info) => runUpdate(info, { exec: opts.exec }),
  };
}
