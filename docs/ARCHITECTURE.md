# アーキテクチャ設計: codiva

## レイヤ構成

UI とコアロジックを完全に分離する。コアは Ink/React に一切依存せず、単体でテスト可能にする。

```
┌─ ui/ (Ink + React) ────────────────────────────────┐
│  App / SessionList / PromptInput                    │
│  PermissionDialog / ProgressBadge                   │
│        ▲ useSyncExternalStore で購読                 │
└────────┼────────────────────────────────────────────┘
┌────────┴─ core/ (純TypeScript, UIなし) ─────────────┐
│  SessionManager … セッションの生成・保持・イベント発火   │
│  Session        … 1セッション = 1 エージェント + 状態  │
│  reduce()       … CodivaEvent → SessionState 畳み込み│
│  applyAgentEvent() … AgentEvent → SessionState       │
│  AgentAdapter   … provider の DI 境界（claude/…）     │
│  Worktree 型 / MergeConflictError / 純関数            │
└────────┬────────────────────────────────────────────┘
┌────────┴─ utils/ (I/O ラッパ, core にのみ依存) ──────┐
│  WorktreeManager… git worktree の作成・削除・マージ   │
│  git() / config / state-store / pr / notify …        │
└────────┬────────────────────────────────────────────┘
┌────────┴─ 外部 ─────────────────────────────────────┐
│  @anthropic-ai/claude-agent-sdk (query)             │
│  git CLI (worktree / diff / merge)                  │
└─────────────────────────────────────────────────────┘
```

依存方向は一方向（`ui → core ← utils`）。`WorktreeManager` は fs + git 実行の I/O 具象なので
utils レイヤに置く（`core` は node の I/O を import しない）。`core/worktree.ts` には純粋な型
（`Worktree` / `DiffStat`）・`MergeConflictError`・`ignoredCopyEntries()` だけを残し、
`SessionManager` は `WorktreeService` インターフェース越しに具象を DI で受ける。

`src/index.tsx` / `src/main.tsx` / `src/app.tsx` / `src/bootstrap/` は**合成レイヤ**（どのレイヤにも属さず
core と utils を束ねる）。副作用の配線（manager 組み立て・復元・永続・端末モード・PR ポーリング）は
`bootstrap/` に切り出し、`main.tsx` は「解決 → preflight → build → restore → render → shutdown」の
直列だけに保つ。

`src/index.tsx` は**起動シムだけ**（`NODE_ENV` を立ててから `./main` を動的 import する 3 文）。
static import を 1 本でも足すと巻き上げられて意味が消えるので、`tests/entry-shim.test.ts` が固定している。
理由は下記「React の dev ビルドとヒープ枯渇」。

## ディレクトリ構造

