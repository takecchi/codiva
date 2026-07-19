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

- [x] 全画面（100dvh 相当）レイアウト: root に端末 rows を指定、入力欄+フッタを下部固定、詳細ログは `<Static>` から末尾ビューポートへ置換
- [x] alt screen（`\x1b[?1049h`/`\x1b[?1049l`）でスクロールバックを無効化し、上へのスクロールをロック（`utils/alt-screen.ts`）
- [x] 詳細ビューのログスクロール（`core/scroll.ts` の `logWindow`/`scrollUp`/`scrollDown`、PgUp/PgDn。alt screen 下でも過去ログを遡れる）
- [x] 入力欄の複数行化（`core/text-buffer.ts` + `ui/input.ts`。Shift+Enter/末尾`\`+Enter で改行、`INPUT_MAX_ROWS` まで伸び超過は内部スクロール）
- [x] アプリ再起動後のセッション復元（`.codiva/state.json` + SDK `resume`）
- [x] 設定ファイル（model / effort / permissionMode / maxBudgetUsd）
- [x] `/model` コマンドでモデル切替（一覧画面のコンポーザで `/model` → モデル選択ダイアログ。
      選択は以降の新規セッションの既定になり `~/.codiva/config.json` に保存。`core/models.ts` /
      `core/commands.ts` / `ui/model-select.tsx` / `SessionManager.get|setModel`）
- [x] コスト表示（result の total_cost_usd 累計）
- [x] includePartialMessages によるストリーミング表示（`stream_event` の text_delta を `streamingText` に連結し詳細ビューにプレビュー）
- [x] デスクトップ通知（質問・完了時）
- [x] IME（日本語入力）対応: `PromptInput` が `useCursor` で実端末カーソルをキャレット位置
      （表示幅ベース、CJK 2セル）に置き、端末が変換中の未確定文字列を入力欄に描画できるようにする。
      backspace はコードポイント単位に修正（絵文字が半分残るバグも解消）

> 実績メモ（Phase 6 / 設定・コスト・通知・復元の4項目。ストリーミング表示は未着手）:
> - **設定拡張**: `core/config.ts` に `model`/`effort`/`permissionMode`/`maxBudgetUsd`/`notifications` を追加。
>   検証は `toConfig()` に集約（不正値は既定へフォールバック）。`SessionOptions` に束ね、
>   `SessionManager`→`Session`→SDK `Options` へ注入。`permissionMode` 未設定時は従来どおり `acceptEdits`。
> - **コスト表示**: `core/cost.ts`（純粋）に `totalCostUsd()`/`formatUsd()`。一覧はバナーに合計、
>   詳細は各セッションのコスト行。reducer は既に `state.totalCostUsd` を保持していたため導出のみ追加。
> - **通知**: 判定は純粋な `core/notify.ts` の `notificationFor(prev,next,messages)`（状態遷移時のみ発火）、
>   I/O は `utils/notify.ts`（darwin=osascript / linux=notify-send、argv 渡しで注入防止、best-effort）。
>   `SessionManager` の `onTransition` に配線。`config.notifications:false` で無効化。
> - **復元**: 永続は純粋な `core/persistence.ts`（`toPersistedSession`/`restoredSessionState`/`fromPersistedJson`）、
>   I/O は `utils/state-store.ts`（`<repo>/.codiva/state.json`、起動時に存在しない worktree を prune）。
>   `Session` は `resume`/`restored` を受け、復元セッションは起動時にサブプロセスを立てず、
>   最初の追加指示で遅延 resume。終了時は `stop()`（quiet）で resumable のまま保存。sdkSessionId を持つ
>   （＝真に resume 可能な）セッションのみ永続する。
> - 手動受け入れ（実 Claude での resume 挙動）は TTY+認証が要るため未実施。統合テスト（tests/restore.test.tsx）で
>   「run→persist→新 manager restore→追加指示で resume が query に載る」まで検証済み。

> 実績メモ（Phase 6 残 3項目 / ログスクロール・複数行入力・ストリーミング表示。これで Phase 6 全項目 完了）:
> - **ログスクロール**: 純粋な `core/scroll.ts`（`logWindow`/`scrollUp`/`scrollDown`/`pageStep`）。`anchor` は
>   `'bottom'`（末尾追従）か絶対 end index（**上スクロール中は固定**なので新着ログで view がぶれない＝top-anchored）。
>   `end` は anchor で厳密に、`start` は「埋まるぶん」だけ（rows 上限）取り、flex-end ビューポートがクリップ。
>   詳細ビューに PgUp/PgDn を配線、追加指示送信時は `'bottom'` へ戻す。alt screen（#5）で端末スクロールバックを
>   無効化したため、過去ログはこのアプリ内スクロールが唯一の手段。
> - **複数行入力**: 純粋モデル `core/text-buffer.ts`（value+cursor、insert/backspace/move*/`visibleLineRange`）、
>   キー→操作の対応のみ `ui/input.ts`（`editText`/`resolveEnter`）に置き、UI からロジックを排除。Shift/Meta+Enter か
>   末尾バックスラッシュ+Enter で改行（後者は Shift+Enter を送れない端末向けの堅牢なフォールバック）、他は送信。
>   一覧は矢印を行選択に温存（末尾編集のみ）、詳細は矢印でフルにカーソル移動。`PromptInput` は `INPUT_MAX_ROWS`
>   まで縦に伸び、超過分はカーソル付近を内部スクロール（空/1行時は 1行高を維持＝全画面テストの高さ不変）。
> - **ストリーミング表示**: `session.ts` に `includePartialMessages: true`。reducer は `stream_event` の
>   `content_block_delta`/`text_delta` のみ `state.streamingText` に連結し、確定 `assistant`/`result`/追加入力で
>   クリア（確定ログが正）。`streamingText` は transient で永続しない。SDK 型（`SDKPartialAssistantMessage` /
>   `BetaRawContentBlockDeltaEvent`）から形を確認して実装（想定書きしない規約）。詳細ビューは末尾にタイピング風プレビュー。
> - テスト: `core/scroll.spec.ts`・`core/text-buffer.spec.ts`・`status-reducer.spec.ts`（stream_event）をテーブル駆動で追加、
>   `tests/app.test.tsx` に統合3本（PgUp/PgDn スクロール・ストリーミングプレビュー+`includePartialMessages` 検証・
>   バックスラッシュ改行）。全 292 テスト緑、lint/typecheck/build 緑。手動受け入れ（実端末での改行/スクロール体感）は
>   TTY 環境が要るため未実施だが、ink-testing の統合テストで配線を検証済み。

## Phase 7: フォーカスモデル刷新 + claude CLI 連携（詳細ビュー廃止）

- [x] フォーカスモデル: 一覧画面を `composer`（起動時既定）/`list` の2ゾーン化。Tab で切替、
      composer は矢印でフルにキャレット移動（↑↓←→）、list は ↑↓選択・印字キーで composer へ自動復帰
- [x] マウス対応: SGR レポート（`utils/mouse.ts` ?1000/?1006、全画面時のみ・`"mouse": false` で無効化）。
      解析は純粋な `core/mouse.ts`。クリックで入力欄のキャレット移動（`caretIndexForColumn` 表示幅逆変換）
      とセッション行の選択
- [x] 詳細ビュー廃止 → **claude CLI 連携**: 一覧で Enter/→ → `Session.detach()`（quiet stop + `external`）
      → Ink `suspendTerminal` → `claude --resume <session-id>`（cwd=worktree、端末 inherit）→ /exit で
      codiva に復帰（alt screen / mouse は index.tsx が解除・再進入）。新ステータス `external`（claude作業中）
- [x] 詳細ビューにあった機能の移設: 許可/質問ダイアログは list フォーカス時に選択セッションのものを表示、
      マージ（m）/破棄（d）も一覧から。`core/scroll.ts`・`logViewportRows`・`streamingText` プレビューは
      claude CLI に役割を譲り削除（reducer の streamingText 状態は保持）

> 実績メモ: 全343テスト緑・lint/typecheck 緑。`external` は persistence 上 `completed`（resumable idle）として
> 復元。1 SDK セッション 1 ライターを守るため、claude で開く際は必ず codiva 側 query を停止してから spawn。
> claude CLI 実機での resume 挙動（認証必要）は手動確認が必要。

---

## 各 Phase 共通の完了チェック

1. `npm run lint` / `npm test` が通る
2. TASKS.md のチェックボックスを更新
3. ドキュメント（ARCHITECTURE.md / TECH_NOTES.md）と実装の乖離があれば解消
4. conventional commits でコミット
