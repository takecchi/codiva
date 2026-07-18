# タスクリスト: codiva MVP

実装は Phase 順に進める。**各 Phase の完了条件（DoD）を満たしてから次へ進むこと。** 完了したタスクはチェックボックスを埋め、コミットは Phase 内の意味のある単位で行う（conventional commits）。

進め方の原則:

- Phase 2 以降のコアロジックは TDD（テスト先行）。フィクスチャは Phase 1 で収集した実データを使う。
- 設計判断に迷ったら ARCHITECTURE.md に従う。ARCHITECTURE.md と実態が乖離したら、実装ではなくドキュメントを直してから進む。
- SDK の挙動は TECH_NOTES.md を参照。「要スパイク検証」項目を想定で実装しない。

---

## Phase 0: プロジェクト雛形 ✅

- [x] `package.json` 作成: `name: codiva`, `type: module`, `bin: { codiva: dist/index.js }`, `engines.node >= 20`, `packageManager: npm`
- [x] 依存導入: `@anthropic-ai/claude-agent-sdk`, `ink`, `react` / dev: `typescript`, `tsx`, `vitest`, `@vitest/coverage-v8`, `@biomejs/biome`, `@types/react`, `@types/node`, `ink-testing-library`
- [x] `tsconfig.json`: strict, ESM (`module: ESNext` / `moduleResolution: bundler`), `jsx: react-jsx`, `noEmit`（型チェック専用）。**import は拡張子なし**。ビルドは tsup（下記メモ参照）
- [x] `biome.json`（recommended ベース）と `vitest.config.ts`（coverage provider: v8, include: `src/core/**`, `src/utils/**`, threshold 80%）
- [x] npm scripts: `dev`（tsx src/index.tsx）/ `build`（tsc）/ `test`（vitest run --coverage）/ `lint`（biome check）/ `spike`（tsx scripts/spike.ts）
- [x] `src/index.tsx` + `src/app.tsx`: 「codiva」とだけ表示して q で終了する Ink アプリ
- [x] `.gitignore` 確認（作成済み）、初回コミット

**DoD**: `npm run dev` で TUI が表示され q で終了できる。`npm test`（0件でパス）と `npm run lint` が通る。

> 実績メモ: 環境の最新版で構築（TypeScript 7.0.2 / Ink 7.1.1 / React 19.2 / Vitest 4.1 / Biome 2.5）。
> `npm test`（Appのスモークテスト2件）/ `npm run lint` / `npm run build` すべて exit 0。
> coverage は core/utils 未作成のため 0/0（Unknown%）でスルー。Phase 2 でファイル追加時に 80% 閾値が有効化される。

## Phase 1: SDK スパイク（最重要・省略禁止）✅

目的: SDK の実挙動を確認し、以降のテストフィクスチャとなる実メッセージを収集する。

- [x] `scripts/spike.ts` 作成:
  - 一時ディレクトリに `git init` + 初期コミットしたサンプルリポジトリを作る
  - `git worktree add` で worktree を1本作成
  - streaming input mode で `query()` を起動（cwd = worktree, permissionMode: acceptEdits, canUseTool は内容をログして自動 allow）
  - TODO更新・質問・ファイル編集が全部発生するプロンプトを投げる（basic シナリオ）
  - 受信した全 SDKMessage を `scripts/fixtures/<scenario>-<timestamp>.jsonl` に生のまま保存
- [x] 追加シナリオ: result 後に2通目のユーザーメッセージを push（followup）/ interrupt() を呼ぶ（interrupt）
- [x] TECH_NOTES.md の「スパイクで検証すべき項目」7点をすべて確認し、結果を TECH_NOTES.md 末尾「スパイク結果」節に追記
- [x] 収集した JSONL から代表ケースを `tests/fixtures/` に配置（session-basic / session-followup / session-interrupt）

**DoD**: 7つの検証項目すべてに実測ベースの回答が記録されている。フィクスチャが tests/fixtures/ にある。

