# エージェント連携規約（Claude Agent SDK）

コーディングエージェントとの境界と、`@anthropic-ai/claude-agent-sdk` を触るときの不変条件。
**`core/agent-ports.ts` / `core/agent-events.ts` / `core/claude-adapter.ts` / `core/claude-parse.ts` /
`core/claude-errors.ts` / `core/codex-adapter.ts` / `core/codex-parse.ts` / `core/codex-errors.ts` /
`core/session.ts` / `utils/model-catalog.ts` / `utils/codex.ts` / `utils/title.ts` を触る前に読む。**
実測データと詳細は [docs/TECH_NOTES.md](../../docs/TECH_NOTES.md)、設計の理由は
[docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md)「エージェント抽象」。

## 大原則: 想定で書かない

- SDK メッセージの形は**必ず実データで確認する**。`npm run spike -- <scenario>` で採取し、
  サニタイズして `src/core/__fixtures__/*.jsonl` に昇格させ、そのフィクスチャでテストする
  （手順は skill `sdk-spike`）。推測でパースを書いてはいけない。
- SDK の型（`SDKMessage` / `SDKResultSuccess` / `SDKPartialAssistantMessage` / `ModelInfo` …）は
  `import type` で引く。`any` は使わず、変換は `toXxx()` / ガード `isXxx()` に閉じ込める。

## 境界は `AgentAdapter`（`QueryFn` ではない）

- エージェントの DI 境界は `core/agent-ports.ts` の `AgentAdapter` / `AgentRun` と、
  `core/session-ports.ts` の `SessionHandle`。**SDK の `query()` の署名を共通 IF にしない** —
  `AsyncIterable<SDKUserMessage>` + `Options` + `canUseTool` + control request は Claude 固有の
  制御モデルで、それを IF にすると全 provider にその模倣を強いることになる。
- アダプタの責務は 3 つだけ: (1) ストリームを開く（`open`）、(2) provider のメッセージを
  `AgentEvent[]` へ写す、(3) 失敗文言を `AgentStopCause` へ分類する（`classifyError`）。
  それ以外（ログの上限・進捗・完了ゲート・PR 検出・コスト集計）は共通側の仕事。
- 許可要求の型も自前（`PermissionDecision`）。SDK の `PermissionResult` を core へ持ち込まず、
  provider 形への写像はアダプタが行う（Claude は `claude-adapter.ts` の `canUseTool`）。
- その provider に無い機能は `AgentCapabilities` で表明する（`permissions` / `interrupt` /
  `setModel` / `resume` / `modelCatalog` / `usage` / `cost` / `transcript`）。UI は capability を
  見て縮退する（今つながっているのは `/model` と `Ctrl+C`。残りは Phase D）。
  `AgentRun.interrupt` / `setModel` は
  optional。新しいアダプタは `NO_CAPABILITIES` から始めて、実装できたものだけ true にする。

## 他 provider のアダプタ（Claude 以外を足すとき）

- **3 点セットは provider ごとに対で書く**。Claude が `claude-adapter.ts` / `claude-parse.ts` /
  `claude-errors.ts` なら、Codex は `codex-adapter.ts` / `codex-parse.ts` / `codex-errors.ts`
  （+ JSONL の型と受理ガードだけを持つ `codex-events.ts`、実 I/O の `utils/codex.ts`）。
  **その CLI / SDK の形の知識をこの外へ漏らさない。**
- **CLI は同梱せず、ユーザーがインストールしたものを起動する**（`git` / `gh` と同じ扱い）。
  provider の SDK パッケージを依存に足すと、その provider を使わないユーザーにまで
  プラットフォーム別バイナリを配ることになる。認証もその CLI のログインに委ねる
  （codiva は資格情報を書かない）。
- **「1 ターン = 1 プロセス」もアダプタの形として認める**。`codex exec` は 1 ターンで終了し、
  続きは `codex exec resume <thread_id> <prompt>` として起動し直す。`AgentAdapter.open` が
  プロンプトキューを回してターンごとにプロセスを起こし、resume id を引き回すことで、
  外からは Claude の長寿命ストリームと同じ 1 本に見せられる（`AgentRun` の契約は
  「`AgentEvent` を流す非同期イテレータ」だけなので、プロセスの寿命は自由）。
  終端イベントが来ないままプロセスが終わる経路（中断・CLI 未導入）を必ず終了コードで補うこと。
