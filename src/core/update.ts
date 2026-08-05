/**
 * アップデート判定（純粋・I/O 非依存）。
 *
 * npm レジストリから取得した最新バージョンと、実行中の自バージョンを比較して
 * 「更新があるか」を決める。レジストリ問い合わせ・インストール経路の判定・
 * `npm install` の実行はすべて `utils/update.ts` にあり、ここは比較と
 * コマンドの組み立て・DI 境界の定義だけを担う（規約: architecture.md）。
 *
 * 比較は semver の precedence 規則に従う（release 部を数値比較 → 同値なら
 * prerelease 付きが小さい → prerelease は識別子ごとに比較）。プレリリースを
 * 扱うのは、`latest` タグより新しい prerelease を手元に入れている利用者に
 * 「古いバージョンへの更新」を勧めてしまわないため。
 */

/** インストール経路。更新コマンドの形が変わるため区別する。 */
export type InstallKind = 'global' | 'npx' | 'local' | 'unknown';

/** 更新があるときの詳細。`latest` は npm の `latest` タグのバージョン。 */
export interface UpdateInfo {
  /** npm のパッケージ名（更新コマンドの引数。package.json の `name` が出所）。 */
  pkg: string;
  /** 実行中のバージョン（package.json 由来）。 */
  current: string;
  /** レジストリの最新バージョン。 */
  latest: string;
  /** 検出したインストール経路（更新コマンドの決定に使う）。 */
  install: InstallKind;
}

/**
 * 更新チェックの結果。「最新だった」と「確認できなかった」を必ず区別する
 * （オフラインを「最新です」と表示すると嘘になる）。
 */
export type UpdateCheck =
  | { kind: 'available'; info: UpdateInfo }
  | { kind: 'up-to-date'; current: string }
  | { kind: 'unavailable' };

/**
 * 自バージョン・レジストリの最新・インストール経路から結果を決める（純粋）。
 * どちらかのバージョンが無い/壊れている場合は `unavailable`。
 */
export function resolveUpdateCheck(input: {
  pkg: string;
  current: string | undefined;
  latest: string | undefined;
  install: InstallKind;
}): UpdateCheck {
  const { pkg, current, latest, install } = input;
  if (current === undefined || latest === undefined) {
    return { kind: 'unavailable' };
  }
  if (parseVersion(current) === undefined || parseVersion(latest) === undefined) {
    return { kind: 'unavailable' };
  }
  return isUpdateAvailable(current, latest)
    ? { kind: 'available', info: { pkg, current, latest, install } }
    : { kind: 'up-to-date', current };
}

/** 更新コマンドの実行結果。失敗理由は表示するので文字列で持つ。 */
export type UpdateRun = { ok: true } | { ok: false; detail: string };

/**
 * アップデート機能の DI 境界。ネットワークとサブプロセスは `utils/update.ts` にあり、
 * UI はこの interface だけを知る（規約: architecture.md の一方向依存）。
 * 合成ルート（`main.tsx`）が実装を注入し、テストはフェイクを渡す。
 */
export interface UpdateService {
  /**
   * 起動時に投げた初回チェックの Promise。await せずに渡され、UI が state へ解決する
   * （起動をブロックしない。`modelCatalog` と同じ扱い）。
   */
  initial?: Promise<UpdateCheck>;
  /** 手動チェック（`/update` を打つたびに最新を問い合わせ直す）。 */
  check: () => Promise<UpdateCheck>;
  /** 更新コマンドを実行する。throw しない（失敗は `ok: false`）。 */
  install: (info: UpdateInfo) => Promise<UpdateRun>;
}

/** `/update` ダイアログの表示状態。UI はこの union で分岐するだけにする。 */
export type UpdateViewState =
  | { kind: 'checking' }
  | { kind: 'result'; check: UpdateCheck }
  | { kind: 'installing'; info: UpdateInfo }
  | { kind: 'installed'; info: UpdateInfo }
  | { kind: 'failed'; detail: string };

/** semver を precedence 比較できる形へ分解したもの。 */
interface ParsedVersion {
  /** major/minor/patch…（数値のみ）。 */
  release: readonly number[];
  /** prerelease 識別子（数値なら number、そうでなければ string）。 */
  prerelease: readonly (string | number)[];
}

/**
 * バージョン文字列を分解する。先頭の `v` と build metadata（`+...`）は無視する。
 * release 部が数値以外を含む（`latest` / 空文字など）場合は undefined。
 */
