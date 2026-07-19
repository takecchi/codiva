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
│  Session        … 1セッション = SDK query + 状態     │
│  reduce()       … CodivaEvent → SessionState 畳み込み│
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

## ディレクトリ構造

```
codiva/
├── src/
│   ├── index.tsx              # bin エントリ。前提チェック → Ink render → 終了時に残存 worktree 表示
│   ├── app.tsx                # ルートコンポーネント。list ⇔ detail のビュー切替
│   ├── core/                  # 純粋ドメイン（Ink/React 非依存）
│   │   ├── index.ts           # バレル（export *）
│   │   ├── types.ts           # SessionState, SessionStatus, CodivaEvent 等の型定義
│   │   ├── status-reducer.ts  # reduce(state, CodivaEvent): SessionState（純関数）
│   │   ├── status-reducer.spec.ts   # 単体テストは実装の隣に co-located
│   │   ├── session.ts / session.spec.ts
│   │   ├── session-manager.ts / session-manager.spec.ts  # Store + ライフサイクル + 復元
│   │   ├── worktree.ts / worktree.spec.ts                # Worktree 型 + MergeConflictError + ignoredCopyEntries（純粋）
│   │   ├── async-queue.ts / async-queue.spec.ts
│   │   ├── slug.ts / slug.spec.ts
│   │   ├── config.ts / config.spec.ts     # 設定ドメイン型 + toConfig()（言語/model/effort/…）
│   │   ├── cost.ts / cost.spec.ts         # totalCostUsd() / formatUsd()（純粋・導出）
│   │   ├── notify.ts / notify.spec.ts     # notificationFor()（通知の発火判定・純粋）
│   │   ├── persistence.ts / persistence.spec.ts   # 復元用スナップショットの変換・検証（純粋）
│   │   ├── scroll.ts / scroll.spec.ts             # 詳細ビューのログ窓・PgUp/PgDn 計算（純粋）
│   │   ├── text-buffer.ts / text-buffer.spec.ts   # 複数行テキストバッファ（value+cursor、純粋）
│   │   ├── mouse.ts / mouse.spec.ts               # SGR マウスレポートの解析（純粋）
│   │   └── __fixtures__/      # サニタイズ済み実 SDK メッセージ（reducer テスト用）
│   ├── ui/                    # Ink コンポーネント（kebab-case, 識別子は PascalCase）
│   │   ├── index.ts           # バレル
│   │   ├── theme.ts           # アクセント色・グリフ（Claude Code 風の共通ビジュアル）
│   │   ├── banner.tsx         # 起動時ヘッダ（✻ codiva + サブタイトル + cwd, 枠なし）
│   │   ├── session-list.tsx   # 一覧画面（composer/list の2フォーカスゾーン）
│   │   ├── session-detail.tsx # 詳細画面（ログ + 追加指示 + マージ/破棄。SDK セッションに直結）
│   │   ├── prompt-input.tsx   # 上下横罫線 + ❯ キャレットの入力欄（presentational）
│   │   ├── status-footer.tsx  # ⏵⏵ auto mode on (shift+tab...) のモード行
│   │   ├── permission-dialog.tsx / permission-dialog.spec.tsx
│   │   ├── progress-badge.tsx / progress-badge.spec.tsx
│   │   ├── hooks.ts           # useSessions()（useSyncExternalStore）/ useClock()
│   │   └── input.ts           # テキストバッファ編集 + 経過時間フォーマット
│   └── utils/
│       ├── index.ts           # バレル
│       ├── git.ts / git.spec.ts             # execFile ベースの git 実行ヘルパ
│       ├── worktree-manager.ts / worktree-manager.spec.ts  # WorktreeManager（git worktree の I/O）
│       ├── config.ts / config.spec.ts       # ~/.codiva/config.json の読み書き
│       ├── notify.ts / notify.spec.ts       # OS デスクトップ通知（osascript / notify-send）
│       ├── mouse.ts / mouse.spec.ts              # SGR マウスレポートの有効化/無効化
│       └── state-store.ts / state-store.spec.ts  # <repo>/.codiva/state.json の読み書き + prune
├── scripts/
│   └── spike.ts               # Phase 1: SDK 挙動検証スクリプト
├── tests/                     # App 全体を通す機能/統合テスト（*.test.tsx）
└── docs/                      # 本ドキュメント群

# テスト: 単体は実装隣の *.spec.ts、機能/統合は tests/*.test.tsx。
# import は `@/*` → `./src/*` エイリアス（ディレクトリ跨ぎ）。ビルドは tsup、型チェックは tsc --noEmit。
```

## セッション状態機械

`SessionStatus` の遷移。導出元はすべて SDK メッセージストリームと canUseTool コールバック。

```
 creating ──(worktree作成完了 & query開始)──▶ running
 running ──(canUseTool 発火)───────────────▶ awaiting_permission
 awaiting_permission ──(ユーザー応答)────────▶ running
 running ──(result 受信 & 質問で終了)────────▶ awaiting_input
 running ──(result 受信 & 正常終了)──────────▶ completed
 running ──(result subtype がエラー系)───────▶ failed
 running ──(レート制限に到達)─────────────────▶ rate_limited # rate_limit_event(rejected) / error='rate_limit' / usage-limit result・throw
 awaiting_input ──(追加指示送信)─────────────▶ running
 completed ──(追加指示送信)─────────────────▶ running   # 完了後の追加作業も許す
 * ──(query の throw / abort)──────────────▶ failed
 completed ──(マージ or 破棄)────────────────▶ archived
 running/awaiting_* ──(アプリ終了 → 保存)────▶ interrupted # メモリ上は状態不変。保存時に丸める（restorableStatus）
 rate_limited ──(アプリ終了 → 保存)──────────▶ interrupted # 制限は一時的。復元時は resumable な interrupted に丸める
 interrupted ──(追加指示送信で resume)───────▶ running
```

`interrupted` は「実行中/入力待ちのままアプリを閉じた」セッションを表す**復元専用**の状態。`stop()`
はメモリ上の状態を変えないが、保存時に `restorableStatus` が `running`/`awaiting_*` を
`interrupted` に丸める（正常終了した `completed` とは区別する）。復元後は `completed` と同じく
idle で resumable、追加指示で resume できる。

`rate_limited` は「使用量／レート制限に達して止まった」セッションを表す。`completed`/`failed` と同じく
idle だが、エラー扱い（`failed`）にはせず「制限が解けるのを待って再開できる」状態として区別する。
検知元は SDK の `rate_limit_event`（`rate_limit_info.status === 'rejected'`）、assistant メッセージの
`error === 'rate_limit'`、および usage-limit を示す `result`／throw されたエラー文言（`isRateLimitError`。
SDK の `USAGE_LIMIT_ERROR_PREFIXES` に追従）。制限は一時的なので保存時は `interrupted` に丸める。

`SessionState`（UI が購読する不変スナップショット）:

```typescript
interface SessionState {
  id: string;
  title: string;              // タスク名。起動直後は指示文由来の暫定値、Haiku 要約が返り次第差し替え（title イベント）
  status: SessionStatus;
  prompt: string;             // 最初の指示文
  branch: string;             // codiva/<slug>
  worktreePath: string;
  todos: TodoItem[];          // TodoWrite の最新スナップショット
  progress?: { done: number; total: number }; // todos から導出
  messages: LogEntry[];       // 整形済みログ（現 UI では未表示。永続化・将来のプレビュー用に保持）
  pendingPermission?: PermissionRequest;      // awaiting_permission 時のみ
  sdkSessionId?: string;      // system/init から取得。resume 用に保持
  startedAt: number;
  finishedAt?: number;
  error?: string;
}
```

### 状態導出ルール

- **Step n/m**: `assistant` メッセージ内の tool_use から TODO スナップショットを構築する。`TodoWrite`（`input.todos` 配列で全置換）と `TaskCreate`/`TaskUpdate`（増分更新）の**両方に対応**する（SDKの世代により流れてくるツールが異なる。TECH_NOTES.md 参照）。`done = status === 'completed' の数`, `total = 全数`。
- **質問あり**: Claude がユーザーへの質問に使う `AskUserQuestion` ツールは、allow ルールに関係なく必ず `canUseTool` コールバックに届く（公式仕様）。`toolName === 'AskUserQuestion'` を検知したら `awaiting_input` に遷移し、質問と選択肢を UI に表示。ユーザーの回答を `updatedInput` に載せて allow で返す。補助として、`result` 受信時に直近 assistant テキストが疑問文で終わる場合も `awaiting_input` にする（ツールを使わず地の文で質問するケース）。
- **許可待ち**: `canUseTool` コールバック（`AskUserQuestion` 以外）が呼ばれたら `PermissionRequest` を state に積み、UI の応答で Promise を resolve する。コールバックの Promise が解決されるまでセッションはブロックされる（公式仕様として保証）。

## 主要クラスの責務

### Session (`core/session.ts`)

1セッションのライフサイクルを保持する。

- コンストラクタで `queryFn`（SDK の `query` 関数）を **DI で受け取る**。テストでは合成メッセージストリームを注入する。
- streaming input mode を常用: `query()` の prompt に自前の `AsyncGenerator<SDKUserMessage>` を渡し、内部キュー（push可能な async queue）で管理。`send(text)` でいつでも追加メッセージを投入できる。
- 受信ループ: `for await (const msg of query)` で `reduceStatus()` に畳み込み、変更のたびに `onChange` を発火。
- `respondToPermission(result)`: 保留中の canUseTool Promise を resolve。
- `interrupt()` / `abort()`: SDK の interrupt / AbortController。
- `SessionOptions`（`model`/`effort`/`permissionMode`/`maxBudgetUsd`）を DI で受け、`query()` の `options` に反映（設定ファイル由来）。`permissionMode` 未指定時は `acceptEdits`。
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
- **モデル切替（`/model`）**: `SessionOptions` を可変フィールドとして保持し、`getModel()` / `setModel(model)` で公開。`setModel` は**以降の新規セッション**に適用（実行中セッションは起動時のモデルを維持）し、`onModelChange(model)` で合成ルートに通知 → `~/.codiva/config.json` の `model` にマージ保存される。選択肢は `core/models.ts`（`MODELS`）、コマンド解析は `core/commands.ts`（`parseSlashCommand`）。
- `restore(persisted)`: 起動時に前回セッションを再構築（worktree meta を再配線し、`Session` に `resume`/`restored` を渡す。id/slug を予約して衝突回避）。

### WorktreeManager (`core/worktree.ts`)

- 前提チェック: Gitリポジトリか、HEAD が存在するか（コミット0のリポジトリでは worktree を作れない）。
- `add(slug)`: `git worktree add .codiva/worktrees/<slug> -b codiva/<slug>` を現在の HEAD から作成。slug 衝突時は `-2`, `-3` を付与。
- `.git/info/exclude` に `.codiva/` を自動追記（初回のみ）。
- ignore 済みファイルの複製: `copyIgnored`（既定 true）が有効なら、`git ls-files --others --ignored --exclude-standard --directory` で列挙した `.gitignore` 対象（`node_modules/`・`.env` など）をリポジトリルートから worktree へ `fs.cp` で複製する。git worktree は追跡対象しか引き継がないため、これで依存の再インストールや環境変数の再設定なしにセッションが即実行できる。列挙結果のフィルタは純関数 `ignoredCopyEntries()` に切り出し（`.codiva/`・`.git` は再帰・内部状態破壊を避けるため必ず除外）、コピー自体はエントリ単位のベストエフォート（1件の失敗で worktree 作成を止めない）。
- `diffStat(session)`: `git -C <worktree> diff <base>...HEAD --stat` 相当。未コミット変更がある場合はその旨も返す。
- `merge(session)`: セッションブランチをベースブランチへマージ（squash はしない。コンフリクト時はエラーを返し、手動解決を促すメッセージを表示するのみ）。
- `remove(session, { force })`: `git worktree remove` + `git branch -D`。

### UI (ui/)

Claude Code の実画面に寄せる: 画面は**端末の縦幅いっぱい**（web の 100dvh 相当。`App` が root Box に `useWindowSize()` の rows を指定。極端に低い端末では `isFullscreenViewport` が false になりインライン描画へフォールバック）に描画し、全画面時は起動時に **alt screen**（`utils/alt-screen.ts`）へ入ってスクロールバックを無効化（上へのスクロールをロック）し、下部に**上下の全幅横罫線だけ**の入力欄（`PromptInput`、角丸枠ではない）、その下にモード行（`StatusFooter` = `⏵⏵ auto mode on (shift+tab to cycle)` + 文脈ヒント）を flexGrow スペーサで**最下部に固定**。ヘッダは枠なしのワードマーク。色とグリフは `theme.ts` に集約。

- `App`: 全画面レイアウトの root と Ctrl+C の安全網。**list ⇔ detail のビュー切替**を `View` state で持ち、
  一覧で Enter/→ すると `onOpen(id)` で詳細へ、詳細で Esc すると `onBack` で一覧へ戻る。
- `Banner`: 起動時ヘッダ（`✻ codiva` + サブタイトル + cwd）。枠なし3行、一覧上部に表示。
- `SessionList`: 一覧画面。`Banner` + 一覧 + 下部 `PromptInput`/`StatusFooter`。フォーカスは
  `composer`（起動時既定。タイピング + 矢印キャレット移動）と `list`（↑↓選択・Enter/→ = 詳細を開く・
  m/d = マージ/破棄）の2ゾーンで Tab 切替。選択セッションの `PermissionDialog` は list フォーカス時のみ
  アクティブ。マウスクリック（`core/mouse.ts` + `useAbsolutePosition`）で行選択・キャレット移動。
- `SessionDetail`: 詳細画面。**ステータスヘッダは持たず**、コンテンツ（末尾ビューポートのログ）+ フッタ
  （追加指示コンポーザ）だけの構成。SDK セッションに**直結**し、末尾ビューポートにログを描画（`core/scroll.ts` の
  `logLines` でエントリを CJK 幅対応で折り返した**物理行**（`DisplayLine[]`）へ展開してから、
  `logWindow`/`scrollUp`/`scrollDown` で PgUp/PgDn とマウスホイール（`WHEEL_SCROLL_ROWS`）スクロール。
  ホイールは `parseSgrMouse` で先取り解釈し、レポート列がコンポーザへ文字入力として漏れないようにする）、
  `streamingText` のタイピング風プレビュー、
  下部の追加指示コンポーザ（`manager.send(id, text)`）を持つ。Tab で入力↔操作パネルを切替し、
  操作パネルで m/d = マージ/破棄。`pendingPermission` があれば `PermissionDialog` に委譲。単一 `useInput` の
  state machine（panel = input | actions）でタイピングとキー操作の衝突を防ぐ。
- `PromptInput` / `StatusFooter`: presentational。キー処理は view の単一 `useInput` に集約（ロジックは持たない）。`PromptInput` は複数行対応（純粋モデルは `core/text-buffer.ts`、キー対応は `ui/input.ts` の `editText`/`resolveEnter`）。IME 対応で実端末カーソルをキャレットに重ねる（`useCursor`）。
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
  `notifications` / `mouse` / `followOrigin` / `autoPr` を追加。検証変換は `core/config.ts` の `toConfig()` に
  集約し、不正値は静かに既定へ落とす。合成ルート（`index.tsx`）が `SessionOptions` に束ねて `SessionManager`
  へ注入する。`followOrigin` / `autoPr` は真偽値（既定 on。`false` 明示で無効）。
- **コスト表示**: reducer は `result.total_cost_usd` を `state.totalCostUsd` として既に保持。UI 用の導出だけ
  `core/cost.ts`（`totalCostUsd()` 合計 / `formatUsd()` 整形）に純粋関数で追加。一覧はバナーに合計、詳細は各行。
- **デスクトップ通知**: 発火判定は純粋な `core/notify.ts` の `notificationFor(prev,next,messages)`
  （**状態遷移時のみ**返す＝連続更新で鳴り続けない）。実 I/O は `utils/notify.ts`（darwin=`osascript`,
  linux=`notify-send`。文字列は **argv 渡し**で注入防止。missing binary 等は握り潰す best-effort）。
  `SessionManager.onTransition` に配線し、`config.notifications:false` で合成ルートが無効化。
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
  `refreshPrs` の 20 秒ポーリングで、draft PR のチェックが緑（`PrAutomation.checks` = `passing`）になったら
  `markReady`（`gh pr ready`）で ready 化する。`gh` 依存はすべて `utils/pr.ts` に隔離し、`PrAutomation` として
  DI（失敗は best-effort でセッションに波及させない）。
- **競合検知（自動解消しない）**: `WorktreeManager.merge` は競合時に競合ファイルを収集して
  `merge --abort` した上で `MergeConflictError` を投げる（base ツリーは汚さない）。`SessionManager.merge` は
  これを捕えて `session.markConflict(files)` → reducer が `status: 'conflict'` + `conflictFiles` を立てる。
  **自動解消はしない**（`-X ours/theirs` 等でコードを無言に捨てない）。UI はバッジ表示のみで、解消は人手。
  `conflict` は詳細ビューでも終端状態扱い（差分・操作を表示）で、破棄や再マージは一覧/詳細から可能。
| 復元は「メタ + SDK resume」で、ログは永続しない | state.json を小さく保つ。会話履歴は SDK の resume が持つので二重管理しない。復元直後はアイドル表示、追加指示で継続 |
| 復元セッションは遅延 resume（起動時に起こさない） | セッション毎に ~1GiB のサブプロセスを起動時に乱立させない。触られたものだけ起こす |
| 終了は `abort()` ではなく `stop()`（quiet） | 実行中セッションを failed にせず resumable のまま保存するため（quit と「1件破棄」を区別） |
| 通知の発火判定は純粋関数・遷移時のみ | テスト可能にし、ストリーミングの連続更新で鳴り続けるのを防ぐ。OS I/O は utils に隔離し best-effort |
| 設定検証は `toConfig()` に集約・不正値は既定へ | 設定ミスで TUI をクラッシュさせない。SDK union は実行時リテラルで検証（型が変われば型エラー） |
| 分離手段は git worktree | 同一リポジトリの並列作業では最軽量。ブランチがそのまま成果物になる。Docker 等はMVPではオーバーキル |
| 競合は「検知のみ」で自動解消しない | 汎用的に安全なマージ競合の自動解消は存在しない（`-X ours/theirs` はコードを無言に捨てる）。可視化（`conflict` バッジ）に留め、解消は人手に委ねる |
| PR は draft で作り、緑になってから ready 化 | チェックは PR が無いと走らない（鶏卵）。完成前に push→draft で足場を作り、`gh pr checks` が緑になった時点で ready へ。確定操作は自動でも“レビュー可能”状態までに留める |
| origin 追従は作成時のみ（稼働中は pull しない） | 稼働中 worktree へ取り込むと未コミット変更と競合し得る。作成時に `origin/<base>` から切る安全な部分集合に限定 |
| PR 自動化は `PrAutomation` として DI・best-effort | `gh` 未導入/未認証/オフラインでもセッションを壊さない。core は `gh` を直接知らず、`utils/pr.ts` に隔離 |
| UI 文字列はカタログ集約 + 設定で言語切替 | 日本語/英語の利用者が混在する。ハードコードを排し、追加言語も `Lang`/`messages` 拡張だけで済む |
| セッション = SDK `query()` 1本（サブプロセス1本） | SDK の設計単位に素直。プロセス分離により1セッションのクラッシュが他に波及しない |
| streaming input を常用（単発 prompt を使わない） | 追加指示（F-6）と質問への回答（F-7）を同一機構で実現でき、セッションを開いたまま維持できる |
| コアと UI の分離 + queryFn の DI | SDK もネットワークも不要なユニットテストを可能にする（N-3 の 80% カバレッジはこれが前提） |
| worktree は `.codiva/worktrees/` 配下、exclude は `.git/info/exclude` | 対象リポジトリのファイルを一切汚染しない |
| アプリ終了時に worktree を消さない | N-4（作業内容の保全）。明示的な削除操作のみで消す |

## リスクと対応

| リスク | 対応 |
|--------|------|
| SDK メッセージ形式の想定違い | Phase 1 のスパイクで実メッセージを JSONL 収集し、reducer のテストフィクスチャに使う（想定で書かない） |
| 大量ストリームで Ink 再描画が重い | 一覧はステータス行のみ描画（ログは詳細ビューでのみ、末尾ビューポートにクリップ）+ 購読スロットリング |
| 質問検出の誤判定 | MVP はヒューリスティック + 詳細ビューで追加指示を送って対話を続けられるので誤判定の実害は小さい。スパイク結果で改善 |
| 並列セッションのAPIコスト | Backlog でコスト表示を追加。MVP では result メッセージの usage をログに残すのみ |
| ユーザーのメインworktreeが dirty | worktree は HEAD から切るため影響なし。起動時チェックで警告のみ表示 |