- **許可要求を上げられない provider は `permissions: false` を宣言する。ダイアログを偽装しない。**
  `codex exec` の JSON モードは承認要求を CLI 内部で自動 reject してストリームに何も出さないので、
  codiva が UI へ上げる経路が原理的に無い。ここで「それらしい許可ダイアログ」を出すと、
  ユーザーが許可したのに実際は拒否されているという嘘になる。**capability を false にして
  黙って出さない**方を選び、安全弁は provider 側の仕組み（Codex ならサンドボックス設定
  `codexSandbox`）に寄せる。同じ理由で、質問（`QuestionSpec`）を表現できない provider も
  `permissions: false` のままにする。
- **「エラー行」と「ターンの終わり」を混同しない**。Codex は再試行の実況
  （`Reconnecting... 1/5 (...)`）を `{"type":"error"}` として流し、諦めたときだけ `turn.failed`
  を出す。エラー型を素直に失敗へ写すと**自力で回復するセッションが赤くなる**ので、
  終端の判定に使ってよいイベントを実データで確かめてから書く（連発する実況は
  `AgentEvent.notice` の `coalesceKey` で 1 行に畳む）。
- **フィクスチャは実バイナリから採る**。上流に採取済みのものが無ければ、モデル側だけを
  差し替えて（Codex なら `-c model_provider=...` でローカルのモック Responses API へ向ける）
  実 CLI を走らせ、出力をサニタイズして `src/core/__fixtures__/` へ昇格させる
  （手順は [docs/TECH_NOTES.md](../../docs/TECH_NOTES.md)「Codex CLI」節）。
- **TUI 内ログインは「端末を明け渡さない」形で書く**。login を提供する provider は
  `AgentAdapter.login()`（`AgentLoginProcess` を返す）を実装する。全画面 TUI の中で
  `<cli> login` を裏で起動し、**出力の認証 URL / デバイスコードを拾ってダイアログに出す**
  （純粋な畳み込みは `core/agent-login.ts`、起動は `utils/agent-login.ts` の `spawnLogin`）。
  ブラウザで進む OAuth を選ぶ（Codex は stdin もローカルサーバも要らない
  `login --device-auth`）。**login CLI は URL を色付き（ANSI）で出す**ので、拾う前に必ず
  エスケープを剥がす（実測で取りこぼした）。TUI 内ログインを表現できない provider は
  `login()` を省略する（UI はログインの導線を出さない）。

## 形の知識は 2 段に割る（アダプタの parse → 共通の fold）

```
provider のメッセージ ──[アダプタの parse]──▶ AgentEvent[] ──[applyAgentEvent]──▶ SessionState
```

- 生の `SDKMessage` を解釈するのは `core/claude-parse.ts`（`parseClaudeMessage` /
  `summarizeToolUse` / `toolResultSummary`）のみ。ここは**状態を変えない** —
  `SDKMessage` を `AgentEvent[]` に写すだけ。
- 状態の畳み込みは `core/agent-events.ts` の `applyAgentEvent` が**全 provider 共通**で持つ。
  ここに provider 固有の分岐（`message.subtype` / SDK のツール名 / CLI の文言）を足さない。
  ツールは `AgentToolKind`（`edit` / `shell` / `todo` / `question` / `other`）へ、TODO 操作は
  `TodoOp` へ、失敗は `AgentStopCause` へ、というように**アダプタ側で正規化してから**渡す。
- `applyClaudeMessage`（parse → fold の合成）は既存の実データテストの入口を保つための薄い糖衣。
  新しい呼び出し側はこれを増やさず `AgentEvent` 経由にする。
- `status-reducer.ts` は**型付き `CodivaEvent` しか受けない**（生参照を持ち込まない）。
- UI・`SessionManager` は SDK メッセージを直接読まない。

## 中立モジュールは SDK を import しない

- `@anthropic-ai/claude-agent-sdk` を import してよいのは **`core/claude-adapter.ts` /
  `core/claude-parse.ts` / `core/claude-errors.ts`**（と `utils/` の Claude 実装）だけ。
  他の `core/` モジュールから型・定数を引かない。同じ規律を他 provider にも適用する
  （`codex` CLI の引数・JSONL の形を知ってよいのは `core/codex-*.ts` と `utils/codex.ts` だけ。
  `core/` はサブプロセスを起こさないので、`spawn` は必ず `utils/` 側に置く）。
