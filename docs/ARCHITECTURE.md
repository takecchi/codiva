# アーキテクチャ設計: codiva

## レイヤ構成

UI とコアロジックを完全に分離する。コアは Ink/React に一切依存せず、単体でテスト可能にする。

```
┌─ ui/ (Ink + React) ────────────────────────────────┐
│  App / SessionList / SessionDetail / PromptInput    │
│  PermissionDialog / ProgressBadge                   │
│        ▲ useSyncExternalStore で購読                 │
└────────┼────────────────────────────────────────────┘
┌────────┴─ core/ (純TypeScript, UIなし) ─────────────┐
│  SessionManager … セッションの生成・保持・イベント発火   │
│  Session        … 1セッション = SDK query + 状態     │
│  reduceStatus() … SDKMessage → SessionState 畳み込み │
│  WorktreeManager… git worktree の作成・削除・マージ   │
└────────┬────────────────────────────────────────────┘
┌────────┴─ 外部 ─────────────────────────────────────┐
│  @anthropic-ai/claude-agent-sdk (query)             │
│  git CLI (worktree / diff / merge)                  │
└─────────────────────────────────────────────────────┘
```

## ディレクトリ構造

```
codiva/
├── src/
│   ├── index.tsx              # bin エントリ。前提チェック → Ink render → 終了時に残存 worktree 表示
│   ├── app.tsx                # ルートコンポーネント。ビュー切替（一覧 / 詳細）
│   ├── core/                  # 純粋ドメイン（Ink/React 非依存）
│   │   ├── index.ts           # バレル（export *）
│   │   ├── types.ts           # SessionState, SessionStatus, CodivaEvent 等の型定義
│   │   ├── status-reducer.ts  # reduce(state, CodivaEvent): SessionState（純関数）
│   │   ├── status-reducer.spec.ts   # 単体テストは実装の隣に co-located
│   │   ├── session.ts / session.spec.ts
│   │   ├── session-manager.ts / session-manager.spec.ts  # Store + ライフサイクル
│   │   ├── worktree.ts / worktree.spec.ts                # WorktreeManager
│   │   ├── async-queue.ts / async-queue.spec.ts
│   │   ├── slug.ts / slug.spec.ts
│   │   └── __fixtures__/      # サニタイズ済み実 SDK メッセージ（reducer テスト用）
│   ├── ui/                    # Ink コンポーネント（kebab-case, 識別子は PascalCase）
│   │   ├── index.ts           # バレル
│   │   ├── session-list.tsx
│   │   ├── session-detail.tsx
│   │   ├── prompt-input.tsx
│   │   ├── permission-dialog.tsx / permission-dialog.spec.tsx
│   │   ├── progress-badge.tsx / progress-badge.spec.tsx
│   │   ├── hooks.ts           # useSessions()（useSyncExternalStore）/ useClock()
│   │   └── input.ts           # テキストバッファ編集 + 経過時間フォーマット
│   └── utils/
│       ├── index.ts           # バレル
│       └── git.ts / git.spec.ts   # execFile ベースの git 実行ヘルパ
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
 awaiting_input ──(追加指示送信)─────────────▶ running
 completed ──(追加指示送信)─────────────────▶ running   # 完了後の追加作業も許す
 * ──(query の throw / abort)──────────────▶ failed
 completed ──(マージ or 破棄)────────────────▶ archived
```

`SessionState`（UI が購読する不変スナップショット）:

```typescript
interface SessionState {
  id: string;
  title: string;              // 指示文由来のタスク名
  status: SessionStatus;
  prompt: string;             // 最初の指示文
  branch: string;             // codiva/<slug>
  worktreePath: string;
  todos: TodoItem[];          // TodoWrite の最新スナップショット
  progress?: { done: number; total: number }; // todos から導出
  messages: LogEntry[];       // 詳細ビュー用の整形済みログ
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

### SessionManager (`core/session-manager.ts`)

- `create(prompt)`: slug生成 → WorktreeManager.add() → Session 起動。同期的に `creating` 状態のエントリを即時返す（UI を待たせない）。
- 全セッションの `Map<id, Session>` を保持し、`subscribe(listener)` / `getSnapshot(): SessionState[]` を提供（React の `useSyncExternalStore` にそのまま接続できる形）。
- スナップショットは毎回新しい配列参照を返すが、**変更のあったセッション以外のオブジェクト参照は維持**する（不要な再描画防止）。
- `dispose()`: 全セッション abort（worktree は残す）。

### WorktreeManager (`core/worktree.ts`)

- 前提チェック: Gitリポジトリか、HEAD が存在するか（コミット0のリポジトリでは worktree を作れない）。
- `add(slug)`: `git worktree add .codiva/worktrees/<slug> -b codiva/<slug>` を現在の HEAD から作成。slug 衝突時は `-2`, `-3` を付与。
- `.git/info/exclude` に `.codiva/` を自動追記（初回のみ）。
- `diffStat(session)`: `git -C <worktree> diff <base>...HEAD --stat` 相当。未コミット変更がある場合はその旨も返す。
- `merge(session)`: セッションブランチをベースブランチへマージ（squash はしない。コンフリクト時はエラーを返し、手動解決を促すメッセージを表示するのみ）。
- `remove(session, { force })`: `git worktree remove` + `git branch -D`。

### UI (ui/)

- `App`: ビュー状態（`list` | `detail:<id>`）と全体キーバインドを管理。
- `SessionList`: 一覧 + 選択カーソル。`PromptInput` を上部に常設し、いつでも新規投入できる。
- `SessionDetail`: メッセージログ + 追加指示入力 + `PermissionDialog`。ログは Ink の `<Static>` で追記描画し再描画コストを抑える。
- 再描画スロットリング: SessionManager の通知を UI 側で ~100ms にスロットルする。

## 設計上の決定と理由

| 決定 | 理由 |
|------|------|
| 分離手段は git worktree | 同一リポジトリの並列作業では最軽量。ブランチがそのまま成果物になる。Docker 等はMVPではオーバーキル |
| セッション = SDK `query()` 1本（サブプロセス1本） | SDK の設計単位に素直。プロセス分離により1セッションのクラッシュが他に波及しない |
| streaming input を常用（単発 prompt を使わない） | 追加指示（F-6）と質問への回答（F-7）を同一機構で実現でき、セッションを開いたまま維持できる |
| コアと UI の分離 + queryFn の DI | SDK もネットワークも不要なユニットテストを可能にする（N-3 の 80% カバレッジはこれが前提） |
| worktree は `.codiva/worktrees/` 配下、exclude は `.git/info/exclude` | 対象リポジトリのファイルを一切汚染しない |
| アプリ終了時に worktree を消さない | N-4（作業内容の保全）。明示的な削除操作のみで消す |

## リスクと対応

| リスク | 対応 |
|--------|------|
| SDK メッセージ形式の想定違い | Phase 1 のスパイクで実メッセージを JSONL 収集し、reducer のテストフィクスチャに使う（想定で書かない） |
| 大量ストリームで Ink 再描画が重い | 詳細ビューは選択中セッションのみ描画 + `<Static>` + スロットリング |
| 質問検出の誤判定 | MVP はヒューリスティック + 詳細ビューでいつでも追加入力可能なので誤判定の実害は小さい。スパイク結果で改善 |
| 並列セッションのAPIコスト | Backlog でコスト表示を追加。MVP では result メッセージの usage をログに残すのみ |
| ユーザーのメインworktreeが dirty | worktree は HEAD から切るため影響なし。起動時チェックで警告のみ表示 |