export function parseVersion(value: string): ParsedVersion | undefined {
  const trimmed = value.trim().replace(/^v/i, '');
  // build metadata は precedence に影響しない（semver 10）ので捨てる。
  const core = trimmed.split('+', 1)[0] ?? '';
  const dash = core.indexOf('-');
  const releasePart = dash === -1 ? core : core.slice(0, dash);
  const prereleasePart = dash === -1 ? '' : core.slice(dash + 1);
  const releaseIds = releasePart.split('.');
  if (releaseIds.length === 0 || !releaseIds.every((id) => /^\d+$/.test(id))) {
    return undefined;
  }
  const prerelease = prereleasePart === '' ? [] : prereleasePart.split('.');
  return {
    release: releaseIds.map((id) => Number(id)),
    prerelease: prerelease.map((id) => (/^\d+$/.test(id) ? Number(id) : id)),
  };
}

function compareNumbers(a: number, b: number): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** release 部（数値列）の比較。長さが違う場合は足りない桁を 0 として扱う。 */
function compareRelease(a: readonly number[], b: readonly number[]): number {
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    const diff = compareNumbers(a[i] ?? 0, b[i] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }
  return 0;
}

/**
 * prerelease 識別子列の比較（semver 11-4）。数値は数値として比較し、数値は
 * 常に文字列より小さい。全て等しければ識別子の少ない方が小さい。
 */
function comparePrerelease(
  a: readonly (string | number)[],
  b: readonly (string | number)[],
): number {
  // prerelease なし（= 正式リリース）は prerelease 付きより大きい。
  if (a.length === 0 && b.length === 0) {
    return 0;
  }
  if (a.length === 0) {
    return 1;
  }
  if (b.length === 0) {
    return -1;
  }
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    const left = a[i];
    const right = b[i];
    if (left === undefined || right === undefined) {
      break;
    }
    if (typeof left === 'number' && typeof right === 'number') {
      const diff = compareNumbers(left, right);
      if (diff !== 0) {
        return diff;
      }
      continue;
    }
    if (typeof left === 'number') {
      return -1;
    }
    if (typeof right === 'number') {
      return 1;
    }
    if (left !== right) {
      return left < right ? -1 : 1;
    }
  }
  return compareNumbers(a.length, b.length);
}

/**
 * semver の precedence 比較。`a > b` なら正、`a < b` なら負、同値なら 0。
 * どちらかが解釈できない文字列のときは 0（= 差が無い扱い）を返し、
 * 壊れた値で更新を促さないようにする。
 */
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) {
    return 0;
  }
  const release = compareRelease(left.release, right.release);
  return release !== 0 ? release : comparePrerelease(left.prerelease, right.prerelease);
}

/**
 * 更新があるか。`latest` が `current` より新しいときだけ true。
 * バージョンが取れない・解釈できない場合は false（黙って何も出さない）。
 */
export function isUpdateAvailable(
  current: string | undefined,
  latest: string | undefined,
): boolean {
  if (current === undefined || latest === undefined) {
    return false;
  }
  return compareVersions(latest, current) > 0;
}

/**
 * インストール経路ごとの更新コマンド（`file` + `args`）。シェル文字列ではなく
 * argv で持つのは、そのまま `execFile` に渡せる形にしておくため（規約: git-and-io.md）。
 *
 * - `global`: `npm install -g <pkg>@latest`（通常のインストール経路）
 * - `local` : `npm install <pkg>@latest`（プロジェクトの devDependency として入っている）
 * - `npx`   : 常に最新が取られるので更新コマンドは無い（undefined）
 * - `unknown`: 判定できないときは global 相当を提示するが、実行はしない
 */
export function updateCommandFor(
  install: InstallKind,
  pkg: string,
): { file: string; args: readonly string[] } | undefined {
  switch (install) {
    case 'global':
    case 'unknown':
      return { file: 'npm', args: ['install', '-g', `${pkg}@latest`] };
    case 'local':
      return { file: 'npm', args: ['install', `${pkg}@latest`] };
    case 'npx':
      return undefined;
  }
}

/** 更新コマンドを人に見せる 1 行の文字列にする（`npm install -g codiva@latest`）。 */
export function updateCommandLine(install: InstallKind, pkg: string): string | undefined {
  const command = updateCommandFor(install, pkg);
  return command ? [command.file, ...command.args].join(' ') : undefined;
}

/**
 * codiva 自身が更新コマンドを実行してよいか。**グローバルインストールだけ** true。
 *
 * - `npx`: 更新対象が無い（毎回最新を取る）。
 * - `unknown`: 宛先が確定していない。誤った prefix へ入れると環境を壊す。
 * - `local`: 実行はしない。`npm install <pkg>@latest` は**利用者のリポジトリの
 *   `package.json` / lockfile を書き換え**、`node_modules` を作り直す。codiva は
 *   対象リポジトリを汚さないのが前提（`.gitignore` にも触らない）で、しかも
 *   `node_modules` は既定で各 worktree へシンボリックリンクされているため、
 *   稼働中セッションの依存ツリーを足元から入れ替えてしまう。コマンドの提示に留める。
 */
export function canSelfUpdate(install: InstallKind): boolean {
  return install === 'global';
}