- そのため、SDK の union と値が同じでも自前で持つものがある: `core/config.ts` の
  `EffortLevel` / `PermissionMode`（配列が唯一の出所で、型も実行時検証もそこから導出）。
  **型で気付けないので、SDK 更新時に目視で追従させる**。
- CLI の文言・typed error kind・HTTP ステータスの知識は `core/claude-errors.ts` に集める
  （`isAuthError` / `isAuthErrorKind` / `isConnectionError` / `isTransientApiErrorKind` /
  `isTransientApiStatus` / `isRateLimitError` / `classifyClaudeError`）。状態機械はこの知識を
  持たず、分類結果の `AgentStopCause` だけを受け取る（`CodivaEvent` の `aborted.cause`）。
  別のエージェントを足すときは、このファイルの対になるものをそのアダプタ用に書く。
- `USAGE_LIMIT_ERROR_PREFIXES` のように「CLI 側で変わるので SDK に追従したい」定数は、
  **アダプタの中でだけ** SDK から読む。

## query() の使い方（`core/claude-adapter.ts` の中だけ）

- **streaming input mode 固定**（`prompt` に `AsyncQueue` の `AsyncIterable<SDKUserMessage>` を渡す）。
  単発 string prompt は使わない（エラーで throw して終わり、追加指示・interrupt・
  `setPermissionMode` が使えない）。`Session` が持つのは `AsyncIterable<string>` で、
  `SDKUserMessage` への包み直しはアダプタの `toSdkPrompt`。
- 既定の options: `cwd`=セッションの worktree、`permissionMode`（設定優先、既定 `acceptEdits`）、
  `canUseTool`、`abortController`、`settingSources: ['project']`（対象リポジトリの CLAUDE.md を読ませる）、
  `includePartialMessages: true`（ストリーミングプレビュー用）。**この既定を組み立てるのはアダプタ**で、
  `Session` は provider 非依存の `AgentRunOptions`（model / effort / permissionMode / maxBudgetUsd /
  systemPrompt）しか渡さない。各項目をどう解釈するか（無視も可）はアダプタの裁量。
- `systemPrompt` は**純粋な `core/system-prompt.ts` の `composeSystemPrompt()` で組み立てる**
  （`session.ts` に文言や結合順を書かない）。要素は「worktree の環境説明（`ignoredFiles: 'symlink'`
  のときだけ載る共有 symlink の注意書き）」→「`<repo>/.codiva/prompt.md` の内容」の順で、
  どちらも無ければ付与しない。**SDK は `systemPrompt` 省略時に空文字へ写像する**ので単純代入で
  現挙動を壊さないが、将来ベースの systemPrompt を導入するなら array / preset-append 形へ
  変える必要がある（`claude-adapter.ts` のコメント参照）。
- **AI 向けのプロンプト文字列は i18n カタログに置かない**（UI 文字列ではない）。英語で書く
  （`core/system-prompt.ts` / `utils/title.ts` の `TITLE_INSTRUCTION` が前例）。
- `resume` は**モデル側コンテキストだけ**を復元し、過去メッセージをストリームに再送出しない。
  UI のログは transcript から再構築する（[session-domain.md](./session-domain.md)）。
  渡してよいのは**その provider が発行した id だけ**（`SessionState.agentSessions[agent]`）。
  別 provider の id を渡すと存在しない会話を resume しようとして壊れる。

## モデル一覧は SDK が唯一の出所（Claude の capability）

- モデルカタログは Claude 固有の機能なので `AgentCapabilities.modelCatalog` / `setModel` で
  optional 化してある。持たない provider では `/model` を出さない。
- `/model` の選択肢は `Query.supportedModels()` から取る（`utils/model-catalog.ts` の
  `fetchModelCatalog`。I/O・throw しない・10 秒でタイムアウト）。**モデル ID・表示名・説明文を
  アプリ側に直書きしない**（アカウント種別・サブスク・CLI バージョンで実際に選べるモデルが変わる）。
- 突き合わせは純粋な `core/models.ts`（`toModelOptions` / `isCurrentModel`）。
  `value: 'default'` は「未設定」専用の番兵で、**`resolvedModel` で突き合わせてはいけない**
  （明示的に選んだモデルが「デフォルト」行にチェックされる）。
- 取得失敗時は `FALLBACK_MODEL_OPTIONS`（**バージョンを含まないファミリーエイリアスのみ**）。
- モデル名・説明文は SDK 由来の英語をそのまま出す（i18n の例外。[i18n.md](./i18n.md)）。

