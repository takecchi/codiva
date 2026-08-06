/** codiva の作業ディレクトリ名（リポジトリルート直下）。worktree 群と state.json を置く。 */
export const CODIVA_DIR = '.codiva';

/**
 * `git worktree add` が引き継ぐのは追跡対象ファイルだけなので、`.gitignore` された
 * `node_modules/` や `.env` などは新しい worktree に現れない。これらをリポジトリ
 * ルートから引き継ぐ方法を選ぶ:
 *
 * - `'symlink'`（既定）: 元へのシンボリックリンクを張るだけ。複製コストゼロで即起動できるが、
 *   worktree 間で実体を共有する（ビルド生成物などの書き込みが元やほかの worktree に波及しうる）。
 * - `'copy'`: リポジトリルートから実体を複製する。worktree 完全独立で作業が絶対に重複しないが、
 *   `node_modules/` が巨大だとコピーが重い。
 * - `'none'`: 何も引き継がない（依存や環境変数はセッション側で用意し直す）。
 */
export type IgnoredFilesMode = 'symlink' | 'copy' | 'none';

export interface WorktreeOptions {
  /** `.gitignore` された未追跡ファイルを新しい worktree へどう引き継ぐか。未設定は 'symlink'。 */
  ignoredFiles?: IgnoredFilesMode;
  /**
   * 引き継ぎから除外する追加パターン（`DEFAULT_IGNORED_EXCLUDES` の後ろに足される）。
   * `!` 前置で既定の除外を打ち消せる（例: `['!dist']` で `dist/` を再び引き継ぐ）。
   */
  ignoredFilesExclude?: readonly string[];
}

export interface Worktree {
  slug: string;
  branch: string;
  path: string;
}

/**
 * Thrown by `merge()` when the merge into base hit conflicts. The merge is
 * aborted before this throws (base tree is left clean), and `files` lists the
 * paths that conflicted so the UI can surface them (`status: 'conflict'`).
 */
export class MergeConflictError extends Error {
  constructor(
    readonly branch: string,
    readonly base: string,
    readonly files: string[],
  ) {
    super(`merge of ${branch} into ${base} hit conflicts; resolve manually in the worktree`);
    this.name = 'MergeConflictError';
  }
}

/**
 * `syncBase()` の結果 — セッションの worktree へベースブランチを取り込もうとして
 * 何が起きたか。**投げずに返す**のは、4 つのどれもが正常な分岐だから（呼び出し側は
 * 競合と「取り込むものが無かった」を区別してから次の手を決める）。
 *
 *  - `upToDate` … 既にベースを含んでいた（何もしていない）
 *  - `updated`  … マージコミットができた（`ref` は取り込んだ ref。`origin/main` 等）
 *  - `dirty`    … 未コミットの変更があるので**マージを試みていない**（`files` はそのパス）
 *  - `conflict` … 競合した。**worktree には競合を残したまま**にする（`git merge --abort`
 *    しない）ので、そのままエージェントに解決させられる。ベースへのマージ（`merge()`）が
 *    abort するのとは意図的に逆: あちらは共有されるベースツリーを汚さないのが目的で、
 *    こちらはセッション専用の worktree なので競合を残すほうが直せる。
 */
export type SyncBaseResult =
  | { kind: 'upToDate' }
  | { kind: 'updated'; ref: string }
  | { kind: 'dirty'; files: string[] }
  | { kind: 'conflict'; ref: string; files: string[] };

export interface DiffStat {
  /** `git diff --stat` summary against the base branch (committed changes). */
  committed: string;
  /** Paths with uncommitted changes in the worktree (porcelain). */
  uncommitted: string[];
}

/**
 * ignore 済みでも**引き継がない**既定パターン: ビルド生成物・開発サーバやコンパイラの
 * キャッシュ。依存（`node_modules/`）や環境ファイル（`.env`）と違い、これらは
 *
 * 1. **共有すると壊れる**: 元リポジトリと複数 worktree の開発サーバ／ビルドが同じ実体へ
 *    同時に書き込む。さらに worktree はリポジトリ配下（`.codiva/worktrees/<slug>`）にあるため、
 *    ルートで再帰的にファイル監視する開発サーバ（Next.js / Turbopack 等）からは、自分が
 *    書き込んでいる同じディレクトリが worktree の数だけ別経路として見える。変更通知が
 *    多重に跳ね返って CPU・FD を食い潰し、OS ごと固まる（issue #81 の実測）。
 * 2. **引き継ぐ必要がない**: 生成物なので、必要になればセッション側で作り直せる。
 *
 * よってモードに関係なく（`'symlink'` でも `'copy'` でも）引き継がない。パターンは
 * `/` を含まなければ**エントリの最終セグメント**に一致判定するので、`apps/web/.next/` の
 * ようなネストした生成物にも効く。`*` 前置は接尾一致（`*.tsbuildinfo`）。
 *
 * 特定プロジェクトのディレクトリ名を並べるのは本来避けたいが、「生成物かどうか」は
 * ディレクトリを見ても判別できない（`.gitignore` は依存も生成物も同じく無視する）ため、
 * 実害の大きい既知の名前を列挙するしかない。設定 `ignoredFilesExclude` で足せる／
 * `!` 前置で打ち消せる形にして、外れたときの逃げ道を用意してある。
 */