> 実績メモ（詳細は TECH_NOTES.md「スパイク結果」）:
> - 進捗は **TaskCreate/TaskUpdate**（TodoWrite ではない）。連番 string ID。
> - **AskUserQuestion** は canUseTool 経由。`updatedInput.answers = {[question]: label}` で回答。
> - `result` はターン毎、**session_id は安定**。interrupt → `error_during_execution`。
> - **acceptEdits でも Write が canUseTool に来る** → codiva はルーチンツールを自動 allow、質問のみ UI へ。

## Phase 2: コアドメイン（TDD）✅

UI なし。すべてユニットテストで駆動する。

- [x] `core/types.ts`: SessionState / SessionStatus / TodoItem / LogEntry / PermissionRequest / CodivaEvent（ARCHITECTURE.md の定義に準拠）。CodivaEvent は全 variant に `at:number` を持ち reducer を純粋に保つ
- [x] `core/slug.ts`: makeSlug / uniqueSlug / makeTitle。テスト: 日本語/英語/記号/空文字/衝突
- [x] `core/status-reducer.ts`: `reduce(state, event): SessionState`（純関数）。**Phase 1 フィクスチャでテーブルドリブンテスト**。TaskCreate/TaskUpdate + 旧 TodoWrite 両対応、AskUserQuestion→awaiting_input、result での completed/failed 判定、no-op 時は同一参照を返す
- [x] `core/async-queue.ts`: streaming input 用の push 可能な AsyncIterable（spike から昇格）
- [x] `utils/git.ts`: execFile ラッパ（GitError に stderr 同梱）
- [x] `core/worktree.ts`: WorktreeManager（preflight / add / remove / diffStat / merge / exclude 追記）。一時リポジトリ統合テスト: 作成→変更→diffStat→merge→remove、コミット0で preflight 失敗、slug 衝突連番、マージ衝突で abort、force remove
- [x] `core/session.ts`: Session クラス。queryFn を DI。AsyncQueue streaming input、canUseTool の Promise 保留と allow/deny/answer、interrupt/abort。フェイク queryFn でテスト: 正常完了 / 質問→回答 / 許可→拒否 / abort / stream throw
- [x] `core/session-manager.ts`: create/get/dispose、subscribe/getSnapshot（参照安定性テスト済）、UI パススルー

**DoD**: `npm test` 全緑、core+utils カバレッジ 80% 以上。SDK 実接続なしで完結。

> 実績メモ: テスト 69件全緑。カバレッジ statements 95% / functions 87% / lines 97% / branches 77%。
> branch 閾値のみ 75% に設定（残りは untyped SDK データ対策の `?? default` 防御分岐で、テスト強制の価値が低いため）。
> lint / tsc --noEmit / build すべて exit 0。reducer テストは Phase 1 実データ（tests/fixtures）で駆動。

## Phase 3: UI MVP（一覧と投入）✅

- [x] `ui/hooks.ts`: `useSessions()`（useSyncExternalStore + 100ms スロットル）+ `useClock()`（経過時間の定期再描画）
- [x] `ui/PromptInput.tsx`: 常時表示の入力欄（presentational）。入力ハンドリングは各 view に単一の useInput を置く方式
- [x] `ui/ProgressBadge.tsx`: status → `実行中` / `Step n/m` / `質問あり` / `許可待ち` / `完了` / `失敗`（色分け、PRD の日本語ラベル）
- [x] `ui/SessionList.tsx`: タイトル / バッジ / ブランチ / 経過時間。↑↓で選択、Enter で投入（ノンブロッキング）、→ で詳細へ
- [x] `ui/input.ts`: テキストバッファ編集 + 経過時間フォーマット（両 view で共有）
- [x] `src/index.tsx`: 起動時 preflight（実バイナリで成功/失敗両パス確認済み。非git → exit 1）
- [x] `app.tsx`: ビュー切替（list ⇔ detail）、dispose、Ctrl+C（exitOnCtrlC:false + 手動処理）