## canUseTool の契約（アダプタ ⇄ `requestPermission`）

- SDK の `canUseTool` を実装するのはアダプタで、`Session` へは中立の
  `requestPermission(req) => Promise<PermissionDecision>` として上げる。`Session` は
  「何が質問か」を知らず、codiva 自身のポリシー（`core/run-mode.ts`）だけを見る。
- Promise を解決するまでセッションはブロックされる。UI の応答待ちで pending のままにしてよい。
- **`AskUserQuestion` は allow ルールに関係なく必ず届く**。これが「質問あり」の実装点で、
  アダプタが `kind: 'question'` + `QuestionSpec[]` へ写して上げる。SDK へ返すときは
  `{ behavior: 'allow', updatedInput: { ...input, answers } }` の形
  （`answers` = `{ [questionText]: 選択ラベル }`。multiSelect はカンマ区切り）。
  **`answers` を入れずに allow すると質問が無視される**（`"The user did not answer the questions."`）ので、
  UI の回答は `PermissionDecision.input` に載せて丸ごと差し替える。
- ルーチンツール（Write/Edit/Bash 等）は `auto` モードで自動 allow、`confirm` モードで UI に上げる。
  判定は `core/run-mode.ts` の `createModePolicy`。`acceptEdits` でも `Write` が
  `canUseTool` に落ちてくる（実測）ので「編集系は自動許可」を前提にしない。

## result の解釈

- streaming input mode では `result` は**ターンの区切りごと**に届く。セッション終了ではない
  （`turn_completed` / `turn_stopped` であって「セッション終了」イベントではない）。
- **完了（`turn_completed`）とみなすのは `subtype === 'success' && !is_error` のときだけ**。
  それ以外は `classifyClaudeError` の文言分類（認証 → レート制限 → 通信断 → `failed`）へ流して
  `turn_stopped` にする。`subtype === 'success'` だけを見ると認証切れが「緑の Completed」になり
  auto-PR まで走る（実際に起きた不具合）。
- エラー系 subtype は `result` を持たず `errors: string[]` に理由を積むので**両方読む**。
- 同じ失敗が assistant と result の2回届く。2 回目（ターン終了の要約）は
  `turn_stopped.rollup: true` を立てて出し、既に resumable な状態なら畳み込み側が
  コストだけ拾って分類し直さない（やり直すと認証切れが素の `failed` に格下げされる）。
  遷移関数（`toNeedsLogin` 等）も冪等に保つ（同一 detail なら同一参照を返す）。

## サブエージェント（Task ツール）の完了ゲート

- Task がバックグラウンド実行されると、サブエージェント稼働中に**トップレベルの `result/success`
  が先に届く**。素直に completed にすると「作業中なのに完了」になる。
- 対策: `system/task_started` / `system/task_notification` を `task_started` / `task_settled` へ
  写して `activeTaskIds` を追跡し、タスクが残っていれば結果を `deferredResult` に保留して
  `running` を維持、全タスク settle 後に completed を確定する。`skip_transcript` の雑務タスクは
  ゲート対象外。**ゲート自体は `applyAgentEvent` 側（全 provider 共通）**にあるので、他の
  provider は「タスクが始まった/片付いた」を報告するだけでよい。
- `activeTaskIds` / `deferredResult` / `streamingText` は transient で**永続しない**。

## レート制限情報

- `rate_limit_event` の `rejected` はセッションを `rate_limited` にする（`turn_stopped` の
  `cause: 'rate_limit'`）一方、`allowed` / `allowed_warning` も含めて**アカウント全体**の
  使用状況を運ぶ（`usage` イベント）。後者はセッション状態ではないので `applyAgentEvent` は
  無視し、`Session.onRateLimit`（DI）で `SessionManager` へ横に流してウィンドウ種別ごとに
  最新値を保持する（正規化は純粋な `core/rate-limit.ts`）。使用状況ゲージは
  `AgentCapabilities.usage` を持つ provider だけの機能。

## サブプロセスのコスト意識

- `query()` 1本 = `claude` サブプロセス1本（最大 ~1GiB）。起動時に全復元セッションを起こさない、
  タイトル生成は `haiku` + `maxTurns: 1` + タイムアウト付き（`utils/title.ts`）、
  カタログ取得は yield しない generator（推論を走らせない）——といった「無駄にプロセスを立てない」
  設計を崩さない。
