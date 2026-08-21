import type { IgnoredFilesMode } from './worktree';

/**
 * セッションへ渡す systemPrompt の組み立て（純関数）。
 *
 * 構成要素は2つ:
 * 1. codiva が作った worktree の**環境説明**（ignore 済みファイルの引き継ぎ方が
 *    `'symlink'` = 共有だという事実と、書き込む前の切り離し手順）
 * 2. リポジトリ単位の追加指示（`<repo>/.codiva/prompt.md`。`core/repo-prompt.ts`）
 *
 * どちらも無ければ `undefined` を返し、呼び出し側は `systemPrompt` を渡さない
 * （SDK は省略時に空文字へ写像するので現挙動と等価。`core/session.ts` の注入コメント参照）。
 */

/**
 * `ignoredFiles: 'symlink'`（既定）のときにセッションへ伝える注意書き。
 *
 * symlink モードでは `node_modules/` や `.env` などの ignore 済みパスが元リポジトリの
 * 実体を指す**共有物**なので、セッションが依存を更新したりキャッシュを消したりすると
 * メインチェックアウトや並行セッションに波及する（ビルド生成物は
 * `DEFAULT_IGNORED_EXCLUDES` で引き継ぎ対象から外してあるが、プロジェクト固有の
 * 生成物はリンクとして残り得るので注意書き自体は必要）。エージェントはこの事実を知らないと
 * 「自分の worktree の中だから安全」と判断してしまうため、環境として明示する。
 *
 * 方針:
 * - **プロジェクト非依存**にする（`node_modules` / `dist` を前提にした指示にしない）。
 *   何が ignore されているかは言語・ツールチェインで違うので「symlink かどうか」で判定させる。
 * - **必要になったときだけ**切り離させる（全部コピーさせたら symlink モードの利点が消える）。
 * - 消し方を具体的に書く。`rm -rf <path>/` や `<path>/*` はリンクを辿って**共有先の中身を
 *   消す**ため、ここだけは手順を曖昧にできない。
 * - **`git add -A` を禁じる**。`.gitignore` の `node_modules/` のような末尾スラッシュの
 *   パターンは**ディレクトリにしかマッチせず symlink にはマッチしない**ため、リンクは
 *   untracked として現れる（実測: `git add -A` が mode 120000 でステージし、そのまま
 *   コミットすると絶対パス入りのリンクが main にマージされる）。
 * - コピーは `readlink` で辿った先から `cp -Rp <target>/. <path>`（BSD / GNU 両対応を実機確認）。
 *   一時ファイル名を経由しない形にしてある: `mv <path> <path>.bak` 方式は、前回の失敗で
 *   `<path>.bak`（ディレクトリを指すリンク）が残っていると **mv がその中＝共有先へ移動**
 *   してしまう。`-L` は付けない —— ツリー内の symlink まで実体化するとワークスペースの
 *   リンク構造が壊れ、循環リンクがあると途中で失敗して半端なコピーが残る（実測）。
 *
 * AI 向けのプロンプトなので言語は英語（`utils/title.ts` の TITLE_INSTRUCTION と同じ扱いで、
 * UI 文字列ではないため i18n カタログの対象外）。
 */
export const SHARED_IGNORED_FILES_NOTICE = `# Shared ignored files in this worktree (codiva)

You are running in a git worktree created by codiva. Only git-tracked files were
checked out here. Every path that git ignores and that already existed in the
main repository when this worktree was created — at any depth, whatever this
project happens to use: dependency directories, caches, local env files — was
symlinked to that same path in the main repository working tree instead of being
copied. Those targets are shared with the main checkout and with the other
codiva sessions running in parallel right now. (Well-known build-output and cache
directories are deliberately not inherited: they start out absent here, so a build
you run writes them fresh and private to this worktree. Ignored paths created
later, here, are real files too; step 1 below tells the two apart in every case.)

Reading through these symlinks is safe and intended. Writing through one is not:
it changes the shared original, so it can break the main checkout and other
sessions. Writes that do this include installing, upgrading or removing
dependencies, running a build / bundler / codegen, editing or reformatting
generated output, and clearing a cache.

So before the first write into such a path, give this worktree its own private
copy of that one path:

1. Check whether it really is a symlink: \`test -L <path> && readlink <path>\`.
   If it is not, the path is already private to this worktree — nothing to do.
2. Detach it. Regenerating from scratch is often the best option (re-run the
   dependency installer, do a clean build). Otherwise copy what the link points
   at, as one command so the target path is not lost midway:

       target="$(readlink <path>)" && rm <path> && cp -Rp "$target/." <path>

   - \`rm <path>\` without \`-r\` and without a trailing slash removes the link
     only. NEVER \`rm -rf <path>/\` or \`rm -rf <path>/*\`: those resolve through
     the link and delete the shared original.
   - \`"$target/."\` copies the directory's contents; if the link points at a
     single file, use \`cp -p "$target" <path>\` instead.
   - Do not add \`-L\`. Dereferencing nested symlinks breaks layouts that rely on
     them (package manager stores, workspace links) and fails outright on cyclic
     ones. If the copy reports errors, delete the partial result and regenerate
     instead — none of this ever modifies the shared original.
3. Verify \`test -L <path>\` is now false, then do the write.

Also watch out when committing: a .gitignore pattern that ends in \`/\` matches a
directory, not a symlink, so these links can show up as untracked in
\`git status\`. Do NOT \`git add -A\` / \`git add .\` in this worktree — stage the
paths you actually changed, and never commit one of these links (they hold
absolute paths from this machine).

Detach only the paths your task actually writes to and leave the rest linked —
that is what makes these sessions start instantly. If your task writes into no
ignored path at all, ignore all of this and just work. Stay inside this worktree:
never write into the main repository's working tree, where those shared targets
live.`;

/**
 * worktree の環境説明とリポジトリ追加指示から systemPrompt を組み立てる。
 *
 * 順序は「環境説明 → リポジトリ追加指示」。前者は前提条件の説明、後者は著者が書いた
 * 常設の指示で、より具体的なものを後ろに置く。
 *
 * `ignoredFiles` は合成レイヤが `resolveIgnoredFilesMode(config)` の結果を渡す。
 * 未指定（テストや直接構築）は注意書きを載せない —— 実体が共有されているかどうかを
 * 知らないまま「共有されている」と告げる方が危険なため。
 *
 * **エージェント切替の引き継ぎ（`core/agent-handoff.ts`）はここには載らない。**
 * あれは `AgentRunOptions.handoff` として渡り、各アダプタが切替後の最初のユーザー
 * プロンプトに前置する — resume したスレッドに systemPrompt を渡し直さない provider
 * （`codex exec resume`）にも確実に届ける必要があるため。
 */
export function composeSystemPrompt(parts: {
  ignoredFiles?: IgnoredFilesMode;
  repoPrompt?: string;
}): string | undefined {
  const sections = [
    parts.ignoredFiles === 'symlink' ? SHARED_IGNORED_FILES_NOTICE : undefined,
    parts.repoPrompt,
  ].filter((section): section is string => section !== undefined && section.length > 0);
  return sections.length > 0 ? sections.join('\n\n') : undefined;
}
