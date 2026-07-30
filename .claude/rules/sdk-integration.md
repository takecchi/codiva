# Claude Agent SDK 連携規約

`@anthropic-ai/claude-agent-sdk` を触るときの不変条件。**`core/session.ts` / `core/sdk-parse.ts` /
`utils/model-catalog.ts` / `utils/title.ts` を触る前に読む。** 実測データと詳細は
[docs/TECH_NOTES.md](../../docs/TECH_NOTES.md)。

## 大原則: 想定で書かない

- SDK メッセージの形は**必ず実データで確認する**。`npm run spike -- <scenario>` で採取し、
  サニタイズして `src/core/__fixtures__/*.jsonl` に昇格させ、そのフィクスチャでテストする
  （手順は skill `sdk-spike`）。推測でパースを書いてはいけない。
- SDK の型（`SDKMessage` / `SDKResultSuccess` / `SDKPartialAssistantMessage` / `ModelInfo` …）は
  `import type` で引く。`any` は使わず、変換は `toXxx()` / ガード `isXxx()` に閉じ込める。

## SDK 形状の知識は sdk-parse.ts にだけ置く

- 生の `SDKMessage` を解釈するのは `core/sdk-parse.ts`（`applySdkMessage` / `summarizeToolUse` /
  `toolResultSummary`）のみ。`status-reducer.ts` は**型付き `CodivaEvent` しか受けない**
  （`message.subtype` 等の生参照をここへ持ち込まない）。
- UI・`SessionManager` は SDK メッセージを直接読まない。

## query() の使い方

- **streaming input mode 固定**（`prompt` に `AsyncQueue` の `AsyncIterable<SDKUserMessage>` を渡す）。
  単発 string prompt は使わない（エラーで throw して終わり、追加指示・interrupt・
  `setPermissionMode` が使えない）。
- 既定の options: `cwd`=セッションの worktree、`permissionMode`（設定優先、既定 `acceptEdits`）、
  `canUseTool`、`abortController`、`settingSources: ['project']`（対象リポジトリの CLAUDE.md を読ませる）、
  `includePartialMessages: true`（ストリーミングプレビュー用）。
- `systemPrompt` は `<repo>/.codiva/prompt.md` の内容がある場合のみ付与する。**SDK は
  `systemPrompt` 省略時に空文字へ写像する**ので単純代入で現挙動を壊さないが、将来ベースの
  systemPrompt を導入するなら array / preset-append 形へ変える必要がある（`session.ts` のコメント参照）。
- `resume` は**モデル側コンテキストだけ**を復元し、過去メッセージをストリームに再送出しない。
  UI のログは transcript から再構築する（[session-domain.md](./session-domain.md)）。

## モデル一覧は SDK が唯一の出所

- `/model` の選択肢は `Query.supportedModels()` から取る（`utils/model-catalog.ts` の
  `fetchModelCatalog`。I/O・throw しない・10 秒でタイムアウト）。**モデル ID・表示名・説明文を
  アプリ側に直書きしない**（アカウント種別・サブスク・CLI バージョンで実際に選べるモデルが変わる）。
- 突き合わせは純粋な `core/models.ts`（`toModelOptions` / `isCurrentModel`）。
  `value: 'default'` は「未設定」専用の番兵で、**`resolvedModel` で突き合わせてはいけない**
  （明示的に選んだモデルが「デフォルト」行にチェックされる）。
- 取得失敗時は `FALLBACK_MODEL_OPTIONS`（**バージョンを含まないファミリーエイリアスのみ**）。
- モデル名・説明文は SDK 由来の英語をそのまま出す（i18n の例外。[i18n.md](./i18n.md)）。

## canUseTool の契約

- Promise を解決するまでセッションはブロックされる。UI の応答待ちで pending のままにしてよい。
- **`AskUserQuestion` は allow ルールに関係なく必ず届く**。これが「質問あり」の実装点。
  回答は `{ behavior: 'allow', updatedInput: { ...input, answers } }` の形で返す
  （`answers` = `{ [questionText]: 選択ラベル }`。multiSelect はカンマ区切り）。
  **`answers` を入れずに allow すると質問が無視される**（`"The user did not answer the questions."`）。
- ルーチンツール（Write/Edit/Bash 等）は `auto` モードで自動 allow、`confirm` モードで UI に上げる。
  判定は `core/run-mode.ts` の `createModePolicy`。`acceptEdits` でも `Write` が
  `canUseTool` に落ちてくる（実測）ので「編集系は自動許可」を前提にしない。

## result の解釈

- streaming input mode では `result` は**ターンの区切りごと**に届く。セッション終了ではない。
- **完了とみなすのは `subtype === 'success' && !is_error` のときだけ**。それ以外は文言分類
  （認証 → レート制限 → 通信断 → `failed`）へ流す。`subtype === 'success'` だけを見ると
  認証切れが「緑の Completed」になり auto-PR まで走る（実際に起きた不具合）。
- エラー系 subtype は `result` を持たず `errors: string[]` に理由を積むので**両方読む**。
- 同じ失敗が assistant と result の2回届くため、遷移関数（`toNeedsLogin` 等）は冪等に保つ
  （同一 detail なら同一参照を返す）。

## サブエージェント（Task ツール）の完了ゲート

- Task がバックグラウンド実行されると、サブエージェント稼働中に**トップレベルの `result/success`
  が先に届く**。素直に completed にすると「作業中なのに完了」になる。
- 対策: `system/task_started` / `system/task_notification` で `activeTaskIds` を追跡し、
  タスクが残っていれば結果を `deferredResult` に保留して `running` を維持、全タスク settle 後に
  completed を確定する。`skip_transcript` の雑務タスクはゲート対象外。
- `activeTaskIds` / `deferredResult` / `streamingText` は transient で**永続しない**。

## レート制限情報

- `rate_limit_event` の `rejected` はセッションを `rate_limited` にする一方、`allowed` /
  `allowed_warning` も含めて**アカウント全体**の使用状況を運ぶ。これはセッション状態ではないので
  `Session.onRateLimit`（DI）で `SessionManager` へ渡し、ウィンドウ種別ごとに最新値を保持する
  （正規化は純粋な `core/rate-limit.ts`）。

## サブプロセスのコスト意識

- `query()` 1本 = `claude` サブプロセス1本（最大 ~1GiB）。起動時に全復元セッションを起こさない、
  タイトル生成は `haiku` + `maxTurns: 1` + タイムアウト付き（`utils/title.ts`）、
  カタログ取得は yield しない generator（推論を走らせない）——といった「無駄にプロセスを立てない」
  設計を崩さない。
