# codiva

> 対象の Git リポジトリで起動し、指示ごとに独立した git worktree 上で Claude Code セッションを並列実行する TUI アプリ。

[![npm version](https://img.shields.io/npm/v/codiva.svg)](https://www.npmjs.com/package/codiva)
[![CI](https://github.com/takecchi/codiva/actions/workflows/ci.yml/badge.svg)](https://github.com/takecchi/codiva/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

`codiva` は、自然文で指示を投げるたびに独立した git worktree + ブランチ上で Claude Code セッション（[Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) 経由）をバックグラウンド起動し、複数タスクを並列に進行させるターミナル UI です。「指示を次々投げるだけで、並列に実装が進む」体験を目指しています。

## 特徴

- **並列セッション** — 指示ごとに worktree（`.codiva/worktrees/<slug>`）とブランチ（`codiva/<slug>`）を自動生成。互いのファイル変更が干渉しない。
- **リアルタイム進捗** — 一覧画面で全セッションの状態（`実行中` / `Step 4/7` / `質問あり` / `許可待ち` / `完了` / `失敗`）と経過時間を表示。
- **ノンブロッキング投入** — 指示を投げても即座に次の指示を入力できる。
- **許可応答・追加指示** — 詳細ビューでツール使用の許可 / 拒否、稼働中セッションへの追加指示ができる。
- **マージ or 破棄** — 完了セッションの diff stat を確認し、ベースブランチへマージ、または worktree ごと破棄。
- **リポジトリ追加指示** — `.codiva/prompt.md` に書いた指示（例:「作業完了時に PR を出す」）を全セッションに自動注入。一覧画面の `/prompt` コマンドから TUI 内で編集できる。
- **キーボード完結** — マウス不要。
- **日本語 / 英語 UI** — `~/.codiva/config.json` または `CODIVA_LANG` で切替。

## 動作要件

- Node.js **>= 20**
- `claude` CLI にログイン済み、または `ANTHROPIC_API_KEY` が設定済み
- 対象が Git リポジトリで、コミットが 1 つ以上あること

## インストール

```bash
npm install -g codiva
```

一度きり試すだけなら:

```bash
npx codiva
```

## 使い方

対象リポジトリのルートで起動します。

```bash
cd path/to/your-repo
codiva
```

1. 入力欄に指示（例:「ログイン機能を実装してください」）を入力して Enter。新しいセッションが作成され、すぐ次の指示を入力できます。
2. 一覧で各セッションの進捗をリアルタイムに確認します。
3. セッションを選ぶと詳細ビューに入り、ログ閲覧・追加指示・許可応答ができます。
4. 完了したら diff stat を確認し、マージまたは破棄します。

> worktree ディレクトリ `.codiva/` は対象リポジトリの `.git/info/exclude` に自動追記されるため、対象リポジトリの `.gitignore` を汚しません。

## 設定

`~/.codiva/config.json`（任意）:

```json
{
  "language": "auto",
  "ignoredFiles": "symlink"
}
```

- `language`: `"ja"` / `"en"` / `"auto"`（OS ロケール準拠）。環境変数 `CODIVA_LANG`（`ja` / `en`）が最優先です。
- `ignoredFiles`: セッション用 worktree を作るとき、`.gitignore` された未追跡ファイル（`node_modules/` や `.env` など）をどう引き継ぐか。git worktree は追跡対象しか引き継がないため、これがないと依存の再インストールや環境変数の再設定が必要になります。既定 `"symlink"`。
  - `"symlink"`（既定）: リポジトリルートへシンボリックリンクを張るだけ。複製コストがゼロで即起動できます。実体を共有するため、ビルド生成物の書き込みなどが元やほかの worktree に波及しうる点に注意。
  - `"copy"`: リポジトリルートから実体を複製します。worktree が完全に独立し作業が絶対に重複しませんが、`node_modules/` が巨大だとコピーが重くなります。
  - `"none"`: 何も引き継ぎません（依存や環境変数はセッション側で用意し直す）。
  - 非推奨の `copyIgnored`（真偽値）も後方互換で解釈します（`true`→`copy` 相当、`false`→`none` 相当）。`ignoredFiles` があればそちらが優先されます。

### リポジトリ追加指示（`.codiva/prompt.md`）

対象リポジトリの `.codiva/prompt.md` に書いた内容は、そのリポジトリで起動する全セッションの systemPrompt に自動注入されます。「作業が終わったらテストを実行し PR を出す」など、リポジトリ固有のワークフローをチームで共有できます（`CLAUDE.md` とは独立に併用可能。ファイルが無ければ無指示で従来どおり）。

ファイルを直接編集するほか、一覧画面のコンポーザで **`/prompt`** と入力すると TUI 内エディタが開きます（現在の内容をシード。`Enter` で保存、`Shift+Enter` で改行、`Esc` で取消、空で保存すると削除）。保存内容は**以降の新規セッション**に反映されます（稼働中のセッションは起動時の指示を維持）。

利用できるスラッシュコマンドは、コンポーザで `/` を入力するとパレット表示されます（`/prompt`・`/model`・`/clear`・`/help` など）。`/clear` は完了・中断・失敗など**終了済みのセッションを一覧から消去**します（実行中のセッションは残ります）。worktree やコミット履歴はディスク上に残るため作業自体は失われませんが、消去したセッションは codiva を再起動しても一覧に戻りません。

## 開発

```bash
npm run dev        # tsx で TUI 起動（開発）
npm test           # vitest（coverage 付き）
npm run lint       # biome check
npm run typecheck  # tsc --noEmit
npm run build      # tsup で dist/index.js に単一ファイルバンドル
```

設計ドキュメントは [`docs/`](./docs) を参照してください（[PRD](./docs/PRD.md) / [ARCHITECTURE](./docs/ARCHITECTURE.md) / [TECH_NOTES](./docs/TECH_NOTES.md)）。

## リリース

npm への配信は **npm Trusted Publishing（OIDC）** を利用し、GitHub Actions からトークンレスで行います。GitHub 上で Release を publish するだけで、バージョン同期・npm 配信・main へのバージョン更新コミットが自動実行されます。初回の手順・GitHub / npm の設定は [`docs/RELEASE.md`](./docs/RELEASE.md) を参照してください。

## ライセンス

[MIT](./LICENSE)
