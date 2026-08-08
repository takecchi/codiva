# アーキテクチャ規約

純粋ロジックと I/O を分離する設計を、単一パッケージ CLI 向けに適用する。

## レイヤと依存方向

```
ui/  ──▶ core/ ◀── utils/
         (依存先なし)
```

- **`src/core/`**: 純粋なドメインロジック。**Ink / React / execa / node の I/O を import しない**。ここが全ロジックの中心で、ユニットテストで完全に駆動できること。
  特定エージェントの SDK (`@anthropic-ai/claude-agent-sdk`) を import してよいのは**アダプタ 3 点**
  （`claude-adapter.ts` / `claude-parse.ts` / `claude-errors.ts`）だけで、他の中立モジュールは
  型も定数も引かない（[sdk-integration.md](./sdk-integration.md)）。
- **`src/utils/`**: I/O の薄いラッパ（`git.ts` = execFile ラッパ）。`core` のみに依存。
- **`src/ui/`**: Ink コンポーネントのみ。`core`（状態・型）を `@/core` から使う。ロジックを持たない — 状態計算は `core` の純関数に委譲する。
- **`src/index.tsx` / `src/main.tsx` / `src/app.tsx` / `src/bootstrap/`**: 合成レイヤ（どのレイヤにも属さず core と utils を束ねる）。
  **`index.tsx` は起動シム**（`NODE_ENV` を立てて `./main` を動的 import する 3 文）で、**static import を足さない**
  — 巻き上げられて react-reconciler が dev ビルドで評価され、描画ごとに `performance.measure()` が
  積まれてヒープが単調増加する（実測 2,230 B/フレーム ⇒ OOM。番人は `tests/entry-shim.test.ts`）。
  `main.tsx` は「解決 → preflight → build → restore → render → shutdown」の直列だけに保ち、副作用の配線は
  `bootstrap/`（`build-manager` = manager 組み立て / `restore-sessions` = 復元 / `persist-controller` =
  debounce・同期 flush / `runtime` = PR ポーリング・alt screen・signal）に切り出す。`app.tsx` はビュー切替のみ。
- **設定ファイルを読むのは合成レイヤだけ**。`core` は設定値を引数/DI で受け取る（純粋のまま保つ）。

依存は一方向（ui → core、utils → core、core → なし）。逆流させない。

## 依存性注入（DI）

副作用は境界で注入する。テスト容易性の要。

- `Session` / `SessionManager` は `agent`（`AgentAdapter`）を DI で受ける。省略時は `queryFn`
  （SDK の `query`）から Claude アダプタを組み立てる短縮形 → テストはフェイクを注入。
- `SessionManager` は `worktrees`（`WorktreeService`）と `createSession` factory を DI で受ける。
- `now: () => number` も注入可能にして時間を決定的にする（reducer は純粋、時刻はイベントの `at` で渡す）。

**DI 用の interface は 2 つの leaf に置く**（どちらも他の core モジュールを import しない末端。
そこに集約することで core 内の循環 import を防いでいる）:

| ファイル | 何の seam か | 主な型 |
|---|---|---|
| `core/session-ports.ts` | codiva 側（manager が駆動するもの） | `WorktreeService` / `SessionHandle` / `PrAutomation` / `PrLookup` |
| `core/agent-ports.ts` | エージェント側（provider の差し替え） | `AgentAdapter` / `AgentRun` / `AgentRunRequest` / `AgentCapabilities` / `PermissionDecision` |

`session-ports.ts` が `agent-ports.ts` を型で参照する（`SessionHandle.getAgent()`）ので、
依存の向きは **session-ports → agent-ports** の一方向。ここにある型を他ファイルで再定義しない。

## ファイル/モジュール規約

- **ファイル名は kebab-case**（`session-list.tsx`, `status-reducer.ts`）。コンポーネント/クラスの識別子は PascalCase。
- **パスエイリアス `@/*` → `./src/*`**。ディレクトリを跨ぐ import は `@/core` などバレル経由。同一フォルダ内は相対（`./hooks`）。
- **バレル `index.ts`**: 各フォルダ（core/ui/utils）に置き、`export * from './x'`。フォルダ内部モジュールはバレルを import しない（循環回避）。公開したくない補助は `internal/` に置き再エクスポートしない。
- モノレポ化しない（単一パッケージ）。Turbo / workspaces / SWR / Storybook は入れない。
- **同名モジュールが core と utils に併存する**（`config` / `notify` / `mouse` / `transcript` /
  `repo-prompt` / `privacy` / `worktree`）。純粋な判定・変換が core、実 I/O が utils という対なので、
  import 元が `@/core` か `@/utils` かを必ず確認する（取り違えるとレイヤ違反になる）。

セッションの状態・遷移・永続化の不変条件は [session-domain.md](./session-domain.md)、
git / PR / ファイル入出力は [git-and-io.md](./git-and-io.md) を参照。
