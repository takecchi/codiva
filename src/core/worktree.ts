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
 * `git ls-files --others --ignored --exclude-standard --directory` の生出力から、
 * 新しい worktree へコピーすべき ignore 済みエントリだけを取り出す純関数。
 *
 * `--directory` によりディレクトリ全体が ignore されている場合は末尾 `/` 付きの
 * 1エントリに畳まれる（`node_modules/` を数万ファイル列挙せずに済む）。codiva 自身の
 * 作業ディレクトリ（`.codiva/`）と `.git` は、worktree 群を再帰コピーしたり内部状態を
 * 壊したりするため必ず除外する。
 */
export function ignoredCopyEntries(raw: string): string[] {
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((entry) => {
      const normalized = entry.replace(/\/$/, '');
      return normalized !== CODIVA_DIR && normalized !== '.git';
    });
}