```
codiva/
├── src/
│   ├── index.tsx              # bin エントリ。解決 → preflight → build → restore → render → shutdown（合成ルート・薄い）
│   ├── app.tsx                # ルートコンポーネント。list ⇔ detail のビュー切替
│   ├── bootstrap/             # 副作用の配線（合成の分解。core/utils にのみ依存）
│   │   ├── build-manager.ts   # config + I/O seam → SessionManager 組み立て + /model の config 永続・/prompt の prompt.md 永続
│   │   ├── restore-sessions.ts # state.json + transcript から復元
│   │   ├── persist-controller.ts # debounce保存 / SIGTERM同期flush / 最終flush を集約
│   │   ├── crash-handler.ts   # uncaughtException/unhandledRejection → 端末復元 + クラッシュログ
│   │   └── runtime.ts         # PRポーリング・alt-screen/mouse・SIGTERM/SIGHUP フラッシュ
│   ├── core/                  # 純粋ドメイン（Ink/React/node/utils 非依存。SDK に触るのは claude-*.ts だけ）
│   │   ├── index.ts           # バレル（export *）
│   │   ├── types.ts           # SessionState, SessionStatus, CodivaEvent, AgentId, AgentStopCause 等の型定義
│   │   ├── status-reducer.ts  # reduce(state, CodivaEvent): SessionState（codiva 起点のイベント・純関数）
│   │   ├── agent-ports.ts     # エージェントの DI 境界（AgentAdapter/AgentRun/AgentCapabilities/PermissionDecision・leaf）
│   │   ├── agent-events.ts    # AgentEvent の語彙 + applyAgentEvent()（全 provider 共通の畳み込み・純粋）
│   │   ├── claude-adapter.ts  # Claude 用 AgentAdapter（query() の組み立て・canUseTool の写像）
│   │   ├── claude-parse.ts    # parseClaudeMessage()（SDK メッセージ形状の解釈を集約・純粋）
│   │   ├── claude-errors.ts   # Claude CLI の失敗分類（文言/typed kind/HTTP status → AgentStopCause）
│   │   ├── status-meta.ts     # STATUS_META（terminal/attention/active/resumable/復元先/通知キーの一元表）
│   │   ├── session.ts         # 1 エージェントストリームのライフサイクル（setAgent で途中切替）
│   │   ├── session-store.ts   # 購読可能スナップショット（順序・状態・参照同一性保持）
│   │   ├── session-manager.ts # create/restore/dispose + passthrough のファサード
│   │   ├── session-actions.ts # merge/discard/diffStat（git 操作の純粋オーケストレーション）
│   │   ├── pr-coordinator.ts  # PrCoordinator（autoPr/refreshPrs/自動立て直し）
│   │   ├── pr-recovery.ts    # 詰まった PR の立て直し判定・指示文（純粋）
│   │   ├── pr-detect.ts       # セッション自身が作った PR の検知・表示ヘルパ（純粋）
│   │   ├── run-mode.ts        # RunMode + createModePolicy
│   │   ├── session-ports.ts   # codiva 側の DI seam（WorktreeService/SessionHandle/…・leaf）
│   │   ├── worktree.ts        # Worktree 型 + MergeConflictError + ignoredCopyEntries（純粋）
│   │   ├── list-hit.ts        # 一覧のマウス当たり判定（純粋）
│   │   ├── format.ts / math.ts / ansi.ts / errors.ts   # 小さな純粋ヘルパ（formatDuration/clamp/…）
│   │   ├── privacy.ts        # 学習データ利用（grove）の判定（JSON→TrainingOptIn・純粋）
│   │   ├── async-queue.ts / slug.ts / config.ts / cost.ts / notify.ts / persistence.ts / update.ts
│   │   ├── choice-lines.ts    # 選択肢（ラベル + 説明）の折返し（純粋・表示幅ベース）
│   │   ├── scroll.ts / text-buffer.ts / composer-layout.ts / layout.ts / mouse.ts / key-sequence.ts / model.ts / models.ts / transcript.ts
│   │   ├── *.spec.ts          # 単体テストは実装の隣に co-located
│   │   └── __fixtures__/      # サニタイズ済み実 SDK メッセージ（claude-parse テスト用）
│   ├── ui/                    # Ink コンポーネント（kebab-case, 識別子は PascalCase）
│   │   ├── index.ts           # バレル
│   │   ├── theme.ts           # アクセント色・状態色・logColor・グリフ（色は必ずここ経由）
│   │   ├── banner.tsx         # 起動時ヘッダ（マスコット + プラン/モデル + cwd + 使用状況ゲージ, 枠なし）
│   │   ├── session-list.tsx   # 一覧画面（composer/list の2フォーカスゾーン）
│   │   ├── session-detail.tsx # 詳細画面（ログ + 追加指示 + マージ/破棄。SDK セッションに直結）
│   │   ├── composer.tsx       # 入力欄の共通実装（useComposer = キー/マウス/バッファ, <Composer> = 描画）
│   │   ├── prompt-input.tsx   # 上下横罫線 + ❯ キャレットの入力欄（presentational）
│   │   ├── repo-prompt-editor.tsx # /prompt のリポジトリ追加指示エディタ（モーダル・composer を置換）
│   │   ├── dialog-box.tsx / confirm-prompt.tsx / choice-row.tsx  # 共有 presentational（角丸枠・y/n 確認行・選択肢1件）
│   │   ├── update-dialog.tsx  # /update の表示（presentational・useInput を持たない）
│   │   ├── status-footer.tsx / permission-dialog.tsx / model-select.tsx / command-palette.tsx / progress-badge.tsx
│   │   ├── hooks.ts           # useSessions / useClock / useTextBufferRef / useCommandRunner / useLifecycleAction
│   │   └── input.ts           # キー→テキストバッファ操作の対応（editText/resolveEnter/normalizeChord）
│   └── utils/                 # すべての I/O（core にのみ依存＝一方向）
│       ├── index.ts           # バレル
│       ├── git.ts             # execFile ベースの git 実行ヘルパ
│       ├── worktree-manager.ts # WorktreeManager（git worktree の I/O）
│       ├── exec.ts / terminal-mode.ts  # fireAndForget / toggleEscape（共通 I/O ラッパ）
│       ├── config.ts          # ~/.codiva/config.json の読み書き
│       ├── repo-prompt.ts     # <repo>/.codiva/prompt.md の読み書き（loadRepoPrompt / saveRepoPrompt）
│       ├── privacy.ts        # 学習データ利用の状態取得（~/.claude.json キャッシュ → 非公開 API）
│       ├── notify.ts / open-url.ts / pr.ts / title.ts / transcript.ts
│       ├── alt-screen.ts / mouse.ts    # alt screen / SGR マウスの有効化・無効化
│       └── state-store.ts     # <repo>/.codiva/state.json の読み書き + prune
├── scripts/
│   └── spike.ts               # Phase 1: SDK 挙動検証スクリプト
├── tests/                     # App 全体を通す機能/統合テスト（*.test.tsx）+ helpers.ts（共有フェイク）
└── docs/                      # 本ドキュメント群

# テスト: 単体は実装隣の *.spec.ts、機能/統合は tests/*.test.tsx。
# import は `@/*` → `./src/*` エイリアス（ディレクトリ跨ぎ）。ビルドは tsup、型チェックは tsc --noEmit。
```

## エージェント抽象

codiva は当初 Claude Code（`@anthropic-ai/claude-agent-sdk`）専用で、`SDKMessage` を直接
`SessionState` へ畳み込んでいた（旧 `core/sdk-parse.ts` の `applySdkMessage`）。そのため
「SDK メッセージの形の知識」と「状態をどう変えるか」が 1 か所に混ざり、別のエージェント
（Codex / Grok）を足すには畳み込みごと書き直すしかなかった。Phase A ではこれを 2 段に割り、
provider を差し替えられる境界を入れ、Phase B で 2 つ目の provider（Codex）を載せた。

```
provider のメッセージ ──[アダプタの parse]──▶ AgentEvent[] ──[applyAgentEvent]──▶ SessionState
   SDKMessage                claude-parse.ts       agent-events.ts       core/types.ts
   codex の JSONL            codex-parse.ts        （全 provider 共通）
```

### 1. 境界は `SessionHandle` / `AgentAdapter`（`QueryFn` ではない）

抽象化の線は **1 ターンぶんのストリーム**に引く（`core/agent-ports.ts`）。理由は 2 つ:

- `SessionManager` から上（UI・永続化・PR 自動化・worktree・通知）は既に `SessionHandle`
  越しにしかセッションを触っておらず、**もともとエージェント非依存**だった。境界を新設する
  必要はなく、その下に `AgentAdapter` を足すだけで済む。
- 逆に SDK の `query()` の署名（`AsyncIterable<SDKUserMessage>` + `Options` + `canUseTool` +
  control request）を共通 IF にすると、**全 provider に Claude の制御モデルの模倣を強いる**。
  Codex / Grok が control request を持つ保証はない。

アダプタの責務は 3 つだけ: (1) ストリームを開く（`open`）、(2) provider のメッセージを
`AgentEvent[]` へ写す、(3) 失敗文言を `AgentStopCause` へ分類する（`classifyError`）。
許可要求の型も SDK の `PermissionResult` ではなく自前の `PermissionDecision` にして、provider 形への
写像はアダプタに置く（`PermissionRequest` が既に自前型なので対にした）。

### 2. 中立モジュールは SDK を import しない

`@anthropic-ai/claude-agent-sdk` を import してよいのは **`core/claude-adapter.ts` /
`core/claude-parse.ts` / `core/claude-errors.ts`** だけ。他の `core/` は型も定数も引かない。
この境界のために変えたものが 2 つある:

- `core/config.ts` の `EffortLevel` / `PermissionMode` を SDK の同名 union の再エクスポートから
  **自前の配列 + 導出型**にした（値の集合は同じ）。副作用として SDK 側に値が増えても型では
  気付けないので、SDK 更新時に目視で追従させる。とくに `permissionMode` は Claude Code 固有の
  概念で、他エージェントでは解釈が変わりうる（吸収するのはアダプタの仕事）。
- `core/status-reducer.ts` から `USAGE_LIMIT_ERROR_PREFIXES` の import と `isRateLimitError` が
  消え、CLI の文言・typed error kind・HTTP ステータスの知識は `core/claude-errors.ts` に集まった。
  「使用制限の文言は CLI 側で変わるので SDK に追従したい」という要求は正しいが、**追従してよいのは
  アダプタの中だけ**。

### 3. 畳み込みは共通、写像だけがアダプタ

`applyAgentEvent(state, event, at, agent?)`（`core/agent-events.ts`）が**全 provider 共通の唯一の
畳み込み**で、ログの上限（`pushLogEntry`）・進捗（TODO）・サブエージェントの完了ゲート
（`activeTaskIds` / `deferredResult`）・PR 検出（`gh pr create` の tool_use ↔ tool_result）・
コスト集計・ストリーミングプレビューはすべてここにある。新しいエージェントは自分のストリームを
`AgentEvent` の語彙へ写すだけでよく、codiva 固有の振る舞いを再実装しない。

`AgentEvent` は provider 非依存の語彙になるよう選んである:
`session_started` / `assistant_message` / `assistant_text` / `tool_use` / `tool_result` /
`stream_reset` / `stream_text` / `notice` / `task_started` / `task_settled` / `turn_completed` /
`turn_stopped` / `usage`。ツール名は `AgentToolKind`（`edit` / `shell` / `todo` / `question` /
`other`）へ、TODO 操作は `TodoOp`（`create` / `update` / `replace`）へ、失敗は `AgentStopCause`
（`auth` / `rate_limit` / `connection` / `failed`）へ**アダプタ側で正規化してから**渡す
（`turn_stopped.rollup` は「これは既に診断済みの停止の要約」の印で、2 回目の報告で分類を
やり直して精度を落とさないためのもの）。

`applyClaudeMessage`（`claude-parse.ts`）は parse → fold を合成した薄い糖衣で、1,100 行超の実データ
テスト（`claude-parse.spec.ts` + `__fixtures__/*.jsonl`）が**分割前と同じ入口を叩き続けられる**ように
残してある = 分割のリグレッション網。新しい呼び出し側はこれを増やさず `AgentEvent` 経由にする。

### 4. セッション途中でエージェントを切り替えられる

`Session.setAgent(adapter)` → `CodivaEvent` の `agent_switched`。**worktree（＝実際の成果物）は
provider に依存しない**ので、Claude で始めた作業を途中から Codex に引き継げる。一方**モデル側の
文脈は provider をまたげない**（各 CLI が自分のトランスクリプトを持つ）ため、切替は
「今のターンを終える → 別 provider の**新しいセッション**を同じ worktree で開く」という形になる。
UI の入口は詳細ビューの `/agent`（`ui/agent-select.tsx` → `SessionManager.setSessionAgent(id, agentId)`）で、
選択肢は `listAgents()`（= 合成レイヤが登録したアダプタ）だけを出す。

**切替の実体は「今の run の入力キューを閉じて、新しいキューに差し替える」こと。**
`this.run = undefined` は参照を捨てるだけで、consume ループはその `AgentRun` を掴んだまま回り続け、
アダプタ側は共有キューを `await` して止まっている — つまり閉じない限り**切替後に送った指示は
古いエージェントが受け取る**（切り替えたのに何も起きないように見える。Phase A の積み残しで、
`/agent` を入れて初めて踏める経路だった）。セッション全体の `abortController` を abort する手は
使えない（あれはセッションごと終わらせるため）。畳んだループが終わった時点でキューに積み残しが
あれば（`AsyncQueue.pending`）、新しいエージェントで消費し直す。

| 引き継がれるもの | 引き継がれないもの |
|---|---|
| worktree・ブランチ・作業ツリーの内容 | モデル側の会話文脈（provider ごとに別のトランスクリプト） |
| codiva 側のログ（`messages`）・タイトル・PR・稼働時間 | `sdkSessionId`（切替先の `agentSessions` に無ければ undefined ＝新しい会話） |
| `agentSessions`（provider ごとの resume id） | `streamingText`（前のエージェントの途中表示） |
| セッションの状態（`SessionStatus`）| `model`（解決済みモデルは provider ごとに別物。次のターンが埋める） |

戻ってきたときに続きから再開できるよう、`agentSessions: Partial<Record<AgentId, string>>` に
provider ごとの resume id を控え、**これは永続化する**（`state.json`）。落とすと再起動をまたいで
「Codex に切り替えて、また Claude に戻す」をしたときに過去の会話が消えて新規セッションから
始まってしまう。保存時は現在の `sdkSessionId` も `agentSessions[agent]` へ畳む（`agent_switched` は
切替の瞬間にしか畳まないので、切替せずに終了したセッションの id がそこから漏れる）。`agent` の
無い（切替対応より前の）スナップショットは `'claude'` として復元する。

切替の実装で守っていること:

- **走っているターンを畳んでから差し替える**。2 本のストリームが同じ worktree を触らないように
  現在の run を捨て、保留中の許可は deny で解決する（未応答の `tool_use` で終わるトランスクリプトは
  後の resume を壊す ⇒ `stop()` と同じ理由）。新しいエージェントが立ち上がるのは次の `send()`。
- **resume id は provider をまたいで渡さない**。切替後は `agent_switched` が据えた `sdkSessionId`
  だけを使う（復元時の `deps.resume` は初期エージェント用なので、別 provider へ持ち込むと存在しない
  会話を resume しようとして壊れる）。
- **ログ行の帰属**（`LogEntry.agent`）は**切替が起きたあとだけ**刻む。単一エージェントで完結する
  セッションのログ行の形を変えないため（切替を使っていないユーザーには何も増えない）。

### 5. Claude 専用機能は capability で optional 化する

`AgentCapabilities`（`permissions` / `interrupt` / `setModel` / `resume` / `modelCatalog` /
`usage` / `cost` / `transcript`）で「そのエージェントが何をできるか」を表明する。UI はこれを見て
段階的に縮退する（持たない機能のキー操作・表示を出さない）。参照するときは**固定値として持たず**
`SessionManager.getSessionAgent(id)`（= `SessionHandle.getAgent()`）から引く（セッション途中で
切り替えると変わりうるため）。

現状 Claude だけが持つ（＝他 provider では縮退させる）機能は、使用状況ゲージ（`usage`）・
コスト表示（`cost`）・CLI トランスクリプトからのログ復元（`transcript`）・許可/質問ダイアログ
（`permissions`）・学習データ利用の警告（Claude Code の認証情報を読む `utils/privacy.ts`）。
モデルカタログと `/model`（`modelCatalog` / `setModel`）は Codex も持つが**選べるモデルが
まったく別**なので、UI は駆動中のエージェントで選択肢を出し分ける（取得に失敗しても
互いのモデル名を出さない = `DEFAULT_ONLY_MODEL_OPTIONS`）。
`AgentRun.interrupt` / `setModel` はメソッド自体が optional で、新しいアダプタは
`NO_CAPABILITIES`（全部 false）から始めて実装できたものだけ true にする。
文言側も `i18n.ts` の `AgentLabel`（表示名 + ログインコマンド）を差し込む形にしてあり、
`auth.hint` / `auth.listHint` / `notify.needsLogin` / `action.resumeAllPrompt` は
`(agent: AgentLabel) => string`（既定は `DEFAULT_AGENT_LABEL` = Claude）。エージェント名は固有名詞
なので翻訳しない（モデル名と同じ i18n の例外）。

> 縮退の配線は Phase D で段階的に入れている。現状効いているのは `/model`（`setModel` /
> `modelCatalog`）と `Ctrl+C`（`interrupt`）だけで、使用状況ゲージ・コスト・許可ダイアログ・
> トランスクリプト復元はまだ capability を見ていない（[TASKS.md](./TASKS.md) の Phase D）。

### 6. Codex アダプタ: 1 ターン = 1 プロセス

Codex（`codex` CLI）は Phase B で入れた 2 つ目の provider で、実装は `core/codex-events.ts`
（JSONL の型と受理ガード）/ `core/codex-parse.ts`（`AgentEvent[]` への写像）/
`core/codex-errors.ts`（文言 → `AgentStopCause`）/ `core/codex-adapter.ts`（制御）の 4 点と、
唯一の I/O `utils/codex.ts`。Claude 側の 3 点セットと**対称**に置いてある。

**`@openai/codex-sdk` を npm 依存に足さず、ユーザーがインストールした `codex` CLI を起動する**
（`gh` / `git` と同じ扱い）。SDK を依存にすると Codex を使わないユーザーにもプラットフォーム別の
大きなバイナリが降ってくるため。認証もユーザーの `codex login` に委ね、codiva は資格情報を触らない。

Claude と決定的に違うのが**プロセスの粒度**。Claude Agent SDK は 1 本の streaming-input セッションが
何ターンでも続くが、`codex exec` は**1 ターン走って終了する**プロセスで、続きは
`codex exec resume <thread_id> <prompt>` として起動し直す。アダプタはこの差を内側に閉じ込める:

```
prompt キュー ──▶ codex exec --json <p1>        ──▶ thread.started(th) … turn.completed
             └─▶ codex exec resume th <p2>      ──▶ thread.started(th) … turn.completed
```

- `AgentRun` の非同期イテレータが `request.prompt` を回し、指示 1 件につき 1 プロセスを起こす。
  `thread.started` の `thread_id` を控えて次のターンへ引き回す（resume した回も**同じ id** が
  再度届くので、`session_started` は no-op になる）。
- **`--system-prompt` 相当が無い**ので、`composeSystemPrompt()` の結果は**最初のターンの指示文に
  前置**する（2 ターン目以降は同じスレッドの resume なのでモデルは既に読んでいる）。
  `AGENTS.md` を書く方法は取らない — 対象リポジトリのファイルを codiva が勝手に触らないため。
- `setModel` は「次のターンから」効く（走っているプロセスには反映されない）。ターンごとに
  起動し直す形なので、これが自然な契約になる。
- 終端イベント（`turn.completed` / `turn.failed`）が来ないままプロセスが終わることがある
  （中断・`codex` 未導入での起動失敗）ので、そのときだけ**終了コードと stderr で補う**。

#### Codex の capability と、`permissions: false` の帰結

| capability | Codex | 理由 |
|---|---|---|
| `permissions` | **false** | exec の JSON モードは承認要求を上げられない（下記） |
| `interrupt` | true | プロセスを殺せばターンが止まる |
| `setModel` | true | 次のターンの `--model` として効く |
| `resume` | true | `codex exec resume <thread_id>` |
| `modelCatalog` | true | `codex debug models` がローカルのカタログを JSON で吐く（推論もコストも無い） |
| `usage` | **false** | アカウント全体の使用状況を運ぶイベントが無い |
| `cost` | **false** | `turn.completed` はトークン数だけで **USD を運ばない** |
| `transcript` | **false** | rollout（`~/.codex/sessions`）は Claude CLI の JSONL と別形式 |

`permissions: false` が一番重い制約。`codex exec` の JSON モードは、コマンド実行・パッチ適用・
MCP のいずれの承認要求も **CLI 内部で自動 reject** し、JSONL には何も出さない
（Codex の `codex-rs/exec/src/lib.rs` の `handle_server_request`）。つまり
**codiva が許可要求を UI に上げる経路が原理的に無い**。ここで「それらしいダイアログ」を出すと、
ユーザーが `y` を押しても実際には拒否されているという最悪の嘘になるので、**capability を false に
して黙って出さない**方を選んだ（`AgentAdapter.requestPermission` は Codex では呼ばれない）。

その結果、Codex セッションに対する安全弁は**サンドボックスだけ**になる。だから設定
`codexSandbox`（既定 `workspace-write` = 書き込みは worktree 内に限定・読み取りは全体）を
足し、`approval_policy="never"` を明示して「聞かれて止まる」経路を潰してある。
`codexNetworkAccess` の既定を `true` にしているのは、Codex 自身の `workspace-write` 既定が
ネットワーク遮断で、そのままだと `npm install` / `gh` が失敗して大半の作業が完了しないため
（安全側に倒したいときは `false` にできる）。

#### `error` 行は終了ではない（`turn.failed` だけが終わり）

Codex は接続が切れると `{"type":"error","message":"Reconnecting... 1/5 (stream disconnected …)"}`
を **stdout の JSONL として**流しながら再試行し、諦めたときだけ `turn.failed` を出す（実測。
`__fixtures__/codex-failure.jsonl`）。`error` を素直に終了扱いにすると、**放っておけば自力で
回復するセッションが赤くなる**。そこで:

- `error` は `notice`（system 行）1 行に落とすだけで状態を動かさない。再試行の実況は
  `coalesceKey`（`'Reconnecting'`）で直前の同種行を書き換え、5 連発でログを埋めない
  （Claude の API リトライ表示と同じ仕組み）。
- ターンが本当に落ちた信号は `turn.failed` と、終端イベント無しの非ゼロ終了コードだけ。
  そこから `classifyCodexError` が `auth` / `rate_limit` / `connection` / `failed` へ分類する
  （判定順は Claude 側と同じく**認証切れが最優先**）。

## セッション状態機械

`SessionStatus` の遷移。導出元はすべてエージェントのイベントストリーム（`AgentEvent`）と許可要求。
以下の記述は Claude アダプタでの具体（`SDKMessage` の subtype など）を含むが、状態機械そのものは
provider 非依存。

```
 creating ──(worktree作成完了 & query開始)──▶ running
 running ──(canUseTool 発火)───────────────▶ awaiting_permission
 awaiting_permission ──(ユーザー応答)────────▶ running
 running ──(result 受信 & 質問で終了)────────▶ awaiting_input
 running ──(result 受信 & 正常終了 & サブエージェント未稼働)──▶ completed
 running ──(result 受信 & サブエージェント稼働中)──▶ running    # 結果を deferredResult に保留し running 継続
 running ──(最後の task_notification で全タスク完了 & 保留結果あり)──▶ completed
 running ──(result subtype がエラー系)───────▶ failed
 running ──(レート制限に到達)─────────────────▶ rate_limited # rate_limit_event(rejected) / error='rate_limit' / usage-limit result・throw
 running ──(認証切れ)───────────────────────▶ needs_login  # assistant error='authentication_failed' / is_error 付き result / auth 文言の errors[]・throw
 awaiting_input ──(追加指示送信)─────────────▶ running
 completed ──(追加指示送信)─────────────────▶ running   # 完了後の追加作業も許す
 running ──(通信断で query が throw / エラー result & sdkSessionId あり)──▶ interrupted # 接続中断。resumable
 running ──(応答途中で API エラー)───────────▶ interrupted # assistant error='server_error'/'overloaded' / terminal_reason='api_error' & 一時的な status
 * ──(query の throw / abort)──────────────▶ failed  # 通信断以外（or sdkSessionId 無し）
 completed ──(マージで競合検知 → merge --abort)──▶ conflict  # 自動解消しない。解消は人手（終端扱い）
 conflict ──(手動解消後の再マージ or 破棄)────▶ archived
 completed ──(マージ or 破棄)────────────────▶ archived
 running/awaiting_* ──(アプリ終了 → 保存)────▶ interrupted # メモリ上は状態不変。保存時に丸める（restorableStatus）
 rate_limited ──(アプリ終了 → 保存)──────────▶ interrupted # 制限は一時的。復元時は resumable な interrupted に丸める
 needs_login ──(再ログイン後 追加指示 / 再開アクション)──▶ running # 認証が戻れば同じ SDK 会話を resume
 needs_login ──(アプリ終了 → 保存)───────────▶ interrupted # 次回起動時には再ログイン済みかもしれない
 interrupted ──(追加指示送信 / 再開アクションで resume)───────▶ running # 生存中セッションもその場で再開（consume ループ再起動）
 running/awaiting_* ──(ユーザーが Ctrl+C)─────▶ interrupted # 詳細ビューの中断。resumable（後述）
```

`interrupted` は「クリーンに完了していないが resume で続行できる」セッションを表す。発生元は4つ:
(1) **通信断**（`Session.consume` の for-await が throw、または接続断を示すエラー `result`。判定は
アダプタの `classifyError`（Claude は `core/claude-errors.ts` の `isConnectionError`）で、resume 元となる
`sdkSessionId` がある場合のみ。無い＝init 前の早期失敗は `failed`）。(2) **応答途中の API エラー**（後述）。(3) **アプリ終了時の丸め**（`restorableStatus` が実行中/
入力待ちを保存時に `interrupted` にする。`stop()` はメモリ上の状態を変えない）。(4) **ユーザーによる中断**
（詳細ビューの `Ctrl+C`。後述）。いずれも `completed` と同じく idle で resumable。追加指示または
**再開アクション（一覧/詳細の `r`）** で resume できる — 送信すると `SessionManager.send` → `Session.send`
が（通信断で終了した）consume ループを `resume: sdkSessionId` 付きで**再起動**し、同じ SDK 会話を続行する
（生存中セッションでもその場で再開でき、アプリ再起動を待たなくてよい）。通信断遷移時はデスクトップ通知
（`notify.interrupted`）で中断をユーザーに知らせる。判定ヘルパは `core/status-meta.ts` の `isResumable`
（`STATUS_META[status].resumable` = `interrupted` / `rate_limited` / `needs_login`）。再開時に送る指示文は
`core/resume.ts` の `resumeInstruction(status, m)`（既定は `resume.instruction`、認証切れは
`resume.authInstruction`）。

**復帰はワンプッシュ**（`Ctrl+R`）。中断の原因（通信断・レート制限・認証切れ）に関わらず、一覧でも詳細でも
**フォーカス／操作パネルの状態に関係なく**効く chord にしてある。フォーカス依存のキー（一覧リストの `r`、
詳細の操作パネルの `r`）は「Tab で移動 → r」の2手が必要で、既定フォーカスが入力欄である以上それは
「楽なリカバリ」にならない。印字キーを潰さない chord なので、入力中に打っても文字が化けない。
案内（`resume.oneKeyHint` / 認証切れは `auth.hint`）はフッタではなく**独立した行**として出す —
フッタヒントはフォーカスで切り替わるので、入力欄にいる間だけ復帰方法が消えてしまう。

**一括再開は `Ctrl+A`**（一覧のみ、2件以上のときだけ、y/n 確認あり）。回線が落ちる・蓋を閉じると走って
いたセッションが揃って中断されるため、1件ずつ選び直させない。対象は `core/resume.ts` の
`resumableSessions(sessions)`（純関数）で、件数を `resume.allHint(n)` / `action.resumeAllPrompt(n, auth)`
に出す。単体の `Ctrl+R` が確認なしで即送るのに対し一括は確認を挟む（全中断セッションへ同時に指示 =
誤爆が課金に直結するため）。確認文には**認証切れの件数**も出す — `needs_login` には「ログインし直した」
という指示文を送るので、まだログアウトのままだと transcript に嘘が残る。
自動リトライはしない（勝手に走り出さない・意図せず課金が進まないことを優先）。

**多重送信の防止は `SessionManager.resume(id, instruction)`** に置く（View ではなく core 側）。UI の
ストア購読は ~100ms スロットルなので、送信直後もビュー側の status は `interrupted` のまま見える —
キーの連打・オートリピートで同じ指示が2回積まれると二重課金＋ログ二重化になる。`resume()` は
**ストアの現在値**（`send` が同期的に `running` へ進める）で `isResumable` を確かめてから送り、送ったかを
返す。View（`Ctrl+R` / 一覧の `r` / 一括）はすべてこれを経由する。

**ユーザーによる中断（詳細ビューの `Ctrl+C`）**: 走っているターンを止めたいだけで、セッションを捨てたい
わけではない（Claude Code の `Ctrl+C` と同じ操作）。`SessionDetail` → `SessionManager.interrupt(id)` →
`Session.interrupt()` → SDK の `Query.interrupt()` で、状態は **`interrupted`（idle & resumable）** に落ちる。
`stop()`（状態を変えずプロセスだけ落とす）/ `abort()`（`failed` にする）とは別物。

- **状態は SDK の応答を待たずに先に確定させる**。理由は2つ。(a) 体感: interrupt は control request なので
  CLI の応答まで待つと押しても数百 ms 反応しない。(b) 分類: CLI は中断されたターンを
  `subtype: 'error_during_execution'` + `is_error: true` + **`terminal_reason: 'aborted_streaming'`** の
  result で閉じる（実測: `__fixtures__/session-interrupt.jsonl`）ため、診断が無いと `failed` に落ちる。
  先に `interrupted` を立てておけば、result 側は**すでに resumable なら診断を維持**するロールアップガード
  （`isResumable`）でコストだけを拾う。
- **`claude-parse` 側も `aborted_streaming` を `interrupted` に分類する**（保険）。中断のあとに assistant
  メッセージが 1 通挟まって status が `running` へ戻っても、ターンの終わりは `failed` にならない。ログに
  書くのは `USER_INTERRUPT_DETAIL`（= `'interrupted by user'`）で、CLI の内部診断
  （`errors: ['[ede_diagnostic] …']`）は出さない。2 経路で**同じ文言**を使うので `toInterrupted` の
  重複畳み込みが効き、ログは 1 行だけになる。
- **許可/質問待ちでも中断できる**（`isInterruptible` = `running` / `awaiting_permission` / `awaiting_input`）。
  ダイアログの `n`（deny）は「その 1 ツールを断る」だけでターンは続くので、「この作業自体をやめる」出口は
  これしかない。`Ctrl+C` は詳細ビューの `useInput` で**`pending` ガードより前**に処理し、`toInterrupted` が
  `pendingPermission` を落とすことで `commit()` の既存経路が canUseTool の promise を deny で閉じる
  （未応答の `tool_use` で終わる transcript は後の resume を壊す ⇒ `stop()` と同じ理由）。
- **連打の吸収は `SessionManager.interrupt(id)`**（`resume()` と同じ理由で core 側。UI の購読は
  ~100ms スロットルされていて「もう中断済み」を同期的に知らない）。ストアの現在値で `isInterruptible` を
  確かめ、中断を試みたかを返す。
- 中断後は `interrupted` なので**そのまま `Ctrl+R` / 追加指示で続けられる**。案内も `detail.cancelHint`
  （実行中）→ `resume.oneKeyHint`（中断後）と同じ 1 行を状態で入れ替える。

**応答途中の API エラー（`API Error: Connection closed mid-response.`）**: ストリーミング中に接続が切れると
CLI は「そこまでの部分応答を確定させて」ターンを終える。ワイヤ上は `error: 'server_error'` を立てた
assistant メッセージ（本文が `API Error: Connection closed mid-response. The response above may be
incomplete.`）→ それを集約する `result`（`subtype: 'success'` + `is_error: true` +
`terminal_reason: 'api_error'` + `api_error_status: null`）の2連で届く。応答は途中で切れているのに
`subtype` だけ見ると成功なので、素直に扱うと**尻切れの回答が緑の「Completed」になる**。判定は2段構え:

1. **assistant メッセージの型付き `error` 種別**（`isTransientApiErrorKind` = `server_error` / `overloaded`）。
   文言・ロケールに依存しないのでこれが主シグナル。`max_output_tokens` は CLI がターンを継続して回復する
   ため対象外、`invalid_request` / `billing_error` は再試行で直らないので `failed` のまま。対象は
   **トップレベルターンのみ**（`parent_tool_use_id` が null）— サブエージェント内の同種エラーは失敗した
   tool_result として本体ターンへ返り Claude が回避できるので、セッションは止めない。
2. **result の `terminal_reason: 'api_error'` + `api_error_status`**（`isTransientApiStatus`。明示的な
   `null`＝HTTP 応答すら無い接続断、5xx/408/429 が一時的）。CLI の文言は多数（`Server error
   mid-response` / `Response stalled mid-stream` / `Please wait a moment and try again` …）で変わりうる
   ため、`isConnectionError` の文字列一致は最後の保険として残す。**フィールドが無い（`undefined`）場合は
   一時的扱いにしない** — `api_error_status` は success バリアントにしか存在せず、`error_during_execution`
   の result では欠落が何も意味しないので、欠落を「HTTP 応答無し」と読むと 400 まで resumable になる。

どちらも `toInterrupted` に落ちる。同じ失敗が assistant → result の2回届くため:

- `toInterrupted` は **最後の `system` ログが同文なら no-op**（`status === 'interrupted'` の間だけ）。
  間に別のログ（宙ぶらりんの tool_use に対する tool_result 等）が挟まっても重複しない。
- result 側は **すでに resumable な状態（`isResumable` = interrupted / rate_limited / needs_login）なら
  コストだけ拾って再分類しない**。型付きシグナルの方が文言判定より正確なので、CLI の言い回しが未知な
  ときに「ログインし直し」を `failed` の袋小路へ落とさない。

加えて `system/api_retry`（CLI が再試行する時に流れる）を system ログへ1行残す — 出さないと不安定な回線が
「ただ止まっている」ようにしか見えず、再試行が尽きた時の中断通知に前後の文脈が残らない。連続する再試行は
**同じ行を書き換える**（1リクエストで最大 `max_retries` 件来るので、追記すると会話がビューポートから
押し出される）。ダイアログ保留中に中断した場合は `Session.commit` が canUseTool の Promise を deny して
解決する（未応答の tool_use で transcript が終わると後の resume が失敗しうる）。

**サブエージェント（Task ツール）の完了ゲート**: サブエージェントが **バックグラウンド実行**されると、
その tool_result は即座に返り本体ターンは続行するため、サブエージェントがまだ稼働中でも**トップレベルの
`result/success` が先に届く**。この result をそのまま `completed` にすると、実際には作業継続中なのに
バッジが「Completed」へ倒れてしまう（本 issue の不具合）。対策として `system/task_started` /
`system/task_notification` で稼働中タスク集合（`activeTaskIds`）を追跡し、result 受信時にタスクが残って
いれば `completed` にせず結果を `deferredResult` に保留して `running` を維持する。最後のタスクが
`task_notification` で settle し集合が空になった時点で保留結果を使って `completed` を確定する。
形の解釈（`system/task_started` → `task_started` イベント）は `claude-parse.ts`、**ゲートそのものは
`agent-events.ts` の `applyAgentEvent`**（`task_started` / `task_settled` / `completeWith`）にあり
**全 provider 共通**なので、他のエージェントは「タスクが始まった/片付いた」を報告するだけでよい。
`skip_transcript` の雑務タスクは
ゲート対象外。`activeTaskIds` / `deferredResult` は transient で永続しない。実データは
`__fixtures__/session-subagent.jsonl`（スパイクの `subagent` シナリオで採取）。

`rate_limited` は「使用量／レート制限に達して止まった」セッションを表す。`completed`/`failed` と同じく
idle だが、エラー扱い（`failed`）にはせず「制限が解けるのを待って再開できる」状態として区別する。
検知元は SDK の `rate_limit_event`（`rate_limit_info.status === 'rejected'`）、assistant メッセージの
`error === 'rate_limit'`、および usage-limit を示す `result`／throw されたエラー文言
（`core/claude-errors.ts` の `isRateLimitError`。SDK の `USAGE_LIMIT_ERROR_PREFIXES` に追従）。
制限は一時的なので保存時は `interrupted` に丸める。

`needs_login` は「エージェントの認証が切れて止まった」セッションを表す。作業自体の失敗ではなく、ユーザーが
別ターミナルで `claude` に `/login` し直せば resume できるので、`failed` とは区別する。

**とくに `completed` にしてはいけない**。CLI は認証エラーを次の2メッセージで報告する（実バイナリで確認）:

```jsonc
// 1) CLI が合成する assistant メッセージ（型付きの error フィールドが本体）
{"type":"assistant","error":"authentication_failed",
 "message":{"content":[{"type":"text","text":"Failed to authenticate: OAuth session expired and could not be refreshed"}]}}
// 2) それを畳み込む result。subtype は "success" のまま is_error が立つ
{"type":"result","subtype":"success","is_error":true,"terminal_reason":"api_error",
 "result":"Failed to authenticate: OAuth session expired and could not be refreshed"}
```

`subtype === 'success'` だけを見て完了扱いにすると「何も作業していないのに緑の Completed」になり、
auto-PR まで走ってしまう（本 issue の不具合）。そのため result 処理は **`subtype === 'success' && !is_error`
のみを完了**とし、それ以外は文言分類（認証 → レート制限 → 通信断 → `failed`）へ流す。エラー系 subtype は
`result` を持たず `errors: string[]` で理由を運ぶ（`SDKResultSuccess` / `SDKResultError`）ので両方を読む。

検知の優先順は次の通り:

1. **assistant メッセージの型付き `error`**（`core/claude-errors.ts` の `isAuthErrorKind` = `authentication_failed`
   / `oauth_org_not_allowed`）。`SDKAssistantMessageError` として型定義されており文言・ロケールに依存しない
   ため、これを一次シグナルにする（既存の `error === 'rate_limit'` フックと同じ位置）。
   `billing_error`（残高不足）は再ログインで直らないので対象外＝ `failed` のまま。
2. **`is_error` 付き result**、および認証文言を含む `result` / `errors[]` / throw された例外
   （`isAuthError`。CLI の実文言 = OAuth 失効・トークン失効・APIキー不正・クラウド資格情報失効・
   `/login` 指示・re-authenticate を網羅する二次シグナル）。

認証切れは待っても直らないので、レート制限・通信断より**先に**判定する（`Session.consume` の throw 経路も
同様。`Failed to authenticate through the broker: request timed out` のような文言を通信断と誤分類しない）。
再開可能な状態へ落ちるときは保留中の許可を deny して解決しておく（宙ぶらりんの tool_use は後の resume を
失敗させ得る。`stop()` と同じ理由）。同じ失敗が assistant と result の2回届くため `toNeedsLogin` は
冪等（同一 detail なら同一参照を返す）。

`attention: true`（一覧に ● を出す）なのは、`rate_limited` と違い放置しても解決せずユーザーの操作が
必須だから。UI は「別ターミナルで `claude` にログインして再開」という手順そのものを出す
（i18n `auth.hint` / `auth.listHint`。どちらもエージェント名とログインコマンドを差し込む
`(agent: AgentLabel) => string` で、既定は `DEFAULT_AGENT_LABEL` = Claude）。保存時は `interrupted` に丸める（次回起動時には再ログイン済みかも
しれない）。なお `auth_status` メッセージは CLI の対話的 `/login` UI 用で、`--enable-auth-status`
オプトイン時のみ流れる（この SDK 版の型にも無い）ため API 認証エラーの検知には使えない。

`rate_limit_event` は `rejected` でセッションを `rate_limited` にする一方、`allowed` / `allowed_warning`
も含めて **アカウント全体の claude.ai サブスクリプション使用状況**（5時間枠・週次枠など）を運んでくる。
これはセッション状態ではなくアカウント横断の情報なので、`Session` は `onRateLimit`（DI）で生の
`rate_limit_info` を `SessionManager` へ渡し、manager が **ウィンドウ種別ごとに最新値**を保持する
（`core/rate-limit.ts` の `toRateLimitWindow` で正規化 = `resetsAt` は秒→ms、`utilization` は 0-100%）。
`getRateLimits()` は表示順にソートした安定参照を返し、`Banner` が `useRateLimit` で購読して
「現在のセッション ████░░░░ 42% 2時間45分後にリセット」のように描画する（枠が無い＝API キー利用時は非表示）。

#### プラン表示と使用状況ポーリング（ヘッダ）

`rate_limit_event` は **セッションがターンを回している間しか届かない**ので、起動直後や全セッションが
待機中のときは何も出せない。そこで Claude Code のステータスライン相当の表示を作るため、SDK の
control channel を叩く **probe** を第2の情報源として足している。

```
                    ┌─ Session.onRateLimit ──▶ rate_limit_event（ターン開始ごと・status を持つ）─┐
アカウント横断の情報 ─┤                                                                          ├─▶ SessionManager
                    └─ bootstrap/usage-poller ─▶ utils/usage-probe（5分ごと・plan と utilization）┘
```

- **probe の作り**（`utils/sdk-probe.ts`）: `query()` を streaming-input で開き、**何も送らないまま**
  control channel の応答（`supportedModels()` / `accountInfo()` /
  `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET()`）だけを読んで即 abort する。
  推論は走らないのでトークン消費はゼロ。`fetchModelCatalog` もこの共通基盤に載せ替えた。
- **プラン名の出所は `accountInfo()` だけ**（`core/account.ts` の `toAccountSummary`）。
  `subscriptionType`（例 `'Claude Team'`）は SDK 由来の表示文字列なのでそのまま出す
  （i18n の例外。モデル名と同じ扱い）。組織名は Team / Enterprise のときだけ付く。
- **usage 応答の解釈は `core/usage.ts` だけ**（`toUsageSnapshot`）。実測（TECH_NOTES 参照）で
  **`rate_limits_available: true` でも `rate_limits: null` があり得る**ため、「available」を根拠に
  枠を描かない。枠が無ければイベント側の情報だけで表示する。
- **2つの情報源の合流は `mergeUsageWindow`**（純関数）。usage 応答には `status` が無く、実際の
  `five_hour` イベントには `utilization` が無いので、どちらも他方の上位集合ではない。フィールド単位で
  合流し、`status` は最後にイベントが言った値を引き継ぐ。表示に影響が無ければ **同一参照を返す**
  （`useRateLimit` / `useAccount` の再描画抑制がこれに依存）。
- **ポーリング間隔は 5 分**（`bootstrap/usage-poller.ts`）。枠自体が 5時間／7日単位で、リセットまでの
  カウントダウンは `useClock` がローカルで毎秒進め、稼働中セッションはターンごとにイベントを押してくる
  ——ので、ポーリングは「待機中を埋める」役でよい。1回ごとにサブプロセスが1本立つため秒単位にはしない。
  **2回連続で何も取れなければ停止**する（API キー / Bedrock / Vertex ログインでは永久に取れないため）。
- **表示先はヘッダ（`Banner`）だけ**。プラン行は `bannerLines()`、使用状況の行（ゲージ + 使用率 +
  残り時間）は `bannerUsageRows()` + `gaugeCells()` が組む（記号は `theme.ts`。詳細は下の `Banner` の項）。
  **`utilization` が無い枠にゲージは描かない**（0% と読めてしまうため、残り時間だけ出す）。
- **`StatusFooter` は使用状況を持たない**。以前はフッタ右端にもプラン名 + 上位2枠を出していたが、
  1行に収めるための段階的縮退（2枠 → 1枠 → ゲージ → プラン名）が必要で、モードとヒントという
  フッタ本来の情報が読みづらくなっていた。**プラン / 使用状況はヘッダへ集約**し、フッタは
  「モード表示（縮まない） + ヒント（唯一縮む）」の2要素だけにした（どの幅でも1行を保つ点は不変で、
  `status-footer.spec.tsx` が実際の描画幅で検証している）。ヘッダを持たない詳細ビューでは出ない
  （見たいときは Esc で一覧へ戻る）。

`SessionState`（UI が購読する不変スナップショット）:

```typescript
interface SessionState {
  id: string;
  title: string;              // タスク名。起動直後は指示文由来の暫定値、Haiku 要約が返り次第差し替え（title イベント）
  status: SessionStatus;
  prompt: string;             // 最初の指示文
  branch: string;             // codiva/<slug>
  worktreePath: string;
  todos: TodoItem[];          // TaskCreate/TaskUpdate（+ 旧 TodoWrite）から構築した最新スナップショット
  progress?: { done: number; total: number }; // todos から導出
  messages: LogEntry[];       // 整形済みログ（**上限付き**: core/log-buffer.ts）。SessionDetail のログビューで表示し、復元時は SDK transcript から再構築
  pendingPermission?: PermissionRequest;      // awaiting_permission / awaiting_input 時のみ
  sdkSessionId?: string;      // system/init から取得。resume 用に保持
  model?: string;             // セッション個別のモデル上書き（/model）
  pr?: PrRef;                 // 検知した PR の番号・URL（ブランチに対して不変。**永続する**）
  extraPrs?: readonly PrRef[];// セッション自身が別ブランチで作った PR（`gh pr create` の結果から検知。**永続する**）
  prCreateToolIds?: readonly string[]; // 結果待ちの `gh pr create` の tool_use id（対応付け用。transient）
  prStatus?: PrStatus;        // merge 可否 / checks / draft（揺れる。transient・期限付きキャッシュ）
  prLookup?: PrLookupState;   // 'loading'（確認中）/ 'error'（gh が答えられなかった）。transient
  conflictFiles?: string[];   // conflict 時の競合ファイル（自動解消はしない）
  startedAt: number;
  finishedAt?: number;
  activeMs: number;           // 「実際に動いた時間」の累積（active な区間のみ積算）
  activeSince?: number;       // 現稼働セグメントの開始時刻（idle なら未設定）
  totalCostUsd?: number;      // result の total_cost_usd 累計
  error?: string;
  rateLimitResetsAt?: number; // rate_limited のときの解除予定時刻
  streamingText?: string;     // stream_event の text_delta プレビュー（transient・永続しない）
  activeTaskIds?: string[];   // 稼働中のサブエージェント（完了ゲート用。transient）
  deferredResult?: { at: number; totalCostUsd?: number; resultText: string }; // 保留した result（同上）
  logSeq: number;             // LogEntry の採番カウンタ
}
```

### 状態導出ルール

- **Step n/m**: `assistant` メッセージ内の tool_use から TODO スナップショットを構築する。`TodoWrite`（`input.todos` 配列で全置換）と `TaskCreate`/`TaskUpdate`（増分更新）の**両方に対応**する（SDKの世代により流れてくるツールが異なる。TECH_NOTES.md 参照）。`done = status === 'completed' の数`, `total = 全数`。
- **質問あり**: Claude がユーザーへの質問に使う `AskUserQuestion` ツールは、allow ルールに関係なく必ず `canUseTool` コールバックに届く（公式仕様）。`toolName === 'AskUserQuestion'` を検知したら `awaiting_input` に遷移し、質問と選択肢を UI に表示。ユーザーの回答を `updatedInput` に載せて allow で返す。補助として、`result` 受信時に直近 assistant テキストが疑問文で終わる場合も `awaiting_input` にする（ツールを使わず地の文で質問するケース）。
- **許可待ち**: `canUseTool` コールバック（`AskUserQuestion` 以外）が呼ばれたら `PermissionRequest` を state に積み、UI の応答で Promise を resolve する。コールバックの Promise が解決されるまでセッションはブロックされる（公式仕様として保証）。

## 主要クラスの責務

### Session (`core/session.ts`)

1セッションのライフサイクルを保持する。

- コンストラクタで `agent`（`AgentAdapter`）を **DI で受け取る**（省略時は `queryFn` から Claude アダプタを組み立てる短縮形）。テストでは合成イベントストリームを返すフェイクアダプタを注入する。
- 入力は provider 非依存の `AsyncIterable<string>`: 内部キュー（push 可能な async queue）を `AgentRunRequest.prompt` として渡し、`send(text)` でいつでも追加できる。`SDKUserMessage` への包み直しはアダプタの仕事。
- 受信ループ: `for await (const event of run)` で各 `AgentEvent` を `applyAgentEvent()`（`core/agent-events.ts`）に畳み込む。provider のメッセージ形状の解釈はアダプタ（Claude なら `core/claude-parse.ts`）に閉じ、純粋 reducer（`reduce(state, CodivaEvent)`）は codiva 起点の型付きイベントだけを扱う。UI アクション（追加指示・許可・モデル切替等）は `reduce` へ dispatch。変更のたびに `onChange` を発火。
- `getAgent()` / `setAgent(adapter)`: 駆動するエージェントの読み取りと差し替え（後述「エージェント抽象」）。UI は `getAgent().capabilities` を見て持たない機能を隠す。
- 例外経路の分類もアダプタ任せ: `catch` した文字列は `adapter.classifyError?.(error) ?? 'failed'` で `AgentStopCause` にしてから `aborted` / `interrupted` を dispatch する。
- `respondToPermission(result)`: 保留中の canUseTool Promise を resolve。
- `interrupt()` / `abort()`: SDK の interrupt / AbortController。**`interrupt()` は「走っているターンだけをやめる」**（詳細ビューの `Ctrl+C`）: サブプロセスは生かしたまま `interrupted`（idle & resumable）にし、追加指示 / `Ctrl+R` で同じ SDK 会話を続けられる状態にする。状態は SDK の応答を待たずに**先に**確定させる（体感 + 分類。下記「ユーザーによる中断」を参照）。許可/質問待ちで呼ばれた場合は `commit()` の既存経路が canUseTool の promise を deny で閉じる（未応答の `tool_use` は後の resume を壊す）。`isInterruptible` でない状態では何もしない。
- `SessionOptions`（`model`/`effort`/`permissionMode`/`maxBudgetUsd`/`appendSystemPrompt`/`ignoredFiles`）を DI で受け、provider 非依存の `AgentRunOptions` に写してアダプタへ渡す（設定ファイル由来）。SDK の `Options`（`canUseTool` / `settingSources` / `includePartialMessages` / `permissionMode` 未指定時の `acceptEdits`）を組み立てるのはアダプタ側。
- **systemPrompt の組み立ては純関数 `core/system-prompt.ts`（`composeSystemPrompt`）**。要素は「worktree の環境説明」→「リポジトリ追加指示」の順（前提の説明が先、著者の具体的な指示が後）で、どちらも無ければ `undefined`（= `systemPrompt` を渡さない）。`session.ts` は文言も結合順も持たない。
- **worktree の環境説明（共有 symlink の注意書き）**: `ignoredFiles: 'symlink'`（既定）では ignore 済みパスが元リポジトリの実体を指すため、セッションが依存更新やビルドを走らせるとメインチェックアウトと並行セッションに波及する。そこで**このモードのときだけ** `SHARED_IGNORED_FILES_NOTICE` を systemPrompt に載せ、「読むのは安全 / 書く前にそのパスだけリンクを切って独立させる / リンク越しに消さない（`rm -rf <path>/` 禁止）/ 触らない作業では何もしない」を伝える。モードは合成レイヤの `sessionOptionsFrom(config, appendSystemPrompt)`（`bootstrap/build-manager.ts`。config → `SessionOptions` の対応付けだけを持つ純関数で、spec で固定してある）が `resolveIgnoredFilesMode(config)` で解決して `SessionOptions.ignoredFiles` へ渡す。解決箇所は合成レイヤの2つ（`index.tsx` の `WorktreeManager` 生成とここ）だが、どちらも同じ config 由来なので一致する。**既知の制約**: モードは state.json に永続していないので、`symlink` で作った worktree を後から `copy` / `none` 設定で復元すると注意書きが載らない（設定を変えた場合のみ。逆向き＝実体があるのに注意書きが載るケースは、手順1の `test -L` 判定で無害化される）。**codiva 側でリンクを張り替えることはしない** — 何が書き込み対象かは指示内容次第で、先回りして全部コピーすると symlink モードの利点（複製コストゼロ）が消えるため、判断はセッションに委ねる。文言は AI 向けなので英語・i18n カタログ対象外（`utils/title.ts` と同じ扱い）。
- **リポジトリ追加指示（`.codiva/prompt.md`）**: 合成ルート（`index.tsx`）が起動時に `loadRepoPrompt(repoRoot)` で読み、`buildManager` → `SessionOptions.appendSystemPrompt` へ流す。`consume()` は上記と合成して `options.systemPrompt` として渡す。SDK は systemPrompt 省略時に空文字へ写像する（claude_code プリセットは使わない）ため、文字列を渡すのは「空への追記」と等価で現挙動を変えない。CLAUDE.md は `settingSources: ['project']` 経由で別途注入されるので、これはそれへの上乗せ。将来ベースの systemPrompt を導入する場合は array / preset-append 形へ切り替える（`session.ts` の注入コメント参照）。
- **復元対応**: `resume`（SDK セッションID）と `restored`（復元済み `SessionState`）を DI で受けられる。復元セッションは `start()` せず、最初の `send()` で遅延的に query を開始（`resume` 付き）。これで起動時にサブプロセスを乱立させない。
- `stop()`: 状態を変えずにサブプロセスだけ落とす quiet 停止。アプリ終了時はこれを使い、実行中セッションを resumable のまま保存する（`abort()` は failed にする点が違い）。保留中の許可要求があれば deny で解決してから停止する（未応答の `tool_use` で resume が壊れるのを防ぐ）。

### SessionManager (`core/session-manager.ts`)

- `create(prompt)`: slug生成 → WorktreeManager.add() → Session 起動。同期的に `creating` 状態のエントリを即時返す（UI を待たせない）。
- **タイトル生成**: `generateTitle`（DI、`utils/title.ts` が Haiku で実装）を各 fresh セッションに渡す。`Session.start()` が指示文を要約させ、返り次第 `title` イベントで暫定タイトルを差し替える（restore 済みセッションは保存済みタイトルを維持し再生成しない）。I/O は注入なので reducer/session は純粋・テスト可能。
- 全セッションの `Map<id, Session>` を保持し、`subscribe(listener)` / `getSnapshot(): SessionState[]` を提供（React の `useSyncExternalStore` にそのまま接続できる形）。
- スナップショットは毎回新しい配列参照を返すが、**変更のあったセッション以外のオブジェクト参照は維持**する（不要な再描画防止）。
- `dispose()`: 全セッションを **`stop()`（quiet）**（worktree は残す）。実行中でも resumable なまま。
- `onTransition(prev,next)`: ステータス遷移ごとに発火（デスクトップ通知に配線）。
- `onPersist()`: 永続対象が変わった合図（合成ルートで debounce 保存に配線）。`persistableState()` が state.json 用スナップショットを組み立てる。
- **モデル切替（`/model`）**: `SessionOptions` を可変フィールドとして保持し、`getModel()` / `setModel(model)` で公開。`setModel` は**以降の新規セッション**に適用（実行中セッションは起動時のモデルを維持）し、`onModelChange(model)` で合成ルートに通知 → `~/.codiva/config.json` の `model` にマージ保存される。選択肢は **Claude Code のカタログ**（`Query.supportedModels()`）を唯一の出所にし、取得は `utils/model-catalog.ts`（`fetchModelCatalog`）・変換と突き合わせは `core/models.ts`（`toModelOptions` / `isCurrentModel`）が担う（詳細は [TECH_NOTES.md](./TECH_NOTES.md) の supportedModels 節）。コマンド解析は `core/commands.ts`（`parseSlashCommand`）。
- **リポジトリ追加指示の編集（`/prompt`）**: モデル切替と同じ形。`getRepoPrompt()` / `setRepoPrompt(text)` で `SessionOptions.appendSystemPrompt` を可変管理し、`setRepoPrompt` は**以降の新規セッション**に適用（実行中セッションは起動時の指示を維持。systemPrompt は query 開始時に確定するため）、`onRepoPromptChange(text)` で合成ルートに通知 → `utils/saveRepoPrompt()` が `<repo>/.codiva/prompt.md` へ永続化（空なら削除）。UI は一覧の `/prompt` で `ui/repo-prompt-editor.tsx`（現在値をシードしたモーダル。Enter 保存 / Shift+Enter 改行 / Esc 取消。composer と同じ `input.ts` の chord モデル）を開く。起動時読込は従来どおり `loadRepoPrompt()`。
- `restore(persisted)`: 起動時に前回セッションを再構築（worktree meta を再配線し、`Session` に `resume`/`restored` を渡す。id/slug を予約して衝突回避）。
- **責務分割**: SessionManager はライフサイクルと配線のファサードで、以下を委譲する:
  - `core/session-store.ts`（`SessionStore`）… 購読可能スナップショット（順序・状態・参照同一性保持）
  - `core/session-actions.ts` … `mergeSession` / `discardSession` / `sessionDiffStat`（git 操作）
  - `core/pr-coordinator.ts`（`PrCoordinator`）… `maybeAutoPr` / `refreshPrs` / `maybeAutoRecover`（PR 自動化）
  - `core/pr-recovery.ts` … 詰まった PR の立て直し判定と指示文（純粋）
  - `core/run-mode.ts` … `RunMode` + `createModePolicy`（shift+tab のツール許可モード）
  - `core/persistence.ts` の `assemblePersistedState` … state.json スナップショットの組み立て
  - DI seam の interface（`WorktreeService` / `SessionHandle` / `PrAutomation` / `PrLookup` / `ActionResult`）は `core/session-ports.ts`（leaf）に集約し循環を防ぐ。エージェント側の seam（`AgentAdapter` / `AgentRun` / `AgentRunRequest` / `AgentCapabilities` / `PermissionDecision`）は `core/agent-ports.ts`（同じく leaf）。`SessionManager` も `agent` を DI で受け、そこを差し替えるだけで新規セッションの provider が変わる。

### WorktreeManager (`utils/worktree-manager.ts`)

- 前提チェック: Gitリポジトリか、HEAD が存在するか（コミット0のリポジトリでは worktree を作れない）。
- `add(slug)`: `git worktree add .codiva/worktrees/<slug> -b codiva/<slug>` を現在の HEAD から作成。slug 衝突時は `-2`, `-3` を付与。
- `.codiva/.gitignore`（中身は `*` の 1 行）を自動生成（無いときだけ。起動時と `add()` の両方から `ensureIgnored()`）。`*` は同じディレクトリの `.gitignore` 自身にも一致するので、この 1 ファイルだけで `.codiva/` が丸ごと git から消える（cargo の `target/.gitignore` と同じ手）。**かつては `.git/info/exclude` へ追記していたが、`.git` はディレクトリとは限らない** — linked worktree / submodule では `gitdir:` を書いたただのファイルなので、そこで codiva を起動すると追記が ENOTDIR で失敗し、握り潰していなかったため worktree 作成ごと失敗していた。作業ツリー側のファイルなら git の内部配置に依存しない。既存の `.codiva/.gitignore` は上書きしない（利用者が例外を足しているかもしれない）。副作用として `git ls-files --others --ignored --directory` が `.codiva/` を 1 件に畳まなくなる（除外の出所がそのディレクトリの中にあるため git が中へ降りる）ので、引き継ぎ対象のフィルタは**先頭セグメント**で `.codiva` / `.git` を落とす（完全一致だと `.codiva/worktrees/` が引き継がれ、新 worktree の中に worktree 群自身へのリンクが張られて以後の `worktree remove` が ELOOP で失敗した）。
- ignore 済みファイルの引き継ぎ: `ignoredFiles`（`'symlink'` | `'copy'` | `'none'`、既定 `'symlink'`）が `'none'` 以外なら、`git ls-files --others --ignored --exclude-standard --directory` で列挙した `.gitignore` 対象（`node_modules/`・`.env` など）をリポジトリルートから worktree へ引き継ぐ。git worktree は追跡対象しか引き継がないため、これで依存の再インストールや環境変数の再設定なしにセッションが即実行できる。`'symlink'` は `fs.symlink` で元へのリンクを張るだけ（複製コストゼロ・実体共有）、`'copy'` は `fs.cp` で実体を複製（worktree 完全独立・大きいと重い）。既定を `'symlink'` にしているのは、`node_modules/` 等の複製コストを避けて起動を速くするため。列挙結果のフィルタは純関数 `ignoredCopyEntries()` に切り出し（`.codiva/`・`.git` は再帰・内部状態破壊を避けるため、**配下も含めて先頭セグメントで**必ず除外）、実体化はエントリ単位のベストエフォート（1件の失敗で worktree 作成を止めない）。設定値からモードへの解決は純関数 `resolveIgnoredFilesMode()`（非推奨 `copyIgnored` の後方互換: `true`→`'copy'` / `false`→`'none'`）。
- **ビルド生成物・キャッシュはモードに関係なく引き継がない**（`DEFAULT_IGNORED_EXCLUDES`）。`.gitignore` は依存（引き継ぎたい）と生成物（引き継ぎたくない）を区別しないため、`.next` / `dist` / `target` / `coverage` / `*.tsbuildinfo` 等の**既知の名前を列挙**して除外する。理由は (1) 生成物なのでセッション側で作り直せる、(2) 共有すると元リポジトリと各 worktree の開発サーバ／ビルドが同じ実体へ同時に書き込む、(3) worktree がリポジトリ配下（`.codiva/worktrees/<slug>`）にあるため、**ルートで再帰監視している開発サーバ（Next.js / Turbopack）からは自分が書き込んでいるディレクトリが worktree の数だけ別経路として見え**、変更通知が多重に跳ね返って OS ごとフリーズする（issue #81 の実測: worktree 6 個 + `next dev --turbopack`）。判定は純関数 `isExcludedIgnoredEntry()`（`/` 無しのパターンは**最終セグメント**に一致 = ネストした `apps/web/.next/` にも効く / `*` 前置は接尾一致 / **最後に一致したパターンが勝つ**）。名前の列挙は必ず外れるので、設定 `ignoredFilesExclude` で追加（`.venv`）と打ち消し（`!dist`）ができる（`ignoredExcludePatterns()` が既定の後ろに連結）。**リポジトリの `.gitignore` は書き換えない**方針は維持し、監視除外は利用者の設定に委ねる（README の該当節）。
- **既存 worktree の後片付け**: 除外リストを増やしても、以前のバージョンが張ったリンクは残る（= フリーズ要因も残る）ので、起動時に `pruneExcludedLinks()`（`index.tsx` の preflight 直後・best-effort）で「いまの設定なら引き継がないエントリ」のリンクだけを外す。対象の列挙は純関数 `excludedIgnoredEntries()`（`ignoredCopyEntries()` の裏返し）で、worktree の中を走査しないのでコストは一定。**シンボリックリンクしか消さない**のが安全弁で、実体のディレクトリ（セッション自身のビルド結果でありうる）とリンク先（元リポジトリ）には触らない。
- `diffStat(session)`: `git -C <worktree> diff <base>...HEAD --stat` 相当。未コミット変更がある場合はその旨も返す。
- `merge(session)`: セッションブランチをベースブランチへマージ（squash はしない。コンフリクト時はエラーを返し、手動解決を促すメッセージを表示するのみ）。
- `remove(session, { force })`: `git worktree remove` + `git branch -D`。

### UI (ui/)

Claude Code の実画面に寄せる: 画面は**端末の縦幅いっぱい**（web の 100dvh 相当。`App` が root Box に `useWindowSize()` の rows を指定。極端に低い端末では `isFullscreenViewport` が false になりインライン描画へフォールバック）に描画し、全画面時は起動時に **alt screen**（`utils/alt-screen.ts`）へ入ってスクロールバックを無効化（上へのスクロールをロック）し、下部に**上下の全幅横罫線だけ**の入力欄（`PromptInput`、角丸枠ではない）、その下にモード行（`StatusFooter` = `⏵⏵ auto mode on (shift+tab to cycle)` + 文脈ヒント）を flexGrow スペーサで**最下部に固定**。ヘッダは枠なしのワードマーク。色とグリフは `theme.ts` に集約。

- `App`: 全画面レイアウトの root と Ctrl+C の安全網。**list ⇔ detail のビュー切替**を `View` state で持ち、
  一覧で Enter/→ すると `onOpen(id)` で詳細へ、詳細で Esc すると `onBack` で一覧へ戻る。
- `Banner`: 起動時ヘッダ（マスコット + ワードマーク / プラン + モデル + ブランチ / cwd + 使用状況ゲージ）。枠なしで
  一覧上部に表示。**純粋に presentational** で、表示行は core の `bannerLines()`（`core/banner-lines.ts`）が
  組む（`BannerLine[]` = 1 要素 1 表示行。色は `BannerTone` という抽象で受け取り、実際の色は `theme.ts`）。
  可読性のため**プラン・モデル・現在ブランチは 1 行にまとめ**（`Plan: Claude Max   Model: sonnet   Branch: main`）、
  サブタイトルは出さない。ブランチを cwd 行ではなくここに置くのは、(1) cwd は長くなりがちで行末が
  `truncate-end` で切れる（狭い端末で真っ先に消える）、(2) cwd 行はパスを取り出すドラッグ用途なので、
  行末へ丸める drag（`bannerCaretAt` の `'clamp'`）でブランチ名まで一緒にコピーされる、の 2 点。
  値は `app.tsx` の `useBranch`（合成ルートが注入する `WorktreeManager.currentBranch()` を 5 秒ごとに
  読み直す）が供給する。codiva の外（別ターミナルの `git switch`）でも変わるので購読できる相手が
  おらず、定期的に読み直すしかない。**state を `App` に置くのはビュー切替で失わないため**（一覧に
  置くと詳細から戻った 1 フレームだけ消え、戻るたびに取り直しになる）で、**取得は一覧のときだけ**
  （`view.mode === 'list' ? loadBranch : undefined`）。ヘッダを描いていない詳細ビューの間、誰も読まない
  値のために git のプロセスを立てない。一覧へ戻ると即座に 1 回読み直す。detached HEAD（`symbolic-ref` が失敗）と git の失敗は undefined =
  **表示しない**（`rev-parse --abbrev-ref` の `'HEAD'` を出すと「HEAD というブランチ」に見えるため、
  `baseBranch()` とは別メソッドにしてある）。
  ヘッダのテキストはドラッグで範囲選択してコピーできる（cwd の絶対パスを取り出す用途）。当たり判定は
  「行 index = 表示行」を前提に `bannerCaretAt()` で逆算するため、**行は `wrap="truncate-end"` で 1 行 1 行に
  固定し、選択可能なテキスト塊（`textRef` の Box）の中に margin を入れない**（折返し・margin が入ると以降の
  行が全てズレる）。位置の実測 ref は中央寄せの外側ではなく**行だけを包む内側 Box** に付ける。
  使用状況（`UsageSection`）と学習データ利用の警告（`PrivacySection`）は**その塊の外**に描くので、
  節の間隔は `marginTop` で空けてよい（行構成を揺らさない）。使用状況の行データは純粋な
  `bannerUsageRows()`（見出しを表示幅で揃え、使用率を右詰めにした `BannerUsageRow[]`）が組み、
  ゲージのセル数は `gaugeCells()`、記号（█ / ░）は `theme.ts` の `glyph` から取る（core に記号を置かない）。
  ゲージ幅は端末幅で段階的に縮退させる（`bannerGaugeWidth(columns)` = 20 / 12 / 8 / 0 セル）。
  低い端末ではヘッダも縮んで下段 UI に場所を譲る（`flexShrink` を止めない）ため、潰れて一覧の行に
  重なった場合は**一覧のクリックを優先**する（`SessionList` 側で `y >= rowsBox.top` を除外）。
  縦に潰れると中央寄せの負オフセットで**上端の行から**落ちるので、`SessionList` は実測高さ
  （`useBoxHeight`）が行数より小さい間はヘッダの当たり判定をやめる。一方**マスコットの Box だけは
  `flexShrink={0}`**（横方向の縮小でアスキーアートが折り返して崩れるのを防ぐ。縦の譲り合いには効かない）。
- `SessionList`: 一覧画面。`Banner` + 一覧 + 下部 `PromptInput`/`StatusFooter`。フォーカスは
  `composer`（起動時既定。タイピング + 矢印キャレット移動）/ `dialog`（選択セッションの
  `PermissionDialog` がキーを持つ）/ `list`（↑↓選択・Enter/→ = 詳細を開く・m/d/x = マージ/破棄/削除）の
  3ゾーン（`ListFocus`）で、Tab は composer → dialog（選択行が許可/質問待ちのときだけ）→ list → composer と
  回す。ダイアログは composer 以外のゾーンで常に見えているが、キーを取るのは `dialog` ゾーンだけ。
  **分けているのは ↑↓ の行き先を一意にするため** — 以前は list フォーカスに
  相乗りさせていたので、質問が出ている行を選んでいる間はセッションを切り替えられなかった。
  そのうえで**選んだ行が許可/質問待ちなら `dialog` を既定ゾーンにする**（`zoneForRow`。↑↓ の移動・
  ホイール・行のクリック・空 Enter すべて共通）。回答は待たせている用事なので Tab を余分に踏ませず、
  一覧へ戻る出口は Tab に一本化してある。マウスクリック（`core/mouse.ts` + `useAbsolutePosition`）で
  行選択・キャレット移動。**ダイアログの中のクリックも受ける**（`PermissionDialog` の `onActivate` で
  ゾーンを `dialog` へ寄せ、選択肢の上ならカーソルもそこへ置く）ので、一覧のクリックは
  ダイアログが出ている間も飲まない（飲むと「アクティブなダイアログから別セッションへマウスで移れない」）。
  コンポーザ上のドラッグで範囲選択し、離すとクリップボードへコピー（OSC 52 = `utils/clipboard.ts`。
  純粋ロジックは `core/text-selection.ts`、状態は共有フック `useDragSelection`）。詳細ビューの
  フォローアップ入力欄・ログも同様（ログは行単位の `useLogDragSelection`）。**ヘッダ（`Banner`）も同じ仕組みで選択・コピーできる**（`useDragSelection` を
  コンポーザとは別インスタンスで持つ = caret index の基準テキストが違うため）。ヘッダのドラッグは
  フォーカスも選択行も動かさない（パスをコピーしたいだけの操作でタイピング位置を奪わない）。
- `SessionDetail`: 詳細画面。**ステータスヘッダは持たず**、コンテンツ（末尾ビューポートのログ）+ フッタ
  （追加指示コンポーザ）だけの構成。SDK セッションに**直結**し、末尾ビューポートにログを描画（`core/scroll.ts` の
  `logLines` でエントリを CJK 幅対応で折り返した**物理行**（`DisplayLine[]`）へ展開してから
  （展開は**エントリ単位でメモ化**する。下記「ログのメモリ上限」参照）、
  `logWindow`/`scrollUp`/`scrollDown` で PgUp/PgDn（半画面）・↑/↓（1行 = `ARROW_SCROLL_LINES`）・
  ホイール（`WHEEL_SCROLL_LINES`）スクロール。マウスレポートは `parseSgrMouse` で useInput の先頭で
  先取り解釈し、コンポーザへ文字入力として漏れないようにする（マウス無効環境では端末がホイールを
  ↑/↓ に変換して送るので、↑/↓ がその受け口も兼ねる = alternate scroll mode）。
  **ログはドラッグで範囲選択してコピーできる**（`core/log-selection.ts` + `useLogDragSelection`）。
  選択の位置は平坦な caret index ではなく「**文書の表示行 index + 行内の桁**」（`LogPoint`）で持つ:
  行 index はスクロールしても意味が変わらないので、**可視域の外へドラッグすると自動スクロール
  しながら選択が伸び続ける**（`logEdgeAt` → 1 tick = 1 行の `edgeStep`。?1002 は静止中に移動を
  報告しないので `LOG_EDGE_SCROLL_MS` のタイマーで継続）。当たり判定（`LogViewport`）は描画に
  使った実測値と同じウィンドウから組み、末尾寄せの隙間を勘案する。
  1 行ぶんの描画（kind ごとの prefix / dim / Markdown スパン / 選択ハイライト）は
  `ui/log-line.tsx` の `LogLine` に分けてある（`SessionDetail` は行の並べ方と入力に専念）。
  描く行数は**実測した可視高さ**（`useBoxHeight`）に収める — Ink/Yoga は溢れた子を縮小するため、
  多く描くと行が虫食いで欠落する。
  **ログのすぐ下は常に 1 行の状態行**（`core/scroll.ts` の `logStatusRow` → `LogStatusRow`）で、
  `streamingText` のタイピング風プレビュー / 「過去ログを表示中」の案内 / 空行のいずれかを描く。
  出し入れしないのが要点で、以前はプレビューがログの可視域を共有し（描くときだけ 1 行引く）
  案内はログ枠の外に条件付きで現れていたため、**末尾から `↑` を 1 回押しても上端が動かず**
  （案内行のぶんビューポートが 1 行縮み、末尾の 1 行が消えるだけ）、ターンの開始／終了ごとに
  ログ全体が 1 行上下に揺れていた（= 「上へスクロールするとガクガクする」）。ターンごとに
  出入りする操作ヒント行（`Ctrl+C` / 再開 / 認証）も同じ理由で常に 1 行にしてある。
  下部には追加指示コンポーザ（`manager.send(id, text)`）を持つ。Tab で入力↔操作パネルを切替し、
  操作パネルで m/d/x = マージ/破棄/削除（`x` は行ごと消すので成功時は一覧へ戻る）。
  `pendingPermission` があれば `PermissionDialog` に委譲。単一 `useInput` の
  state machine（panel = input | actions）でタイピングとキー操作の衝突を防ぐ。
- `PromptInput` / `StatusFooter`: presentational。キー処理は view の単一 `useInput` に集約（ロジックは持たない）。`PromptInput` は複数行対応（純粋モデルは `core/text-buffer.ts`、キー対応は `ui/input.ts` の `editText`/`resolveEnter`）。幅を超えたテキストは**折り返す**（truncate しない）: 折り返し後の表示行・キャレット位置・クリック逆算・選択範囲はすべて純粋な `core/composer-layout.ts`（`composerLayout`）が算出し、折り返し幅は Box の実測値（`useComposerWidth`）を描画・当たり判定・↑↓ 移動で共有する。IME 対応で実端末カーソルをキャレットに重ねる（`useCursor`）。
- **`useComposer` / `Composer`（`ui/composer.tsx`）— 入力欄は 1 実装**: 入力欄は 4 か所（一覧の新規指示・
  詳細の追加指示・`/prompt` のエディタ・質問ダイアログの「自分で入力する」）にあるが、バッファ
  （`useTextBufferRef`）・折り返し幅と位置の実測・ドラッグ範囲選択（`useDragSelection`）・クリックの
  当たり判定（`caretIndexAtClick`）・キー対応（`editText` / `resolveEnter`）の**組み立てはここ 1 か所**に
  畳んである。以前は各 view が同じ部品を個別に組んでいたため仕様が食い違い、質問ダイアログの自由記述
  だけ `resolveEnter` を通しておらず「そこだけ Shift+Enter で改行できない・↑↓ が効かない・ドラッグで
  コピーできない」状態になっていた。`useComposer` は `useInput` を持たず（**1画面 1 `useInput`** は維持）、
  view の単一ハンドラから `handleMouse(mouse) → boolean`（扱ったか）と
  `handleKey(input, key) → submit | handled | ignored` を呼ぶ形にしてある。view 固有の分岐（一覧の入力
  履歴、詳細のログスクロール、一覧フォーカス時の印字キー）は `handleKey` の**手前**で view が処理する。
  `<Composer>` の計測 Box は `PromptInput` **だけ**を包む（コマンドパレットを同じ Box に入れると実測した
  上端がずれてクリックが別の文字に当たる）。
- 再描画スロットリング: SessionManager の通知を UI 側で ~100ms にスロットルする。

**ランモード（shift+tab トグル）**: `SessionManager.mode`（`auto` | `confirm`）を全セッション共通で保持し、`shift+tab` で `cycleMode()`。`modePolicy` は tool 実行時に `mode` を読むので、切替は稼働中セッションにも即反映される。`auto` = AskUserQuestion 以外を自動承認、`confirm` = 毎回 allow/deny を求める（→ `awaiting_permission`／一覧に「許可待ち」）。UI は `useRunMode()` で購読し、`StatusFooter` が `⏵⏵ auto mode on` / `⏸ confirm mode on` を表示。

## 多言語対応（i18n）

UI 文字列は日本語/英語を設定で切り替えられる。規約は [.claude/rules/i18n.md](../.claude/rules/i18n.md)。

- **カタログ**: 全 UI 文字列は `core/i18n.ts` の `messages`（`Record<Lang, Messages>`）に集約する（純粋）。
  UI にリテラルを直書きせず、`useMessages()`（`ui/i18n-context.tsx` の React コンテキスト）で引く。
  純関数（`badgeFor` 等）は `Messages` を引数で受ける。動的差し込み・複数形は型安全な文字列テンプレート関数で持つ。
  （`banner` / `footer` グループもここに含む。）
- **設定**: 表示言語は `~/.codiva/config.json`（`{ "language": "ja" | "en" | "auto" }`）に永続化する
  （Claude Code の `~/.claude/` と同じユーザーグローバルの流儀）。検証変換は `core/config.ts` の
  `toConfig()`、ファイル I/O は `utils/config.ts`（`loadConfig` / `saveConfig`）。
- **言語解決**（`core/i18n.ts` の `resolveLang`、優先順）: `CODIVA_LANG` 環境変数 → 設定ファイルの
  `language`（`auto` 以外）→ OS ロケール（`LC_ALL`/`LC_MESSAGES`/`LANG` が `ja*` なら日本語、他は英語）。
  配線は合成ルート `index.tsx` で行い、解決済みカタログを `App` の `messages` prop に注入する。
- **番人**: `Messages` 型がキー欠落を型で捕え、`i18n.spec.ts` が ja/en のキー集合一致を実行時にも検証する。

## Phase 6 機能（設定 / コスト / 通知 / 復元）

純粋ロジックは core、副作用は utils／合成ルートという分離をそのまま踏襲する。

- **設定ファイル拡張**: `~/.codiva/config.json` に `model` / `effort` / `permissionMode` / `maxBudgetUsd` /
  `notifications` / `updateCheck` / `mouse` / `followOrigin` / `autoPr` / `autoSync` / `autoFixCi` を追加。検証変換は `core/config.ts` の `toConfig()` に
  集約し、不正値は静かに既定へ落とす。合成ルート（`index.tsx`）が `SessionOptions` に束ねて `SessionManager`
  へ注入する。`followOrigin` / `autoPr` は真偽値（既定 on。`false` 明示で無効）。
- **コスト表示**: reducer は `result.total_cost_usd` を `state.totalCostUsd` として既に保持。UI 用の導出だけ
  `core/cost.ts`（`totalCostUsd()` 合計 / `formatUsd()` 整形）に純粋関数で追加。一覧はバナーに合計、詳細は各行。
- **デスクトップ通知**: 発火判定は純粋な `core/notify.ts` の `notificationFor(prev,next,messages)`
  （**状態遷移時のみ**返す＝連続更新で鳴り続けない）。実 I/O は `utils/notify.ts` で 2 経路あり、
  **端末に出させる方を優先**する: (1) OSC 通知（`buildNotifySequence`。OSC 777 / 9 / 99 を
  `detectNotifyProtocol` で使い分け）→ 通知が**端末アプリ名義**になるのでクリックでその端末が
  前面に来る、(2) 非対応端末・非 TTY 向けのフォールバックとして OS コマンド（darwin=`osascript`,
  linux=`notify-send`。文字列は **argv 渡し**で注入防止）。macOS で (1) を優先するのは
  `osascript` の通知が **Script Editor 名義**になり、クリックするとスクリプトエディタが開いて
  しまうため（詳細は [TECH_NOTES.md](./TECH_NOTES.md)「デスクトップ通知の実装メモ」）。
  どちらも missing binary 等は握り潰す best-effort。`SessionManager.onTransition` に配線し、
  `config.notifications:false` で合成ルートが無効化。
- **セッション復元**: 永続スナップショットの型・変換・検証は純粋な `core/persistence.ts`
  （`toPersistedSession` / `restoredSessionState` / `fromPersistedJson`）。ファイル I/O は
  `utils/state-store.ts`（`<repo>/.codiva/state.json`。破損時は空へフォールバック、起動時に存在しない
  worktree を prune）。永続対象は `completed`/`interrupted`/`failed` かつ **`sdkSessionId` を持つ**もののみ
  （実行中/入力待ちは `interrupted`＝resumable だが「未完了」と分かる状態に丸める。`archived`/`creating`、
  および init 前に落ちて resume 不能なものは除外）。
  メッセージログは codiva 側では永続しない。ただし **resume はモデル側コンテキストを復元するだけで
  過去メッセージをストリームに再送出しない**ため、UI の会話ログは CLI 自身のトランスクリプト
  （`~/.claude/projects/<munged cwd>/<sessionId>.jsonl`）から復元時に再構築する — 純粋変換は
  `core/transcript.ts`（`transcriptLogEntries` / `transcriptProjectDir`）、ファイル読み込みは
  `utils/transcript.ts`、配線は合成ルート（履歴 Map を `manager.restore(persisted, histories)` へ渡す）。
  復元セッションは遅延 resume（最初の追加指示まで query を立てない）。復元時は `finishedAt` を
  `startedAt` にフォールバックし、経過時間が復元後に伸び続けないようにする。
  **動作時間は wall-clock ではなく「実際に動いた時間」で計る**: `SessionState.activeMs`（累積）と
  `activeSince`（現稼働セグメントの開始時刻）を持ち、`running`/`creating`（＝ `STATUS_META.active`）
  の区間だけを積算する。ユーザー操作待ち（`awaiting_*`）や終端状態は idle として除外。
  状態遷移ごとの積算は `accrueActive`（純関数）に集約し、全状態採用の単一経路 `Session.commit`
  から呼ぶ（reducer/SDK 由来の遷移を個別に触らずに済む）。表示は `activeElapsedMs(state, now)`
  ＝累積＋（稼働中なら開いているセグメント）を `formatDuration` で整形。永続時は
  `activeElapsedMs` で稼働中セグメントを畳み込んで凍結し、復元時は `activeSince` を未設定
  （idle）にしてオフライン時間を数えない。
  保存は `onPersist` → debounce（合成ルート）＋終了時の最終フラッシュ＋ SIGTERM/SIGHUP 時の
  同期フラッシュ（`saveStateSync`）。`stop()` は保留中の許可要求を deny で解決してから停止し、
  resume 先のトランスクリプトが未応答の `tool_use` で終わらないようにする（best-effort）。

## Phase 10 機能（origin 追従 / PR 自動化 / 競合検知）

同じく「純粋ロジック=core、副作用=utils／合成ルート」を踏襲。破壊的な確定操作（競合の解消・
マージの確定）は自動化せず、検知・足場作りだけを自動化する方針。

- **origin 自動追従（`followOrigin`, 既定 on）**: `WorktreeManager.syncedStartPoint(base)` が
  `git fetch origin <base>` して `origin/<base>` を start point として返す（origin 無し/オフライン/
  ブランチ不在なら `undefined` → ローカル HEAD にフォールバック）。`SessionManager.provision` が
  `worktrees.add(slug, startPoint)` に渡し、**作成時のみ**最新から切る（稼働中 worktree へは pull しない
  ＝未コミット変更との競合を避ける）。
- **PR 自動化（`autoPr`, 既定 on）**: セッションが `completed` へ遷移し、かつ base より先に
  **コミット済み差分がある**ときだけ、`worktrees.pushBranch` で push → `PrAutomation.createPr`（`gh pr create
  --draft --fill`）で **draft PR** を作成（1 セッション 1 回。`autoPrAttempted` で多重発火を防ぐ）。以降
  `refreshPrs` の 20 秒ポーリングで、draft PR のチェックが緑（`PrInfo.checks` = `passing`）になったら
  `markReady`（`gh pr ready`）で ready 化する。`gh` 依存はすべて `utils/pr.ts` に隔離し、`PrAutomation` として
  DI（失敗は best-effort でセッションに波及させない）。
- **PR ステータスの「分からない」を潰さない**（GitHub ステータスが時々消える不具合の修正）:
  `lookupPr` は `found` / `absent` / `unavailable`（+ 理由）の 3 値を返し、`PrCoordinator` は
  `unavailable` のとき**直前の PR を保持したまま** `prLookup: 'error'` を立てる。空セルは
  「PR が無い」だけを意味し、確認中は `⋯`、確認できなかったときは `?` を出す。
  `rate_limit` / `auth` / `cli` は 5 分（`PR_LOOKUP_BACKOFF_MS`）ポーリングを止める。
  チェック状態は PR 情報と同じ `gh pr view` 1 回で取得する（`--json mergeable` は GraphQL
  クォータ消費なので、毎ポーリング 2 回投げていたのを 1 回に）。
- **1 セッション 1 PR とは限らない（`core/pr-detect.ts`）**: セッションが自分で別ブランチを切って
  `gh pr create` することがある。ブランチ名（`codiva/<slug>`）からは辿れないので、**`gh pr create` を
  実行した tool_use の結果**に出る URL から拾って `extraPrs` に積む（`claude-parse` が
  `tool_use.prCreate` を立て、`applyAgentEvent` が tool_use id を控えて tool_result と突き合わせる。
  突き合わせは provider 共通側にあるので、他のエージェントは「PR 作成コマンドだった」ことを
  報告するだけでよい）。ログ全体から URL を拾わないのは誤検出を避けるため —
  `gh pr list` の出力や `gh pr view` で覗いた他人の PR まで数えてしまう。
  表示は一覧が `#12 +2`（代表 + 件数。列幅は複数 PR の行があるときだけ広げる）、全件は詳細ビューの
  1 行に出す。**代表はセッションブランチの PR**（`prStatus` = グリフを持つ唯一の PR で、クリックで
  開く先でもある）。自分で作った PR は codiva が追跡・操作しないので番号のみ（状態を知らないのに
  グリフを付けて嘘をつかない）。`gh` の追加呼び出しはゼロ。
- **PR は「識別（`pr: PrRef`）」と「状態（`prStatus: PrStatus`）」に分ける**。番号・URL は
  ブランチに対して不変なので `state.json` に載せ、**復元直後からグリフ無しの `#<n>` を表示**する。
  状態（マージ可否・チェック・draft）は永続せず、復元後の最初のポーリング（`prPollIntervalMs`
  が 0 を返す）で埋める — 前回終了時の古いグリフを見せるより、まず番号だけ出す方が正しい。
  reducer は半分ずつ比較して参照を維持するので、チェックの進行で `state.json` が再保存されない。
- **ポーリングは「セッション数 × 20 秒」をやめる**（`core/pr-refresh.ts` / `PrCoordinator`）:
  20 秒 tick はスケジューラで、実際に `gh` を叩くのは陳腐化したセッションだけ（チェック実行中
  20 秒 / 未計算 60 秒 / 落ち着いた PR 180 秒 / `merged`・`archived` は永久に不要）。さらに同一
  サイクルで 3 件以上あるときは `gh pr list` 1 回（`lookupPrs`）に畳んで突き合わせるので、
  セッションを増やしても API コストがほぼ増えない。
- **競合検知（自動解消しない）**: `WorktreeManager.merge` は競合時に競合ファイルを収集して
  `merge --abort` した上で `MergeConflictError` を投げる（base ツリーは汚さない）。`SessionManager.merge` は
  これを捕えて `session.markConflict(files)` → reducer が `status: 'conflict'` + `conflictFiles` を立てる。
  **自動解消はしない**（`-X ours/theirs` 等でコードを無言に捨てない）。UI はバッジ表示のみで、解消は人手。
  `conflict` は詳細ビューでも終端状態扱い（差分・操作を表示）で、破棄や再マージは一覧/詳細から可能。

## 詰まった PR の立て直し（コンフリクト取り込み / CI 修正）

Phase 10 で作った検知（`prStatus.mergeStatus === 'conflicting'` / `checks === 'failing'`）は
グリフを描くだけで終わっていた。それを**行動に繋げる**のがこの層。方針は Phase 10 と同じで、
**codiva 自身が決定的にできることは codiva がやり（無課金）、判断が要るところだけセッションへ渡す**。

- **判定は純粋（`core/pr-recovery.ts`）**。2 段に分かれているのが要点:
  - `prStuckKind(state)` … **PR だけ**を見た詰まり方（`sync` = 競合 / `ci` = 赤いチェック）。
    競合を CI より優先する（ベースを取り込めばチェックは回り直すので、先に CI を直しても無駄）。
  - `recoveryKindFor(state)` … 上に「**セッションが手を止めている**」（`isTerminalStatus` かつ
    `archived` でない）を掛けたもの。走行中に指示を割り込ませても、そのターンの作業と競合するだけ。

  - `stuckKinds(state)` … 該当する詰まり方を**全部**（競合と CI 失敗は同時に起きる）。
  - `prRecovered(state)` … PR が**確かに健全になった**か（緑 or マージ済み）。

  **分けたのは自動化の試行回数を正しく数えるため**。素朴に「詰まっていないならリセット」と
  すると 2 段階で壊れる:
  1. 「今は走っているから対象外」と「もう詰まっていない」を同じ関数で表すと、指示を送った
     直後（= 走行中）にリセットされる → 完了 → まだ赤い → また送る、の無限ループ。
  2. それを直しても、**push 直後の PR は必ず `checks: 'pending'` / `mergeStatus: 'unknown'` を
     経由する**（= 詰まってはいない）ので、そこでリセットされる → 赤い → 依頼 → pending →
     赤い、で上限が無意味になる。実際に多いのは「依頼したが直せなかった」ほうなので、これを
     塞がないと意味が無い。

  なので**返金は `prRecovered`（緑を見た）ときだけ**。試すかどうかは `recoveryKindFor`、
  どの種類を試すかは `stuckKinds` を**有効なフラグと突き合わせて先頭から**選ぶ（`autoFixCi`
  だけ有効な人の「競合していて、かつ赤い」PR で、優先度 1 位の `sync` が無効だからと
  諦めてしまわないように）。
- **取り込みは `WorktreeManager.syncBase(wt, base)`**（`utils`）。`merge()` と向きも cwd も逆で、
  **worktree の中**で `origin/<base>`（fetch 失敗時はローカル `<base>`）を取り込む。返り値は
  `SyncBaseResult` の 4 値で、投げない:
  | 結果 | 意味 | 次の手 |
  |---|---|---|
  | `upToDate` | 既にベースを含む | 何もしない |
  | `updated` | クリーンにマージできた | `pushBranch` して終わり（**セッションを起こさない**） |
  | `dirty` | 未コミット変更があるので**マージしていない** | 作業の持ち主（セッション）にまとめて任せる |
  | `conflict` | 競合した | **`merge --abort` せず競合を残す** → セッションに解決させる |

  `merge()` が abort するのは共有されるベースツリーを汚さないためで、`syncBase` の worktree は
  1 セッション専用だから残すほうが直せる。どちらも `-X ours` 相当の**自動解消はしない**（規約）。
  細かいが効く判断が 3 つ:
  - **未追跡ファイルは `dirty` にしない**（`--untracked-files=no`）。`git merge` は未追跡ファイルが
    あっても普通に通るので、エージェントの走り書き 1 個で無課金の経路を捨ててターンを使うのは損。
  - **既に merge 途中（`MERGE_HEAD` あり）なら `conflict` を返す**。dirty 判定に落とすと
    「コミットか stash してから取り込め」という**実行不能な**指示を送ってしまう。
  - **detached HEAD は拒否する**。マージコミットは HEAD に載るがブランチ ref は動かないので、
    push は no-op、PR は詰まったまま、なのに「取り込んで push しました」と報告してしまう。
- **CI 修正は追加の API を使わない**。`gh pr view --json …statusCheckRollup` の payload から
  落ちたチェック名と `detailsUrl` を拾う（`utils/pr.ts` の `toFailingChecks` → `PrStatus.failingChecks`。
  `MAX_FAILING_CHECKS` 件で打ち切り）。ログの取得（`gh run view --log-failed`）と修正はセッションが行う。
  `failingChecks` は `checks === 'failing'` のときだけ載せ、reducer は**内容比較**する
  （毎ポーリング新しい配列になるので参照比較だと必ず「変わった」ことになり、`prStatus` の
  参照維持が壊れる）。
- **実行は `SessionManager.recover(id, kind?)`**（git と `send` の両方を触れる唯一の層）。`kind`
  省略時は `recoveryKindFor` が決め、明示すると `/sync` / `/fix-ci` としてポーリング前でも効く。
  セッションへ送る指示文は i18n カタログ（`m.recover.*`）から引く — ログにユーザー発話として
  残るので `resume.instruction` と同じ扱い（`messages` 未注入なら `recover` は no-op）。
- **自動化は `PrCoordinator` が「いつ」だけを決める**。`autoSync` / `autoFixCi`（**既定 off**。
  依頼が発生した時点でターンが回る = 課金）で有効化し、実行は DI された `recover` を呼ぶ。
  1 セッション・1 種類あたり `MAX_AUTO_RECOVERY_ATTEMPTS`（2）回で打ち切る — トリガーが
  イベントではなく**状態**なので、「依頼したのに push されない」と毎ポーリング投げ続けてしまう。
- **UI は共有フック `useRecovery`**（`ui/hooks.ts`）。一覧は `/sync`・`/fix-ci`（選択行）と
  `Ctrl+F` = `/recover`（全件、`y`/`n` 確認）、詳細は `/sync`・`/fix-ci`（そのセッション）。
  `Ctrl+F` をフォーカス横断の chord にするのは `Ctrl+R` / `Ctrl+A` と同じ理由。一括は
  **逐次実行**する（同一リポジトリの worktree 群なので git の index/ref ロックで潰し合う）。
  - **`recovery.busy` を「全キーを飲む」`busy` に混ぜない**。一括は N 件ぶんの git を直列に
    回すので数分に及びうる。全キーを飲むと Ctrl+C を拾わない（`exitOnCtrlC: false`）この TUI
    では `/exit` すら打てず操作不能になる（`/update` の installing で踏んだ罠と同じ）。
    塞ぐのは「もう一度立て直しを始める」入口だけにして、実行中は独立した行で知らせる。
  - **一括の結果は実際に成功した件数で報告する**。全部失敗（`gh` 未認証など）したのに
    「N 件を実行しました」と緑で出さない — 最初のエラーはエラー欄へ回す。
- **worktree に触るのはセッションが手を止めているときだけ**。この門は `recoveryKindFor` では
  なく `SessionManager.recover` 側にある — 明示 `kind` を渡す `/sync` / `/fix-ci` にも効かせる
  必要があるから（Claude が編集中の worktree で `git merge` を回すと書き込みと競合する）。
  弾いたときは `{ kind: 'busy' }` を返して「作業中です」と出す。

## 学習データ利用（grove）の警告

codiva は並列セッションで大量のコードを Claude へ流すため、claude.ai の「Help improve our AI models」
（= モデル学習へのデータ提供。Anthropic 内部名 **grove**）が ON のまま気付かずに使い続けるのを防ぐ。
**警告するだけで、codiva 側の挙動は変えない**（勝手に無効化はしない = ユーザーのアカウント設定を
アプリが書き換えない）。

- **判定は 2 段構え**（`utils/privacy.ts` の `fetchTrainingOptIn`。安いほうから試す）:
  0. **認証方式の門番**: API キー / Bedrock / Vertex / 独自 `ANTHROPIC_BASE_URL` のときは claude.ai の
     設定と無関係（かつ API 利用は学習対象外）なので、**キャッシュも読まずに** `'unknown'`。
     過去に claude.ai へログインした残骸で誤警告しないため、この門番が最初に来る。
  1. `~/.claude.json` の `groveConfigCache[accountUuid]`（Claude Code が書くキャッシュ。ネットワークも
     認証情報も不要。7 日より古い値は使わない）。キーは `oauthAccount.accountUuid` と一致させ、
     **アカウントが読めないときに限り**単一エントリを流用する（切替後に前アカウントの値を使わない）。
  2. `GET https://api.anthropic.com/api/claude_code_grove`（Keychain `Claude Code-credentials`（macOS）
     または `~/.claude/.credentials.json` の OAuth トークンを使う）。
- **キャッシュの信頼は非対称**: `'off'` はそのまま採用してここで終える（安い）が、**`'on'` は必ず
  問い合わせで確認する**。claude.ai 側で OFF にしてもこのキャッシュは書き換わらないため、
  信用すると「言われた通り切ったのに警告が出続ける」ことになる。確認が取れなかったときだけ
  キャッシュの `'on'` に据え置く。
- **判定は `'on' | 'off' | 'unknown'`**（`core/privacy.ts`）。警告は **`'on'` と確定したときだけ**出す。
  レスポンスの `domain_excluded === true`（意味は未検証）も `'unknown'` に倒す。
- **起動をブロックしない / 終了を止めない**: 合成ルート（`index.tsx`）が render 前に投げ、
  `useTrainingOptIn` が解決したらバナーに注意行が増える。終了時は `AbortController` で打ち切る。
  `security`（Keychain）呼び出しには `signal` と `timeout`（2 秒）を必ず渡す — 生きた子プロセスが
  イベントループを掴むと、終了してもシェルのプロンプトが返らなくなる。abort 済みシグナルでは
  `addEventListener('abort')` が発火しないので、問い合わせ前に `signal.aborted` を先手チェックする。
- **失敗はすべて `'unknown'`**（非公開エンドポイントなので仕様変更で壊れうる。壊れたときは
  「黙る」= 誤った警告を出さない）。設定 `privacyWarning: false` で判定自体を走らせない。
- **描くのは `bannerLines` の行ではなく、その外の `PrivacySection`**。ヘッダのドラッグ選択は
  `bannerText(lines)` への caret index で、当たり判定が「行 index = 表示行」を前提にしている
  （`core/banner-lines.ts` の `bannerCaretAt`）。警告はコピー対象ではないうえ `⚠` は `theme.ts` が
  持つ記号なので、選択可能なテキスト塊（`textRef` の Box）の**外**に置いて行構成を揺らさない。

エンドポイントの実測（User-Agent 要件など）は [TECH_NOTES.md](./TECH_NOTES.md#学習データ利用grove-の検知実測-2026-07-30) を参照。
## アップデート通知 / `/update`

npm 配信された自分自身の更新を検知して知らせ、安全に確定できる経路のときだけ適用する。
「検知は自動、確定操作は人手」という PR 自動化と同じ方針。

- **純粋ロジック（`core/update.ts`）**: semver の precedence 比較（`compareVersions` /
  `isUpdateAvailable`。prerelease 規則まで実装）、結果 union（`UpdateCheck` =
  `available` / `up-to-date` / `unavailable`）への変換（`resolveUpdateCheck`）、インストール経路
  （`InstallKind` = `global` / `local` / `npx` / `unknown`）から更新コマンドを組む
  `updateCommandFor`（**argv 配列**で返す）/ `updateCommandLine`、自己更新の可否 `canSelfUpdate`。
  DI 境界 `UpdateService`（`initial` / `check()` / `install()`）とダイアログ状態 `UpdateViewState` もここ。
- **I/O（`utils/update.ts`）**: `fetchLatestVersion` が `https://registry.npmjs.org/<pkg>/latest` を
  1 回だけ引く（全 packument 21KB ではなく 2.3KB。認証不要。**3 秒でタイムアウトし throw しない**。
  タイマーは unref、外部 `AbortSignal` でも打ち切れる）。`installKindFor` は
  `packageRoot` / `execPath` / `cwd` / `platform` を**引数で受けるパス比較のみ**（`notifyCommand(spec, platform)`
  と同じ方針でテスト可能）。`runUpdate` が `execFile`（シェルなし）で `npm install` を実行し、失敗は
  stderr の最終行を `ok: false` で返す。`createUpdateService` がこれらを束ねる。
- **経路判定の安全側**: npx / dlx / bunx のキャッシュ（**パス要素の完全一致**で判定。部分一致だと
  `bunx-tools` のような無関係なディレクトリを誤検出する）は `npx`、volta / asdf 配下・Windows・
  それ以外の判別不能は `unknown`。**実行するのは `global` だけ**（`canSelfUpdate`）で、`unknown` /
  `local` / `npx` は実行すべきコマンドの提示に留める。静的判定が `unknown` のときだけ
  `npm root -g` を 1 本起こして `global` へ格上げする（homebrew の Cellar・`npm config set prefix`・
  pnpm/yarn global を拾うため。標準的な配置ではサブプロセス 0 本）。`npm install -g` の cwd は
  ホームに固定する（対象リポジトリの `.npmrc` に宛先を書き換えられないため）。
- **配線**: 合成ルート（`index.tsx`）が起動時に `createUpdateService` を作り、**await せずに**
  `initial` を投げる（`modelCatalog` と同じ扱い。終了時に `updateAbort.abort()`）。`App` は
  `useUpdateCheck(updater?.initial)` で state に解決し、`available` のときだけ
  `bannerLines` の `updateLatest` へ渡す（最新・未確認では**ヘッダに行を増やさない**）。
  ヘッダの文字組みは純粋な `core/banner-lines.ts`、色は `accent` トーン →`ui/theme.ts` の
  `theme.accent`（`.tsx` に生の色名を書かない）。`/update` は `useCommandRunner` の
  `update` ハンドラ → 毎回 `check()` し直し、`UpdateDialog` を出す。
- **キー処理**: `UpdateDialog` は presentational で `useInput` を持たない。キーは一覧ビューの
  単一ハンドラが `confirm` / `confirmResumeAll` と同じ位置で処理する（更新可能なら y/n、
  それ以外は任意キーで閉じる）。非同期の決着は**世代カウンタ**で無効化し、閉じた後・開き直した
  後に stale な結果でダイアログが蘇らないようにする。
- **モーダルの相互排他は必須**: `PermissionDialog` は**自前の `useInput`** を持ち、Ink は 1 つの入力
  チャンクを**マウント中の全ハンドラへ配る**。同時に出ていると更新確認の `y` が未読のツール実行の
  許可も兼ねてしまう（このビューがキーを飲んでも相手は独立に反応する）。`pending` の導出に
  `!update` を入れて構造的に禁じ、さらにモーダル中は**マウスレポートも飲む**
  （クリックで `focus` が list に移ると許可ダイアログが立つ経路を塞ぐ）。
- **実行中に操作不能にしない**: `installing` 中も **Esc は通す**。codiva は Ctrl+C を拾わず
  （`exitOnCtrlC: false`）終了は `/exit` だけなので、全キーを飲むと `npm install` が終わるまで
  最長 `INSTALL_TIMEOUT_MS` のあいだ何もできなくなる。Esc はダイアログを閉じるだけで npm は続行する。
- **設定**: `updateCheck`（既定 on）。`false` で起動時の通信を完全に止める（`/update` は
  `unavailable` を返すだけになる）。

## クラッシュ時の後始末（端末の復旧 / クラッシュログ）

TUI は alt screen + マウスレポート（?1002/?1006）で動くため、異常終了は 2 つの被害を同時に出す。

1. **端末が壊れたまま残る**。マウス捕捉が有効なままだとスクロールのたびに端末が
   `\x1b[<64;…M` を送り、シェルには**大量の文字が入力されたように見える**。
2. **理由が残らない**。例外のスタックは stderr へ出るが、alt screen を抜けた瞬間に画面ごと消える
   （ユーザーには「突然ターミナルに戻った」としか見えない）。

対策は 3 層。**どの層も他の層の代わりにはならない**（下に行くほど強い死に方に対応する）。

| 層 | 実装 | 効く死に方 |
|---|---|---|
| teardown（`toggleEscape` の `process.on('exit')` + `setupTerminal().teardown`） | `utils/alt-screen.ts` / `utils/mouse.ts` / `utils/terminal-mode.ts` | 正常終了・`process.exit`・捕捉できた例外 |
| クラッシュハンドラ | `bootstrap/crash-handler.ts` | `uncaughtException` / `unhandledRejection` |
| 起動時の自動修復 + `--reset-terminal` | `setupTerminal()` 冒頭の `disableMouseReports()` / `core/cli.ts` | **強制終了**（OOM の abort・SIGKILL・segfault。JS が一切走らない） |

- クラッシュハンドラの順序は **端末復元 → 状態 flush → レポート組み立て → 通常バッファへ出力 →
  ログ書き出し → `exit(1)`**。端末を先に戻すのは、以降の出力をスクロールバックに残すため。
- ログは `~/.codiva/logs/crash-<ISO時刻>-<pid>.log`（20 件でローテーション）。書き込みは
  **同期**（直後に process が消えるので非同期では間に合わない）。整形・ファイル名・
  ローテーション判定は純粋な `core/crash.ts`、I/O は `utils/crash-log.ts`。
- 診断情報にメモリ使用量とセッションのステータス内訳を含める。1 セッション = `claude`
  サブプロセス 1 本（最大 ~1GiB）なので、OOM 仮説の裏取りにはこの 2 つが要る。
- **V8 のヒープ枯渇は JS ハンドラで拾えない**（abort で即死する）。この経路だけは Node の
  診断レポート（`process.report.reportOnFatalError`）に任せ、`report.*.json` を同じ
  `~/.codiva/logs/` へ出す。`reportOnSignal` / `reportOnUncaughtException` は自前ハンドラと
  二重になるので off。
- シグナル（SIGTERM / SIGHUP）で殺された場合も `kind: signal` で記録する。「落ちた」と
  「kill された（端末を閉じた等）」を後から切り分けるため。
- 設定 `crashLog: false` でファイル出力（自前レポート + 診断レポート）を止められる。
  理由の表示と端末の復元は設定に関係なく行う。

## ログのメモリ上限（OOM 対策）

実際に `FATAL ERROR: Ineffective mark-compacts near heap limit` で落ちた。原因は
「**保持しすぎ**」と「**確保しすぎ**」の 2 つで、対策も 2 つに分かれる。

| 問題 | 対策 | 場所 |
|---|---|---|
| `SessionState.messages` が無制限に伸び、追記ごとに全体コピー（O(n²)） | 件数 `MAX_LOG_ENTRIES` **と合計文字数 `MAX_LOG_CHARS`**（先に縛られた方で古い方から落とす）+ 1 件あたり `MAX_LOG_ENTRY_CHARS`（`…` を付けて切る） | `core/log-buffer.ts` の `pushLogEntry` |
| 詳細ビューが**更新ごとにログ全体**を折り返し + Markdown 再パース | エントリ単位のメモ化（幅とプレフィックスが同じなら再利用）+ 保持行数の上限 `MAX_CACHED_ROWS`（LRU） | `core/scroll.ts` の `logLines` |
| ツール結果の巨大ペイロード（10MB の `Read` / `Bash`）を平坦化 → 全行 `split` | 読む 200 文字だけ材質化（`asStringHead`）。`tool_use` の入力（`Bash` の heredoc 等）も先に切る | `core/claude-parse.ts` |
| `streamingText` に 1 メッセージ全体を溜め、毎フレーム全体を `split` | 末尾 `MAX_STREAM_PREVIEW_CHARS` だけ保持（描くのは最後の 1 行） | `core/log-buffer.ts` の `clipStreamText` |
| 復元時に全セッションのトランスクリプト（各数 MB）を同時読み込み | 1 本ずつ読む（変換後すぐ回収される）+ **読みながら**畳む（`History`）+ `capLogEntries` | `bootstrap/restore-sessions.ts` / `core/transcript.ts` |

前提として **ログは会話の「記録」ではなく「表示」**である。正本は CLI のトランスクリプト
（`~/.claude/projects/…`、復元は `core/transcript.ts`）なので、古い行を落としても読み返す手段は残る。

**件数だけでは何も縛れない**（1 件は 1 文字でも `MAX_LOG_ENTRY_CHARS` でもよいので、件数 × 1 件上限
= 4000 万文字）。描画コストは文字数に比例し、しかも展開後の行（`DisplayLine` + スパン）は元テキストの
数倍を占めるので、**文字数の予算**と**キャッシュの行数の予算**の 2 つが実際の上限になっている。
`MAX_CACHED_ROWS` は soft budget で、**描画中のログの行は追い出さない**（自分が次に使う行を捨てて
毎フレーム再展開するのを避けるため）。したがって保持量の実効上限は
「開いているログ 1 本（`MAX_LOG_CHARS` で縛られる）+ `MAX_CACHED_ROWS`」。

不変条件:

- **追記の経路は `pushLogEntry` だけ**。`[...state.messages, entry]` を新しく書かない
  （`appendLog` と `applyAgentEvent` の追記はすべてここを通す。例外は `notice` の coalesce = **書き換え**
  = 末尾 1 件の差し替えで、件数を増やさないので上限に関係しない）。
- **`seq` は振り直さない**。描画キーが `<seq>:<行>` なので、トリムしても既存行のキーは変わらない
  （= React の再マウントが起きない）。ただし後述のとおり**行 index は変わる**。
- **`logLines` の返す行は read-only**。メモ化で複数フレームに共有されるため、
  呼び出し側で書き換えない（`selectionSlices` のように必ず新しい配列を作る）。

既知のトレードオフ: スクロール位置（`ScrollAnchor` の数値）と選択位置（`LogPoint`）は
**文書先頭からの表示行 index** なので、上限に達したログが古い行を落とすとその分だけ意味がズレる
（上へスクロールして読んでいる最中に新しい行が来ると、ビューが落ちた行数ぶん新しい方へ動く）。
起きるのは「上限に達した」かつ「スクロール中」かつ「追記が続いている」の同時成立時だけで、
落ちる（= 全部読めなくなる）よりは軽い副作用として受け入れている。ただし**選択は捨てる**
（`SessionDetail` が先頭エントリの `seq` の変化を検知してクリアする）— 触っていない行がコピーされる
のは副作用として重すぎるため。直すなら行 index ではなく `DisplayLine.key`（`<seq>:<行>`。
トリムでも追記でも不変）を基準にする必要がある。

## React の dev ビルドとヒープ枯渇（描画ごとに永久保持される）

上の「ログのメモリ上限」を入れた後も、ユーザー環境で**再び OOM で 3 回落ちた**
（`~/.codiva/logs/report.*.json` = Node の診断レポート。`old_space` が 4.2GB で
`large_object_space` は 55MB だけ = **小さいオブジェクトが大量に生存**）。前回とは別の原因で、
今回は「確保しすぎ」ではなく**純粋な保持漏れ**だった。

ヒープスナップショットの上位は `PerformanceMeasure` × 60,003（= 20,000 描画 × 3）と
`Components ⚛` / `Changed Props` / `Scheduler ⚛` といった文字列だった。正体は
**React 19.2 の Performance Tracks**（既報:
[ink#869](https://github.com/vadimdemedes/ink/issues/869) /
[facebook/react#35761](https://github.com/facebook/react/issues/35761)。
どちらも「Node の performance バッファが回収されない」ことが結論で、対策も `NODE_ENV=production`。
codiva では診断レポートから独立に同じ結論に至った）:

- `react-reconciler` は dev ビルドの**モジュール評価時**に
  `supportsUserTiming`（`console.timeStamp` と `performance.measure` があるか）を確定する。
  Node には両方あるので**必ず有効**になる。
- 以後レンダーごとに `performance.measure()` を 3 本積む。**Node の user timing は
  呼んだ側が捨てるまで保持され続ける**（ブラウザの devtools が消費する前提の API なので、
  長時間動く Node プロセスでは単純なリークになる）。
- `dist/index.js` は `bin` から `node` で直に起動され `NODE_ENV` は未設定 = **利用者は必ず
  dev ビルド**だった。

| 条件（空 Box を 8,000 回再描画） | 永久保持 | perf エントリ | 所要 |
|---|---|---|---|
| dev ビルド（従来） | **2,230 B/フレーム** | 24,003 件 | 414ms |
| `NODE_ENV=production` | 117 B/フレーム | 0 件 | **166ms** |
| dev + 定期 `clearMeasures()` | 174 B/フレーム | 1 件 | 406ms |

ストア購読は ~100ms スロットルなので描画は約 10/秒 ⇒ **約 86MB/時**。既定のヒープ上限 ~4GB に
半日〜1 日で到達する。**描画内容とは無関係**なので、ログの上限では止められなかった。

対策は 2 段:

1. **`src/index.tsx` を起動シムにする**（本筋）。`process.env.NODE_ENV ??= 'production'` を
   **`./main` の動的 import より前**に置く。ESM の static import は巻き上げられて本文より先に
   評価されるため、シムに static import を 1 本足すだけで無効化される（`tsup` の `banner` も、
   シバンの `env -S` も間に合わない。後者は `node <path>` 直叩き = mise 経由の起動で
   シバンを通らないので特に当てにならない）。`tests/entry-shim.test.ts` が番人。
2. **`bootstrap/perf-timeline.ts` が 30 秒ごとにタイムラインを掃除する**（保険）。
   `NODE_ENV=development` で起動したときや、将来 React / Node が別の形で user timing を
   積み始めたときに効く。保持量の上限が「30 秒ぶん」になる。

副作用として `dist` が 2 ファイル（シム + チャンク）になった。`bin` が指すのは `dist/index.js` の
ままで、パッケージルートの解決（`packageRootFrom`）も「`package.json` の 1 つ下」という前提を
保っている。

### 残っている上流の問題（Ink のキャッシュ）

Ink 7.1.1 は `measure-text.js` と `wrap-text.js` で**上限のないモジュールレベルキャッシュ**
（キー = テキスト全文）を持ち、解放経路が無い。約 100 文字の行 1 本で約 1.7KB、
4,000 文字の `<Text>` 1 描画で約 17.8KB が永久に残る。codiva 側でできるのは
**毎フレーム変わる長い文字列を渡さないこと**なので、ストリーミングプレビューは
`streamTail(text, width)` で**表示幅に切ってから**渡す（`wrap="truncate-end"` と見た目は同じ。
行が幅を超えると文字列が変わらなくなるのでキャッシュに当たるようになる）。
上限そのものは ink 側の修正が必要なので issue で報告している
（[ink#986](https://github.com/vadimdemedes/ink/issues/986)）。

## 設計判断

| 判断 | 理由 |
|------|------|
| 復元は「メタ + SDK resume」で、ログは永続しない | state.json を小さく保つ。会話履歴は SDK の resume が持つので二重管理しない。復元直後はアイドル表示、追加指示で継続 |
| 復元セッションは遅延 resume（起動時に起こさない） | セッション毎に ~1GiB のサブプロセスを起動時に乱立させない。触られたものだけ起こす |
| 終了は `abort()` ではなく `stop()`（quiet） | 実行中セッションを failed にせず resumable のまま保存するため（quit と「1件破棄」を区別） |
| 「破棄（`d`）」と「削除（`x` / `/remove` / `/clear`）」を分ける | 破棄は worktree を消して行を `archived` として残す（作業の記録が見える）。だがブランチに古い PR が付いていると、その行は一括立て直し（`Ctrl+F` = `recoverableSessions`）の候補として毎回挙がり続ける。削除は store から行ごと落とすので、記録も一括操作の対象も同時に消える。`/clear` も worktree/ブランチを残さない（残すと「消したのにディスクに残る」ぶんが見えない負債になる） |
| 削除で worktree の除去に失敗したら行を残す | ディスクにディレクトリが残っているのに一覧から消すと、存在するものが見えなくなる。エラーを出して行を残し、`/clear` は成功した件数だけ数える |
| 通知の発火判定は純粋関数・遷移時のみ | テスト可能にし、ストリーミングの連続更新で鳴り続けるのを防ぐ。OS I/O は utils に隔離し best-effort |
| 設定検証は `toConfig()` に集約・不正値は既定へ | 設定ミスで TUI をクラッシュさせない。SDK union は実行時リテラルで検証（型が変われば型エラー） |
| 分離手段は git worktree | 同一リポジトリの並列作業では最軽量。ブランチがそのまま成果物になる。Docker 等はMVPではオーバーキル |
| 競合は「検知のみ」で自動解消しない | 汎用的に安全なマージ競合の自動解消は存在しない（`-X ours/theirs` はコードを無言に捨てる）。可視化（`conflict` バッジ）に留め、解消は人手に委ねる |
| PR は draft で作り、緑になってから ready 化 | チェックは PR が無いと走らない（鶏卵）。完成前に push→draft で足場を作り、`gh pr checks` が緑になった時点で ready へ。確定操作は自動でも“レビュー可能”状態までに留める |
| origin 追従は作成時のみ（稼働中は pull しない） | 稼働中 worktree へ取り込むと未コミット変更と競合し得る。作成時に `origin/<base>` から切る安全な部分集合に限定 |
| PR 自動化は `PrAutomation` として DI・best-effort | `gh` 未導入/未認証/オフラインでもセッションを壊さない。core は `gh` を直接知らず、`utils/pr.ts` に隔離 |
| 自己更新は経路を判定できたときだけ実行する | `npm i -g` は npx キャッシュ・volta 配下・別 prefix では宛先が違い、環境を壊す。判定不能（`unknown`）なら**コマンドの提示だけ**に留め、誤爆のコストを「自動化されない」に限定する |
| 更新チェックは `latest` の 1 リクエスト・3 秒で打ち切り・await しない | 起動を絶対にブロックしない。オフライン/レジストリ障害でも `unavailable` に落ちるだけで TUI を壊さない。全 packument（21KB）ではなく `/latest`（2.3KB）を引く |
| 「最新だった」と「確認できなかった」を型で区別する | オフラインを「最新です」と表示すると嘘になる。`UpdateCheck` の union で UI が取り違えられないようにする |
| UI 文字列はカタログ集約 + 設定で言語切替 | 日本語/英語の利用者が混在する。ハードコードを排し、追加言語も `Lang`/`messages` 拡張だけで済む |
| セッション = SDK `query()` 1本（サブプロセス1本） | SDK の設計単位に素直。プロセス分離により1セッションのクラッシュが他に波及しない |
| streaming input を常用（単発 prompt を使わない） | 追加指示（F-6）と質問への回答（F-7）を同一機構で実現でき、セッションを開いたまま維持できる |
| コアと UI の分離 + queryFn の DI | SDK もネットワークも不要なユニットテストを可能にする（N-3 の 80% カバレッジはこれが前提） |
| worktree は `.codiva/worktrees/` 配下、ignore は `.codiva/.gitignore`（`*`）で自己完結 | 対象リポジトリのファイルも `.git/` の中も汚染しない。`.git` がファイルの環境（linked worktree / submodule）でも動く |
| アプリ終了時に worktree を消さない | N-4（作業内容の保全）。明示的な削除操作のみで消す |

## リスクと対応

| リスク | 対応 |
|--------|------|
| SDK メッセージ形式の想定違い | Phase 1 のスパイクで実メッセージを JSONL 収集し、reducer のテストフィクスチャに使う（想定で書かない） |
| 大量ストリームで Ink 再描画が重い | 一覧はステータス行のみ描画（ログは詳細ビューでのみ、末尾ビューポートにクリップ）+ 購読スロットリング |
| 質問検出の誤判定 | MVP はヒューリスティック + 詳細ビューで追加指示を送って対話を続けられるので誤判定の実害は小さい。スパイク結果で改善 |
| 並列セッションのAPIコスト | Backlog でコスト表示を追加。MVP では result メッセージの usage をログに残すのみ |
| ユーザーのメインworktreeが dirty | worktree は HEAD から切るため影響なし。起動時チェックで警告のみ表示 |
