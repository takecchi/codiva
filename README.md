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
- **プラン / 使用状況のステータスバー** — 画面下部に claude.ai のプラン種別（Pro / Max / Team / Enterprise）と使用リミット枠を表示。`プラン名 · 5時間 ████░░░░ 50% 残り45分` のようにゲージとリセットまでの残り時間が出る（詳細はバナーの「使用状況」欄）。
- **学習データ利用の警告** — claude.ai の「Help improve our AI models」（モデル学習へのデータ提供）が ON のときだけ、起動時のヘッダに注意行を出す。
- **アップデート通知** — 起動時に npm の最新版を確認し、新しいバージョンがあればヘッダに 1 行表示。`/update` コマンドで確認の上その場で更新できる。
- **キーボード完結** — マウス不要。入力欄とヘッダはドラッグで範囲選択してコピーもできます（ヘッダの cwd 行から作業パスをコピーする用途）。
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

### アップデート

起動時に npm レジストリを 1 回だけ確認し、新しいバージョンがあればバナーに `↑ 新しいバージョン v0.3.0 が利用できます · /update で更新` と表示します（最新のときや確認できなかったときは何も表示しません）。

`/update` を実行すると最新版を確認し直し、更新があれば実行するコマンドを提示して `y` / `n` を尋ねます。`y` で codiva がそのまま `npm install` を実行し、完了後に再起動を促します。

- グローバルインストール（`npm install -g codiva`）→ `npm install -g codiva@latest` を実行します（実行前に稼働中セッションがあれば警告します）
- `npx codiva` → インストールが無いので何もしません（次回の `npx` で最新が使われます）
- それ以外（プロジェクトのローカル依存 / volta などのツールマネージャ配下 / Windows / 判別できない配置）→ **codiva からは実行せず**、実行すべきコマンドの提示だけを行います

codiva 側から実行しない範囲を広く取っているのは意図的です。ローカル依存の更新は利用者のリポジトリの `package.json` と lockfile を書き換え、`node_modules`（既定で各 worktree にシンボリックリンクされています）を作り直してしまいます。また判別できない配置に `npm install -g` すると、実際に入っている場所とは別の場所へインストールして環境を壊しかねません。誤検出のコストを「自動化されないだけ」に抑えています。

確認の通信は `https://registry.npmjs.org/codiva/latest` への 1 リクエスト（約 2.3KB・3 秒でタイムアウト）だけで、送るのはパッケージ名のみです。バージョンや利用状況は送信しません。オフラインでも起動は一切ブロックされません。`~/.codiva/config.json` の `"updateCheck": false` でこの通信を完全に止められます。

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

### テキストのコピー

入力欄とヘッダ（ワードマーク / サブタイトル / モデル / プラン / cwd / 使用状況）は、**ドラッグで範囲選択して離すとクリップボードへコピー**されます（OSC 52 なので SSH 越しでも動きます）。ヘッダの cwd 行をドラッグすれば、いま作業しているパスをそのまま貼り付けられます。ヘッダのドラッグは入力中のフォーカスや一覧の選択行を動かしません。

- 選択のハイライトは反転表示され、何かキーを押すと解除されます。
- 端末ネイティブの選択（画面のどこでも選べる代わりにアプリ側の機能が使えない）は **Shift+ドラッグ**、または設定 `"mouse": false` でマウス捕捉を無効化して使えます。

### プラン / 使用状況の表示

画面下部のステータスバー（一覧・詳細の両方）に、ログイン中の claude.ai プランと使用リミット枠が出ます。

```
⏵⏵ 自動モード (shift+tab で切替) · …          Claude Team · 5時間 ████░░░░ 50% 残り45分
```

- 更新は2系統: 稼働中セッションはターン開始ごとに Claude から届く最新値、待機中は **5分ごとの自動取得**
  （どちらも Claude への問い合わせだけで推論は走らないため、トークン消費・課金はありません）。
  リセットまでの残り時間は毎秒カウントダウンします。