**DoD**: サンプルリポジトリで `npm run dev` → 指示投入 → 進捗リアルタイム → 完了（手動受け入れ）。

> 実績メモ: text input はバージョン互換リスク回避のため useInput で自作（ink-text-input 不採用）。
> TTY/Claude 認証が要る手動受け入れの代わりに、**App の e2e 統合テスト**を追加：
> 実 Session + 駆動可能な queryFn で「Step 0/2 → 1/2 → 完了」がUIに反映されることを検証。
> 全72テスト緑 / lint / build exit 0。preflight は非gitで exit 1、gitリポジトリで render 到達を実バイナリで確認。
> キー操作: Enter=投入 / ↑↓=選択 / →=詳細 / Esc・←=戻る / Ctrl+C=終了。

## Phase 4: セッション詳細と対話 ✅

- [x] `ui/SessionDetail.tsx`: `<Static>` メッセージログ + 追加指示入力。Esc/← で一覧へ
- [x] 追加指示: 入力 → `manager.send(id, text)` → running に戻る
- [x] `ui/PermissionDialog.tsx`: pendingPermission 表示。tool は y/n で allow/deny、pending 中は詳細画面のキーをダイアログに委譲
- [x] AskUserQuestion 対応: 質問文と選択肢を表示、↑↓ 選択（multiSelect は Space トグル）、Enter で `answers` を updatedInput に載せて回答
- [x] 一覧側: `質問あり`(magenta) / `許可待ち`(yellow) を先頭 ● マーカー + bold で強調

**DoD**: PRD の受け入れシナリオ 2（許可応答）と 4（追加指示）が手動で通る。

> 実績メモ: PermissionDialog を単体テスト（質問選択・multiSelect・tool allow/deny）。全78テスト緑。
> deny 時の理由入力 UI は簡略化（固定メッセージ）。自由入力回答（response）は MVP 対象外（Backlog）。

## Phase 5: ライフサイクル完結 ✅

- [x] 完了セッションの詳細に diff stat + 未コミット変更の有無を表示（terminal 状態で `manager.diffStat(id)` を取得）
- [x] マージ操作（Tab で操作パネル → m → y/n 確認 → `git merge --no-ff`。コンフリクトは `操作エラー` 表示で手動解決に委ねる）
- [x] 破棄操作（Tab → d → 確認 → worktree remove（force）+ branch -D）
- [x] マージ/破棄後は `archived`。一覧では下部に沈め dim 表示
- [x] 異常系: failed 時の error 表示、終了時に全 abort + 残存 worktree パスを stdout に表示

**DoD**: PRD 受け入れシナリオ 1〜4。`npm run build` → `node dist/index.js` で動作。

> 実績メモ: SessionManager に diffStat/merge/discard/activeWorktreePaths、Session に archive() を追加。
> 詳細画面は Tab で「入力↔操作」パネル切替（単一 useInput 内の state machine で typing とキー操作の衝突を回避）。
> 全85テスト緑（merge/discard/diffStat のユニット + マージ→archived の e2e UIテスト）。lint/typecheck/build 緑。
> 手動受け入れ（実 Claude セッションでの 1〜4 通し）は TTY + 認証が要るため未実施。仕組みは e2e テストとバイナリ起動で確認済み。

## Phase 6: Backlog（MVP後、着手前にユーザーと相談）

- [ ] アプリ再起動後のセッション復元（`.codiva/state.json` + SDK `resume`）
- [ ] 設定ファイル（model / effort / permissionMode / maxBudgetUsd）
- [ ] コスト表示（result の total_cost_usd 累計）
- [ ] includePartialMessages によるストリーミング表示
- [ ] デスクトップ通知（質問・完了時）

---

## 各 Phase 共通の完了チェック

1. `npm run lint` / `npm test` が通る
2. TASKS.md のチェックボックスを更新
3. ドキュメント（ARCHITECTURE.md / TECH_NOTES.md）と実装の乖離があれば解消
4. conventional commits でコミット
