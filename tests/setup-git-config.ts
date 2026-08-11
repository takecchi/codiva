import { devNull } from 'node:os';

/**
 * 実 git を叩くテスト（`utils/git.spec.ts` / `utils/worktree-manager.spec.ts`）を
 * **開発者のグローバル / システム設定から切り離す**（vitest の `setupFiles`）。
 *
 * `mkdtemp` + `git init` で作った一時リポジトリは素の状態に見えるが、`~/.gitconfig` は
 * そこにも効く。実際に `commit.gpgSign = true` の環境で署名エージェントが使えないと、
 * コミットを作るテストが `failed to write commit object` でまとめて落ちた（issue #110）。
 * 同じ経路で `core.hooksPath`（テスト中に他人のフックが走る）・`core.excludesFile`
 * （ignore 引き継ぎの列挙結果が変わる）・`init.templateDir` も漏れてくるので、
 * 設定ファイルごと無効化して「テスト結果が実行環境に依存しない」状態にする。
 *
 * 空の設定ファイル（`/dev/null`）を指すだけでよい。identity（`user.name` /
 * `user.email`）はグローバルに無くなるので、各テストがリポジトリ単位で設定する。
 */
process.env.GIT_CONFIG_GLOBAL = devNull;
process.env.GIT_CONFIG_SYSTEM = devNull;