export const DEFAULT_IGNORED_EXCLUDES: readonly string[] = [
  // フレームワークのビルド出力・開発サーバのキャッシュ
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.astro',
  '.output',
  '.docusaurus',
  '.expo',
  '.vercel',
  '.netlify',
  '.wrangler',
  // バンドラ・タスクランナ・コンパイラのキャッシュ
  '.turbo',
  '.parcel-cache',
  '.vite',
  '.rollup.cache',
  '.angular',
  '.swc',
  '.cache',
  '.eslintcache',
  '*.tsbuildinfo',
  // 汎用の出力先・レポート
  'dist',
  'build',
  'out',
  'storybook-static',
  'coverage',
  '.nyc_output',
  // 他言語のビルド出力・キャッシュ
  'target',
  '.gradle',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
];

/** パターン1件がエントリに一致するか。`/` 無しは最終セグメント、`*` 前置は接尾一致。 */
function matchesExcludePattern(pattern: string, entry: string): boolean {
  const path = entry.replace(/\/+$/, '');
  const target = pattern.includes('/') ? path : path.slice(path.lastIndexOf('/') + 1);
  if (pattern.startsWith('*')) {
    const suffix = pattern.slice(1);
    return suffix.length > 0 && target.length > suffix.length && target.endsWith(suffix);
  }
  return target === pattern;
}

/**
 * エントリを引き継ぎから除外するか。パターンは順に評価し**最後に一致したものが勝つ**
 * （`.gitignore` と同じ）ので、既定の後ろに `!dist` を足せば `dist/` を引き継げる。
 */
export function isExcludedIgnoredEntry(entry: string, patterns: readonly string[]): boolean {
  let excluded = false;
  for (const raw of patterns) {
    const negated = raw.startsWith('!');
    const pattern = (negated ? raw.slice(1) : raw).replace(/^\.\//, '').replace(/\/+$/, '');
    if (pattern.length === 0) {
      continue;
    }
    if (matchesExcludePattern(pattern, entry)) {
      excluded = !negated;
    }
  }
  return excluded;
}

/** 既定の除外パターンにユーザー設定を足した最終リスト（後ろが優先）。 */
export function ignoredExcludePatterns(extra?: readonly string[]): readonly string[] {
  return extra && extra.length > 0
    ? [...DEFAULT_IGNORED_EXCLUDES, ...extra]
    : DEFAULT_IGNORED_EXCLUDES;
}

/**
 * codiva 自身の作業ディレクトリ（`.codiva/`）と git の内部（`.git`）配下か。
 *
 * **先頭セグメントで判定する**（`entry === '.codiva'` の完全一致では足りない）。
 * `.codiva/.gitignore` を置いてからは `git ls-files --others --ignored --directory` が
 * ディレクトリを 1 件に畳まず、`.codiva/` に加えて `.codiva/.gitignore` /
 * `.codiva/worktrees/` まで個別に列挙する（除外の出所がそのディレクトリの中にあるため
 * git が中へ降りる）。完全一致だけだと `.codiva/worktrees/` が引き継ぎ対象に化け、
 * 新しい worktree の中へ worktree 群自身へのリンクが張られる（実測: 以後の
 * `git worktree remove` が ELOOP「Too many levels of symbolic links」で失敗した）。
 */
function isInternalEntry(entry: string): boolean {
  const head = entry.replace(/\/+$/, '').split('/')[0];
  return head === CODIVA_DIR || head === '.git';
}

/**
 * `ignoredCopyEntries()` の裏返し: 生出力のうち**除外されたエントリ**を返す純関数
 * （`.codiva/` と `.git` はそもそも引き継がないのでここにも含めない）。
 *
 * 用途は既存 worktree の後片付け: 以前のバージョンが張ったビルド生成物へのリンクは、
 * 設定を変えただけでは消えない（= フリーズが続く）。この一覧を使って「もう引き継がない
 * パスのリンクだけ」を外す（`WorktreeManager.pruneExcludedLinks`）。
 */
export function excludedIgnoredEntries(
  raw: string,
  excludes: readonly string[] = DEFAULT_IGNORED_EXCLUDES,
): string[] {
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((entry) => !isInternalEntry(entry) && isExcludedIgnoredEntry(entry, excludes));
}

/**
 * `git ls-files --others --ignored --exclude-standard --directory` の生出力から、
 * 新しい worktree へコピーすべき ignore 済みエントリだけを取り出す純関数。
 *
 * `--directory` によりディレクトリ全体が ignore されている場合は末尾 `/` 付きの
 * 1エントリに畳まれる（`node_modules/` を数万ファイル列挙せずに済む）。codiva 自身の
 * 作業ディレクトリ（`.codiva/`）と `.git` は、worktree 群を再帰コピーしたり内部状態を
 * 壊したりするため必ず除外する。ビルド生成物・キャッシュも既定で除外する
 * （理由は `DEFAULT_IGNORED_EXCLUDES`）。
 */
export function ignoredCopyEntries(
  raw: string,
  excludes: readonly string[] = DEFAULT_IGNORED_EXCLUDES,
): string[] {
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((entry) => !isInternalEntry(entry) && !isExcludedIgnoredEntry(entry, excludes));
}