- 使用率（`%`）は Claude が返さないプランもあります。その場合はゲージを出さず残り時間だけを表示します
  （0% と誤読させないため）。
- API キー / Bedrock / Vertex 利用時はサブスク制限が無いため、この表示は出ません。
- 一覧画面のバナーには全枠（5時間枠・週次枠・追加利用枠）の詳細と、プラン名・組織名が出ます。

## 設定

`~/.codiva/config.json`（任意）:

```json
{
  "language": "auto",
  "ignoredFiles": "symlink",
  "updateCheck": true
}
```

- `language`: `"ja"` / `"en"` / `"auto"`（OS ロケール準拠）。環境変数 `CODIVA_LANG`（`ja` / `en`）が最優先です。
- `updateCheck`: 起動時に npm の最新バージョンを確認するか。既定 `true`。`false` にすると起動時の通信をやめ、`/update` も「確認できませんでした」になります。
- `ignoredFiles`: セッション用 worktree を作るとき、`.gitignore` された未追跡ファイル（`node_modules/` や `.env` など）をどう引き継ぐか。git worktree は追跡対象しか引き継がないため、これがないと依存の再インストールや環境変数の再設定が必要になります。既定 `"symlink"`。
  - `"symlink"`（既定）: リポジトリルートへシンボリックリンクを張るだけ。複製コストがゼロで即起動できます。実体を共有するため、ビルド生成物の書き込みなどが元やほかの worktree に波及しうる点に注意。
  - `"copy"`: リポジトリルートから実体を複製します。worktree が完全に独立し作業が絶対に重複しませんが、`node_modules/` が巨大だとコピーが重くなります。
  - `"none"`: 何も引き継ぎません（依存や環境変数はセッション側で用意し直す）。
  - 非推奨の `copyIgnored`（真偽値）も後方互換で解釈します（`true`→`copy` 相当、`false`→`none` 相当）。`ignoredFiles` があればそちらが優先されます。
- `notifications`: 質問・許可要求・完了などのタイミングでデスクトップ通知を出すか。既定 `true`（`false` で無効化）。
- `privacyWarning`: 学習データ利用が ON のときヘッダに注意行を出すか。既定 `true`。`false` にすると判定自体を行いません（下記）。

### デスクトップ通知

セッションが「質問あり」「許可要求」「完了」「失敗」などの状態に変わったタイミングで通知します（同じ状態が続いている間は鳴りません）。

通知は可能なかぎり**ターミナル自身に出させます**（Ghostty / WezTerm / foot / iTerm2 / kitty の通知エスケープシーケンスを利用）。そのため通知をクリックすると codiva を動かしているターミナルが前面に来ます。tmux 内でも動きますが、`set -g allow-passthrough on` が必要です。SSH 越しの場合、`TERM` から判別できる Ghostty / kitty / foot と、`LC_TERMINAL` を転送する iTerm2 では手元のターミナルに通知が出ます。

上記に該当しないターミナル（macOS 標準の Terminal.app、Windows Terminal など）では OS のコマンド（macOS は `osascript`、Linux は `notify-send`）にフォールバックします。**macOS のこのフォールバック経路では通知が「スクリプトエディタ」名義になり、クリックするとスクリプトエディタが開きます**（`osascript` から出した通知の仕様上の制約です）。ターミナル側の通知設定（Ghostty の `desktop-notifications` など）を無効にしている場合も通知は出ません。

### 学習データ利用（モデル学習へのデータ提供）の警告

claude.ai の設定「**Help improve our AI models**」が ON のアカウントでは、Claude Code / codiva 経由の会話も Anthropic のモデル改善に使われることがあります。codiva は並列セッションで大量のコードを流すため、**ON と判定できたときだけ**起動時ヘッダに注意行を出します。

```
⚠ 学習データ利用が ON です（会話がモデル改善に使われる場合があります）
  変更: https://claude.ai/settings/data-privacy-controls
```

- 設定を変えるのは上記 URL（または Claude Code の `/privacy-settings`）です。**codiva はアカウント設定を書き換えません**（読み取りのみ）。
- 判定は「`~/.claude.json` のキャッシュ → Claude Code と同じ API へ問い合わせ」の順で、起動を待たせません。判定できないとき（未ログイン・`ANTHROPIC_API_KEY` などの API 利用・オフライン・仕様変更）は**何も表示しません**。
- 設定を OFF に変えたあとは、次の起動で警告が消えます（キャッシュが ON でも API で確認し直すため）。
- 問い合わせには Claude Code の OAuth トークン（macOS は Keychain の `Claude Code-credentials`、それ以外は `~/.claude/.credentials.json`）を読み取り専用で使います。これが嫌な場合は `"privacyWarning": false` にすると、Keychain もネットワークも一切触りません。

### リポジトリ追加指示（`.codiva/prompt.md`）

対象リポジトリの `.codiva/prompt.md` に書いた内容は、そのリポジトリで起動する全セッションの systemPrompt に自動注入されます。「作業が終わったらテストを実行し PR を出す」など、リポジトリ固有のワークフローをチームで共有できます（`CLAUDE.md` とは独立に併用可能。ファイルが無ければ無指示で従来どおり）。

ファイルを直接編集するほか、一覧画面のコンポーザで **`/prompt`** と入力すると TUI 内エディタが開きます（現在の内容をシード。`Enter` で保存、`Shift+Enter` で改行、`Esc` で取消、空で保存すると削除）。保存内容は**以降の新規セッション**に反映されます（稼働中のセッションは起動時の指示を維持）。

利用できるスラッシュコマンドは、コンポーザで `/` を入力するとパレット表示されます（`/prompt`・`/model`・`/clear`・`/update`・`/help` など）。`/clear` は完了・中断・失敗など**終了済みのセッションを一覧から消去**します（実行中のセッションは残ります）。worktree やコミット履歴はディスク上に残るため作業自体は失われませんが、消去したセッションは codiva を再起動しても一覧に戻りません。

スラッシュを打ち忘れても、**その画面で使えるコマンド名と完全に一致する入力**（`exit` / `help` など）はそのコマンドとして実行されます。実行されるときはコマンドパレットに出るので、`Enter` の前に何が起きるか分かります。`exit の挙動を直して` のように後ろに文字が続く場合、また `?`・`changes` のような別名は通常の指示として扱うので、指示が誤ってコマンドになることはありません。

**`/exit`** は画面によって意味が変わります。一覧画面では codiva を終了し、セッション詳細画面では**詳細を閉じて一覧へ戻ります**（`Esc` と同じ）。詳細を見ている途中に `/exit` を打ってアプリごと落ちてしまうことがないようにしています。

## 開発

```bash
npm run dev        # tsx で TUI 起動（開発）
npm test           # vitest（coverage 付き）
npm run lint       # biome check
npm run typecheck  # tsc --noEmit
npm run build      # tsup で dist/index.js に単一ファイルバンドル
```

設計ドキュメントは [`docs/`](./docs) を参照してください（[PRD](./docs/PRD.md) / [ARCHITECTURE](./docs/ARCHITECTURE.md) / [TECH_NOTES](./docs/TECH_NOTES.md)）。

コーディング規約は [`.claude/rules/`](./.claude/rules)（レイヤ構成・命名・i18n・Ink・セッションドメイン・SDK 連携・git/IO・テスト）、
スラッシュコマンド追加などの定型作業の手順は [`.claude/skills/`](./.claude/skills) にまとめてあります。
全体の索引と「やりたいこと → 触るファイル」の地図は [`CLAUDE.md`](./CLAUDE.md) にあります。

## リリース

npm への配信は **npm Trusted Publishing（OIDC）** を利用し、GitHub Actions からトークンレスで行います。GitHub 上で Release を publish するだけで、バージョン同期・npm 配信・main へのバージョン更新コミットが自動実行されます。初回の手順・GitHub / npm の設定は [`docs/RELEASE.md`](./docs/RELEASE.md) を参照してください。

## ライセンス

[MIT](./LICENSE)
