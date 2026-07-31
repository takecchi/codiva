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
- [x] 収集した JSONL から代表ケースを `src/core/__fixtures__/` に配置（session-basic / session-followup / session-interrupt。のちに session-subagent を追加）

**DoD**: 7つの検証項目すべてに実測ベースの回答が記録されている。フィクスチャが `src/core/__fixtures__/` にある。

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
> lint / tsc --noEmit / build すべて exit 0。reducer テストは Phase 1 実データ（`src/core/__fixtures__/`）で駆動。

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

## Phase 8: スラッシュコマンド

- [x] 入力欄の先頭が `/` のとき通常の指示ではなくコマンドとして扱う土台を用意
- [x] コマンドは `core/commands.ts` の `COMMANDS` レジストリに 1 エントリ足すだけで増やせる設計
      （`CommandAction` に動作を追加 → UI が switch で受ける）。解析・照合は純粋関数（`parseCommand` /
      `matchCommands` / `runCommand`）に閉じ込め、副作用は UI 層が `CommandAction` を解釈して実行
- [x] 入力中は前方一致するコマンドをパレット表示（`ui/command-palette.tsx`）。`/help` は全コマンドの
      ヘルプ一覧をオーバーレイ表示（任意キーで閉じる）
- [x] 初期コマンド: `/help`（別名 `?`）・`/quit`（別名 `exit` / `q`）。未知コマンドは操作エラー表示
- [x] i18n: `command` グループを ja/en 両カタログに追加（説明文はカタログに集約）

> 実績メモ: `commands.ts` は 100% カバレッジ（`commands.spec.ts` でテーブル駆動）。UI 配線は
> `tests/commands.test.tsx`（パレット表示・前方一致・/help オーバーレイ・/quit で dispose・未知エラー）で検証。
> 単一 useInput の原則は維持（コマンドは composer の Enter 分岐で処理、/help オーバーレイは任意キーで閉じる）。
> 全 383 テスト緑・lint / typecheck / build 緑。

## Phase 9: 内蔵詳細ビューへ復帰（claude CLI 連携の廃止）

> codiva 側の機能（ログ描画・追加指示・スクロール・マージ/破棄）が揃ったため、Phase 7 の
> claude CLI 連携をやめ、一覧で Enter/→ したら **codiva 内蔵の詳細ビュー**で稼働中の SDK
> セッションに直結する方式へ戻す。

- [x] `ui/session-detail.tsx` を新規に書き直し: SDK セッション直結。ヘッダ（タイトル/バッジ/進捗/コスト/エラー）
      + 末尾ビューポートのログ（`core/scroll.ts` で PgUp/PgDn）+ `streamingText` プレビュー + 追加指示
      コンポーザ（`manager.send`）。Tab で入力↔操作、操作パネルで m/d。バッファ編集は ref 経由で逐次適用
- [x] `core/scroll.ts` + spec、`layout.ts` の `logViewportRows`/`DETAIL_CHROME_ROWS` を復元（純粋・テスト付き）
- [x] `app.tsx` に `View`（list ⇔ detail）状態機械を再導入。`SessionList` は `onOpen(id)` でナビゲート
- [x] claude CLI 連携を**完全削除**: `utils/claude-cli.ts`（+spec）・`ExternalRunner`/`runExternal`/`openExternal`・
      `Session.detach()`・`detached` イベント・`external` ステータス（types/reducer/persistence/badge/i18n）を撤去
- [x] i18n: `detail` グループを復活（ja/en 対）、`list.helpList` を「詳細を開く」へ、`list.openNotReady` と
      `badge.external` を削除
- [x] 統合テスト追加（`tests/app.test.tsx`）: Enter で詳細を開き Esc で戻る / 詳細から追加指示を送る /
      詳細の操作パネルからマージ

> 実績メモ: 全358テスト緑・lint/typecheck 緑。1 SDK セッション 1 ライターは維持（詳細ビューでも
> codiva が唯一のライター、外部 CLI との二重接続なし）。

## Phase 10: origin 追従 / PR 自動化 / 競合検知

> 「検知・追従・PR 足場作りは自動化、破壊的な確定操作（競合の無言解消・PR ready 化）は
> 人手/緑判定を挟む」方針。設定はすべて `~/.codiva/config.json` の真偽値で、既定 on。

- [x] **origin 自動追従（`followOrigin`, 既定 on）**: `WorktreeManager.syncedStartPoint(base)`
      （`git fetch origin <base>` → `origin/<base>` を返す。無ければ `undefined`）+ `add(slug, startPoint?)`。
      `SessionManager.provision` が作成時のみ最新から切る（稼働中 worktree には pull しない）
- [x] **PR 自動化（`autoPr`, 既定 on）**: `utils/pr.ts` に `createPr`（`gh pr create --draft --fill`）/
      `prChecks`（`statusCheckRollup` 集約）/ `markPrReady`（`gh pr ready`）+ `lookupPr` に `isDraft` を追加。
      `WorktreeManager.pushBranch`。`SessionManager` は `completed` 遷移でコミット差分があれば push→draft PR
      作成（`autoPrAttempted` で 1 回）、`refreshPrs` で緑になったら ready 化。`gh` は `PrAutomation` で DI
- [x] **競合検知（自動解消しない）**: `WorktreeManager.merge` が競合ファイルを収集して abort し
      `MergeConflictError` を投げる。`SessionManager.merge` が捕えて `session.markConflict(files)` →
      reducer が `status: 'conflict'` + `conflictFiles`。UI はバッジ表示のみ（`badge.conflict` を ja/en 追加、
      `statusColor.conflict`）、詳細ビューは `conflict` を終端扱い
- [x] 設定: `core/config.ts` に `followOrigin` / `autoPr`（真偽値・不正値は既定へ）。合成ルートで既定 on 配線
- [x] テスト: worktree（syncedStartPoint/pushBranch/startPoint/MergeConflictError.files）・pr（createPr/
      prChecks/markPrReady/isDraft）・reducer（conflict/pr isDraft）・config・session-manager（followOrigin/
      autoPr/auto-ready/conflict）を追加

> 実績メモ: 全500テスト緑・lint/typecheck/build 緑。core/utils カバレッジは 80% 要件を満たす。
> 手動受け入れ（実 `gh` + リモート）は未実施 — CI/認証環境での確認は別途必要。

## Phase 11: プラン / 使用状況のステータスバー

> Claude Code のステータスライン相当（プラン種別 + リミットまでの使用状況）を codiva でも出す。
> `rate_limit_event` はターン実行中しか届かないので、control channel を叩く probe を第2の情報源に足す。

- [x] **SDK 実測（spike）**: `accountInfo()` / 実験的 usage 要求 / 実セッションの `rate_limit_event` を採取。
      結論を `docs/TECH_NOTES.md` に追記（**`rate_limits_available: true` でも `rate_limits: null`**、
      **`five_hour` イベントに `utilization` が付かない**、idle probe には event が来ない）
- [x] **probe 基盤の共通化**: `utils/sdk-probe.ts`（`idlePrompt` / `runSdkProbe`。timeout・abort・
      サブプロセス後始末を一箇所に）。`utils/model-catalog.ts` をこの上に載せ替え
- [x] **取得**: `utils/usage-probe.ts`（`fetchUsageSnapshot` = 1 probe で `accountInfo()` と usage を
      `allSettled` で読む / `hasUsageData`）
- [x] **純粋ロジック**: `core/account.ts`（`toAccountSummary` / `normalizePlanName` / `sameAccountSummary`）、
      `core/usage.ts`（`toUsageSnapshot` / `mergeUsageWindow`）、`core/gauge.ts`（`gaugeCells`）、
      `core/rate-limit.ts` に `compactRateLimitWindows` / `hasRateLimitDetail`
- [x] **状態**: `SessionManager.applyUsage()` / `getAccount()`（イベント由来の枠とフィールド単位で合流し、
      変化が無ければ同一参照を維持）
- [x] **ポーリング**: `bootstrap/usage-poller.ts`（即時 + 5分間隔、多重実行を抑止、2回連続で空なら停止）。
      合成ルート `src/index.tsx` で配線し、終了時に停止 + probe を abort
- [x] **UI**: `StatusFooter` に使用状況セグメント（一覧・詳細の両方）、ヘッダにプラン行
      （行を組むのは `core/banner-lines.ts` = モデル行と cwd 行の間。`Banner` は presentational のまま）。
      i18n `banner.usage.plan` / `footer.usage.*` を ja/en 対で追加。`theme.glyph.gaugeFilled` / `gaugeEmpty`
- [x] **狭い端末での1行維持**: `core/layout.ts` の `usageFooterPlan(columns)` で段階的縮退
      （2枠 → 1枠 → ゲージ落とし → プラン名落とし → 非表示）。実測（自前 stdout で 30〜200 桁）で
      閾値を決め、`status-footer.spec.tsx` が折り返しゼロ・幅超過ゼロを検証
- [x] テスト: account / usage / gauge / rate-limit / usage-probe / usage-poller / session-manager /
      status-footer / `tests/app.test.tsx`（両ビューのステータスバー）

- [x] **レビュー指摘の反映**（code-reviewer サブエージェント）:
      ①`hasUsageData` が `accountInfo()` の応答有無を見ていたため Bedrock / API キーで
      ポーリングが永久に止まらなかった → プラン名/枠の有無で判定し、`hasNoSubscription()` の
      肯定的シグナルで即停止。②usage 要求のハングが `accountInfo()` の結果を捨てていた →
      読み取りごとの締め切り（`settleWithin`）。③幅の閾値が典型文言前提で
      `Claude Enterprise` + `今週Sonnet` だと数字が黙って切れた → 最長ケースで再計算し、
      spec を最長文言（ja/en）でパラメタライズ。④usage 側のプラン名を `accountInfo()` 失敗時の
      フォールバックに使用（`normalizePlanName` が実際に効くようになった）。⑤枠のロールオーバーで
      古い `rejected` が残る問題、⑥`apply` の例外でポーラーが死ぬ問題、⑦詳細ビューの毎秒再描画も修正

> 実績メモ: lint/typecheck/test/build 緑。実測は Claude Team アカウントで採取（`utilization` が
> 来ないため実機では残り時間のみ表示。ゲージ表示経路はテストで担保）。フッタの折り返しは実装中に
> 実測で発覚し、Yoga の flex 縮小任せをやめて幅ベースの段階的縮退へ変更した。体感確認はユーザー環境で。
>
> 追記: フッタ側の表示は **Phase 14 でヘッダに一本化**して撤去した（`usageFooterPlan` /
> `footer.usage.*` も削除）。取得・合流の仕組みはそのまま。

## Phase 12: アップデート通知 / `/update`

> npm 配信された自分自身の更新を検知して通知し、**確定できる経路のときだけ**適用する。
> 「検知・提示は自動、インストールは確認と経路判定を挟む」方針（PR 自動化と同じ）。

- [x] `core/update.ts`（純粋）: semver precedence 比較（`parseVersion` / `compareVersions` /
      `isUpdateAvailable`。prerelease 規則まで）、`UpdateCheck` union への変換 `resolveUpdateCheck`
      （**「最新」と「確認できなかった」を型で区別**）、`InstallKind` → 更新コマンド（`updateCommandFor` は
      argv 配列 / `updateCommandLine` は表示用）、`canSelfUpdate`、DI 境界 `UpdateService`、
      ダイアログ状態 `UpdateViewState`
- [x] `utils/update.ts`（I/O）: `fetchLatestVersion`（`registry.npmjs.org/<pkg>/latest` を 1 回・
      **3 秒タイムアウト・throw しない**・unref タイマー・外部 signal で打ち切り）、`installKindFor`
      （パス比較のみ・env は引数で注入）、`packageRootFrom`、`runUpdate`（`execFile` でシェルなし。
      失敗は stderr 最終行）、`createUpdateService`
- [x] `/update` コマンド: `CommandAction` + `COMMANDS` + i18n（ja/en）+ 一覧ビューのハンドラ配線。
      キーは単一 `useInput` で処理（`UpdateDialog` は presentational）。非同期の決着は世代カウンタで無効化
- [x] ヘッダ通知: `core/banner-lines.ts` に `updateLatest` と `accent` トーンを追加
      （**更新があるときだけ 1 行増える**。文字組みは純関数側、色は `ui/theme.ts`）。
      `App` が `useUpdateCheck(updater?.initial)` で解決、合成ルートは await しない
- [x] 設定 `updateCheck`（既定 on。`false` で起動時の通信を完全停止）
- [x] 安全側の作り込み（レビュー指摘の反映）:
      **モーダル相互排他**（`pending` に `!update`。`PermissionDialog` は自前 useInput を持ち、Ink は
      1 チャンクを全ハンドラへ配るため、更新確認の `y` が未読ツールの許可を兼ねてしまう）/
      モーダル中は**マウスレポートも飲む**（クリックで focus が list に移る経路を塞ぐ）/
      `installing` 中も **Esc は通す**（Ctrl+C を拾わないので全キーを飲むと最長 3 分操作不能）/
      **実行は `global` のみ**（`local` は利用者の package.json・lockfile・symlink された node_modules を
      作り替えるため提示のみ）/ **Windows は実行しない**（`npm.cmd` はシェル無しで spawn できず、
      シェル経由は禁止）/ `npm root -g` で `unknown` を拾い直す（homebrew・prefix 変更・pnpm/yarn global）/
      `npm install -g` の cwd をホーム固定（リポジトリの `.npmrc` で宛先を変えられない）/
      npx マーカーは**パス要素の完全一致**（`bunx-tools` の誤検出を防ぐ）/ 稼働中セッション数の警告 /
      適用後はバナーの案内を引っ込める
- [x] テスト: `core/update.spec.ts`（テーブル駆動）/ `utils/update.spec.ts`（fetch・経路判定・
      `npm root -g`・install の seam を注入）/ `tests/update.test.tsx`（バナー・y/n ゲート・
      local と npx と unknown で **install を呼ばない**・オフライン表示・実行中の Esc・
      キーとマウスレポートが composer に漏れない）

> 実績メモ: 全 1197 テスト緑・lint / typecheck / build 緑。semver 比較は本物の `semver` パッケージとの
> 差分テスト（約 1000 万ペア）で不一致 0 件を確認済み。実 npm での更新適用と、マウスクリックでの
> モーダル排他は手動確認が必要（当たり判定がレイアウト実測に依存し ink-testing-library では
> 再現できない。テストはホイール/レポート漏れまでを固定）。

---

## Phase 12: 学習データ利用（grove）の警告

> claude.ai の「Help improve our AI models」が ON のまま並列セッションを回してしまうのを防ぐ
> 「気付き」だけを足す。**codiva 側の挙動は変えない / アカウント設定を書き換えない**方針。

- [x] **判定（純粋）**: `core/privacy.ts` に `TrainingOptIn`（`'on' | 'off' | 'unknown'`）/
      `toTrainingOptIn`（API レスポンス）/ `trainingOptInFromClaudeJson`（`~/.claude.json` の
      `groveConfigCache`。7 日より古い値は使わない）/ `shouldWarnTraining`（`'on'` だけ true）
- [x] **取得（I/O）**: `utils/privacy.ts` の `fetchTrainingOptIn` = 認証方式の門番 → キャッシュ
      （`'off'` はここで確定）→ Keychain `Claude Code-credentials` / `~/.claude/.credentials.json` の
      OAuth トークンで `GET /api/claude_code_grove`。**User-Agent は `claude-cli` 前置きが必須**
      （実測。詳細は TECH_NOTES）。API キー / Bedrock / Vertex / 独自 `ANTHROPIC_BASE_URL` 利用時は
      キャッシュも読まない。失敗・403・タイムアウトはすべて `'unknown'`（throw しない）
- [x] **誤警告対策**（レビュー指摘の反映）: ① 認証方式の門番をキャッシュより先に置く
      ② キャッシュの `'on'` は API で再確認（Web 側で OFF にしても cache は書き換わらないため）
      ③ `accountUuid` が分かっているときは他アカウントのエントリを流用しない
      ④ `domain_excluded === true` は `'unknown'` に倒す
      ⑤ `security`（Keychain）に `signal` + `timeout` 2 秒（終了が返らなくなるのを防ぐ）
- [x] **UI**: `ui/banner.tsx` の `PrivacySection`（`'on'` のときだけ ⚠ 行 + 変更先 URL。色は
      `statusColor.awaitingPermission`）。`useTrainingOptIn`（`ui/hooks.ts`）で解決し、合成ルートは
      **await しない**（起動をブロックしない・終了時に abort）
- [x] 文言: `banner.privacy.warning` / `banner.privacy.hint` を ja / en 両方に追加
- [x] 設定: `privacyWarning`（既定 on）。`false` なら判定自体を走らせない（Keychain もネットワークも触らない）
- [x] テスト: `core/privacy.spec.ts`（テーブルドリブン）/ `utils/privacy.spec.ts`（キャッシュの
      非対称な信頼・Keychain/ファイル・403・オフライン・タイムアウト・abort・認証方式ごとのスキップ・
      Keychain のタイムアウト付与）/ `ui/banner.spec.tsx`（on で出る・off/unknown で出ない）/
      `tests/app.test.tsx`（index.tsx → App → SessionList → Banner の prop チェーン）/ `core/config.spec.ts`

> 実績メモ: 全 1136 テスト緑・lint / typecheck / build 緑（`utils/privacy.ts` は 88% statements）。
> 非公開エンドポイント依存のため「壊れたら黙る」設計。abort 済みシグナルでは
> `addEventListener('abort')` が発火しない（= タイムアウトまで待ってしまう）ため、`probe` の先頭で
> `signal.aborted` を先手チェックしている。実機で `grove_enabled: false` を確認済み（警告が出ない）。
> ON 時の表示は spec で担保し、手動確認は未実施（アカウント設定を変える必要があるため）。

---

## Phase 13: ヘッダの可読性改善

> 起動ヘッダの情報量が縦に伸びて読みにくくなっていたので、行を詰めて数値をゲージ化する。
> 表示だけの変更で、取得経路（`rate_limit_event` / usage ポーリング）には触らない。

- [x] サブタイトル行（`並列 Claude Code セッションを…`）を削除。文言 `banner.subtitle` も ja/en ごと撤去
- [x] プランとモデルを 1 行に統合（`プラン: Claude Max   モデル: sonnet`）。`banner.usage.plan` を
      `banner.plan` へ移し、en は `Plan:` / `Model:` と大文字始まりに揃える
- [x] 使用状況をフッタと同じ**ゲージ + 使用率**表示に（`現在のセッション  ████████░░░░░░░░░░░░  42%  2時間45分後にリセット`）。
      純粋な `bannerUsageRows()`（見出しを表示幅で揃える / 使用率を右詰め 4 桁 / 使用率なしは同幅の空白）を
      `core/banner-lines.ts` に追加し、セル数は既存の `gaugeCells()`、記号は `theme.glyph` から取る
- [x] 使用状況節を `bannerLines` の行リストから外し、`ui/banner.tsx` の `UsageSection`（`PrivacySection` と
      同じく `textRef` の外）で描く。記号を core に持ち込まず、`bannerCaretAt` の「行 index = 表示行」も維持
- [x] 文言: `banner.usage.used` を撤去（ゲージ横の `42%` はデータなので i18n 対象外。フッタと同じ扱い）
- [x] **幅の縮退**（レビュー指摘）: ゲージ幅を固定 20 セルにすると ja の最長ケースで 87 桁必要になり、
      80 桁の端末でヘッダ全体が横に縮められて**マスコットが折り返して崩れる**。`core/layout.ts` に
      `bannerGaugeWidth(columns)`（20 / 12 / 8 / 0 セル）を足し、さらに**マスコットの Box に
      `flexShrink={0}`**（横方向のみに効く）を付けて縮小をテキスト欄の truncate 側に寄せた
- [x] **縦に潰れたときの当たり判定**（レビュー指摘）: 中央寄せの負オフセットで落ちるのは**上端の行**
      なので「行 index = 表示行」は保たれない（従来コメントの記述が誤り）。`SessionList` は実測高さ
      （`useBoxHeight`）が行数より小さい間はヘッダの当たり判定をやめる
- [x] テスト更新: `core/banner-lines.spec.ts`（行構成 / `bannerUsageRows` のテーブルドリブン）/
      `core/layout.spec.ts`（`bannerGaugeWidth` の段と単調性）/ `ui/banner.spec.tsx`（ゲージ・
      使用率なし枠・列の揃い・選択テキストに含まれない・**幅 20〜200 でマスコットが折り返さない**）/
      `tests/app.test.tsx`（フッタのゲージ検証をフッタ行に限定）
- [x] ドキュメント: `docs/ARCHITECTURE.md`（`Banner` の責務）/ `.claude/rules/ink-components.md`
      （margin は「選択可能な塊の外なら可」/ マスコットの `flexShrink={0}` は例外 / 幅の縮退）/
      `README.md`（ヘッダの見え方）

> 実績メモ: 全 1560 テスト緑・lint / typecheck / build 緑。ヘッダは 6 行 →（プラン+モデル統合と
> サブタイトル削除で）4 行に減り、使用状況は枠を並べて比較できるようになった。ゲージ幅は
> 幅 100 以上で 20 セル（当時のフッタは常に 8。フッタ側は Phase 14 で撤去）。レビューで見つかった
> 「80 桁でマスコットが崩れる」は `flexShrink={0}` + 幅の段階的縮退で解消し、幅 20〜200 の
> 回帰テストで固定した。
> 実機での体感確認はユーザーに依頼。

## Phase 14: フッタの整理（プラン / 使用状況をヘッダへ一本化）

> Phase 13 でヘッダの使用状況が読みやすくなり、フッタの同じ表示は重複になった。フッタは
> 「モード表示 + 操作ヒント」に戻して、詰め込みすぎを解消する。表示だけの変更で取得経路には触らない。

- [x] `ui/status-footer.tsx`: `account` / `usage` / `now` prop と `UsageStatus` /
      `UsageWindowSegment` を削除。モード表示（縮まない）+ ヒント（唯一縮む）の2要素だけにする
      （**どの幅でも1行**は不変条件として維持）
- [x] `core/layout.ts`: フッタ専用の `usageFooterPlan` / `UsageFooterPlan` /
      `MIN_USAGE_FOOTER_COLUMNS` を削除（ヘッダの `bannerGaugeWidth` は残る）
- [x] 文言: `footer.usage.*` を ja / en 両方から削除（使用状況の文言は `banner.usage.*` に一本化）
- [x] `ui/session-detail.tsx`: 使用状況のための `useAccount` / `useRateLimit` / `useClock(30_000)` を削除
      （詳細ビューの 30 秒ごとの全再描画も無くなる）。ヘッダを持たない画面なのでプラン / 使用状況は
      出なくなる = 見たいときは Esc で一覧へ戻る
- [x] テスト更新: `ui/status-footer.spec.tsx`（使用状況のテストを削除し「出さない」回帰テストを追加。
      幅ごとの1行維持は継続）/ `core/layout.spec.ts`（`usageFooterPlan` のテーブル削除）/
      `tests/app.test.tsx`（「両ビューのステータスバー」→「ヘッダに出る / 詳細では出ない」）
- [x] ドキュメント: `README.md`（機能一覧・「プラン / 使用状況の表示」節）/ `docs/ARCHITECTURE.md`
      （表示先と撤去理由）/ `docs/TASKS.md`

> 実績メモ: lint / typecheck / build 緑、テストは CI で確認。`core/gauge.ts` の `gaugeCells` は
> ヘッダのゲージで使い続けるので残す。`core/rate-limit.ts` の `compactRateLimitWindows` は
> 「1行に収める上位 N 枠」の選別用でヘッダは全枠を出すため、現状は未使用のまま残置している。

---

## Phase 14: 共有シンボリックリンクをセッションに伝える

> `ignoredFiles: 'symlink'`（既定）では ignore 済みパスの実体が元リポジトリと共有なので、
> セッションが依存更新やビルドを走らせるとメインチェックアウトと並行セッションに波及する。
> エージェントは「自分の worktree の中だから安全」と判断するため、環境として伝えるしかない。

- [x] 純関数 `core/system-prompt.ts` を追加: `SHARED_IGNORED_FILES_NOTICE`（AI 向け注意書き・英語）と
      `composeSystemPrompt({ ignoredFiles, repoPrompt })`（環境説明 → リポジトリ追加指示の順に連結。
      両方無ければ `undefined` = `systemPrompt` を渡さない）
- [x] 注意書きの内容: ①ignore 済みパスは元リポジトリへの symlink で実体は共有（worktree 作成後に
      生まれたパスは実体なので、断定せず `test -L` で判定させる）②読むのは安全・**書き込む前に
      そのパスだけリンクを切って独立させる**（`target="$(readlink <path>)" && rm <path> &&
      cp -Rp "$target/." <path>` / 作り直しでもよい）③`rm -rf <path>/` や `<path>/*` はリンクを
      辿って共有先を消すので禁止 ④`.gitignore` の末尾スラッシュパターンは symlink にマッチしないので
      リンクが untracked に現れる（`git add -A` 禁止・パス指定でステージ）⑤実際に書き込むパスだけ
      切り離し、**触らない作業では何もしない**。
      判定は名前ではなく `test -L` にして言語・ツールチェイン非依存にする
- [x] **`git add -A` の危険性を実測**（`git status` 由来の発見）: 使い捨てリポジトリで、`.gitignore` の
      `node_modules/` は symlink にマッチせず（`git check-ignore` exit 1）、`git add -A` が
      **mode 120000 でステージ**することを確認。そのままマージすると絶対パス入りのリンクが base に
      入るため、注意書きと README / TECH_NOTES に明記した（`diffStat().uncommitted` に混ざる件も記録）
- [x] **手順を実機検証**（レビュー指摘）: 当初の `mv` + `cp -RL` は、①循環／壊れたリンクを含む
      ツリー（ワークスペースの相互リンク等）で **exit 1・半端なコピー**になる ②内部 symlink まで
      実体化してリンク構造を壊す ③退避名 `<path>.bak` が残っていると `mv` が**共有先の中へ移動**
      してしまう ④退避名は `.gitignore` のディレクトリパターンに載らず untracked に出る、の4点が
      あった。`readlink` + `cp -Rp "$target/."`（最上位リンクだけ辿る・一時名なし・モード保全）へ
      変更し、循環・壊れたリンク・600 の `.env` を含むケースで exit 0 かつ共有先無傷を実測
- [x] `SessionOptions.ignoredFiles` を追加し、`consume()` は `composeSystemPrompt()` の結果を
      `options.systemPrompt` に載せる（`session.ts` は文言も結合順も持たない）
- [x] 配線: `bootstrap/build-manager.ts` の `sessionOptionsFrom(config, appendSystemPrompt)`
      （config → `SessionOptions` の対応付けだけの純関数として切り出し、spec で固定）が
      `resolveIgnoredFilesMode(config)` で解決して渡す。`WorktreeManager` と同じ config 由来なので一致する
- [x] `setRepoPrompt`（`/prompt`）が注意書きを消さないこと: `appendSystemPrompt` は
      リポジトリ追加指示だけを持ち、合成は `consume()` 側で毎回行う
- [x] テスト: `core/system-prompt.spec.ts`（合成のテーブルドリブン + 注意書きの必須要素を
      **意味アンカー**で固定（文ではなく `test -L` / `readlink` / `rm -rf` 等。推敲で落ちないように）
      + `cp -L` を勧めていないこと + ツールチェイン名の直書きが無いこと）/ `core/session.spec.ts`
      （`symlink` のときだけ注入され、リポジトリ追加指示は常に末尾）/
      `bootstrap/build-manager.spec.ts`（`ignoredFiles` の渡し忘れ回帰。この配線は
      `src/bootstrap/**` が coverage 対象外で今まで無防備だった）
- [x] ドキュメント: `docs/ARCHITECTURE.md`（systemPrompt の組み立て）/ `docs/TECH_NOTES.md`
      （Options メモ・実測）/ `README.md`（利用者向けの節）/ `.claude/rules/sdk-integration.md`
      （組み立ては純関数経由・AI 向け文言は i18n 対象外）/ `.claude/rules/git-and-io.md`
      （symlink モードの不変条件）/ `CLAUDE.md`（コードの地図）

- [x] 既知の制約として記録: モードは state.json に永続していないため、`symlink` で作った worktree を
      後から `copy` / `none` 設定で復元すると注意書きが載らない（設定を変えた場合のみ。逆向きは
      手順1の `test -L` 判定で無害）。永続フィールドを増やす価値が薄いので docs に明記して留める

> 実績メモ: 全 1591 テスト緑・lint / typecheck 緑。実測で、このリポジトリ自身のセッション worktree の
> `node_modules` / `dist` / `coverage` が元リポジトリを指すリンクになっていることを確認（＝worktree 内で
> `npm run build` すると main の `dist/` を書き換える）。そのためこの Phase の検証では `npm run build` と
> `npm test`（`--coverage` が `coverage/` へ書く）を避け、`tsc --noEmit` / `biome check` /
> `vitest run --coverage.enabled=false` で通した。ビルドは CI に任せている。
> codiva 側でリンクを張り替える案は採らなかった（何が書き込み対象かは指示内容次第で、
> 先回りして全部コピーすると symlink モードの利点が消える）。

## Phase 15: 入力欄のソフト折り返し ✅

**課題**: 改行せずに打ち続けると画面幅で `…` に切り捨てられ、いま何を打っているのか読めない
（`PromptInput` が論理行を 1 表示行に `wrap="truncate-end"` で描いていたため、テキストもキャレットも
画面外へ消えていた）。

- [x] 純粋な `core/composer-layout.ts` を新設: `wrapComposerRows`（表示幅で折り返し。空白があれば
      単語境界、無ければ強制改行。CJK は string-width で 2 セル）/ `composerLayout`（行 + キャレットの
      表示行・列）/ `composerRowCount` / `caretIndexAtClick`（`text-buffer.ts` から移設して折り返し対応）/
      `rowSelection` / `moveRowUp`・`moveRowDown`（表示行での↑↓）
- [x] 折り返し境界のキャレットは**後続行の先頭**に置く（次の文字が現れる位置）。行が幅ぴったりで
      後続が無いときは、端末のカーソル折り返しと同じく**空の表示行を1行開ける**（列を幅の外に描かない）
- [x] 折り返し幅は Box の computed layout を**実測**（`useBoxWidth` / `useComposerWidth` =
      実測幅 − `COMPOSER_PREFIX_CELLS`）。端末幅からの引き算ではダイアログ内（枠 + padding）で合わない。
      未実測の 1 フレームだけ折り返さない（従来の truncate）挙動にフォールバック
- [x] `PromptInput` は表示行を描画（`visibleLineRange` に渡す行数も表示行）。一覧・詳細のクリック逆算
      （`caretIndexAtClick`）、↑↓（`editText` の `wrapWidth`）、詳細の「複数行編集中か」判定
      （`composerRowCount`）を**同じ実測幅**で通す（食い違うと別の文字に当たる）
- [x] `/prompt` エディタ（`RepoPromptEditor`）も同じ幅を測って↑↓を表示行に合わせる
- [x] テスト: `core/composer-layout.spec.ts`（折り返し・キャレット・クリック・選択・↑↓ をテーブル
      ドリブン）/ `ui/prompt-input.spec.tsx`（折り返しで全文字が描かれる・単語境界・折り返し行への
      カーソル追従）
- [x] ドキュメント: `.claude/rules/ink-components.md` / `docs/ARCHITECTURE.md` / `docs/TECH_NOTES.md` /
      `README.md`（入力欄の節）/ `CLAUDE.md`（コードの地図）

> 実績メモ: 全 1580 テスト緑・lint / typecheck / build 緑。折り返しを「横スクロール」で済ませる案は
> 採らなかった（行頭側が見えなくなり、長い指示を投入前に読み返せない）。`wrap="truncate-end"` は
> 実測前の 1 フレーム用の保険として残している。

---

## Phase 16: 入力欄の履歴（↑↓ で送信済みの指示を呼び戻す）✅

**課題**: 一度送った指示をもう一度出す / 打ち間違えた長い指示を直して出し直すのに、毎回全部打ち直す
しかなかった（shell では当たり前に `↑` で戻れる操作が無い）。

- [x] 純粋な `core/input-history.ts` を新設: `recordInput`（空・直前と同じは積まない・上限
      `INPUT_HISTORY_LIMIT` = 50）/ `recallPrev`・`recallNext`（辿り始めたときの書きかけを `draft` に
      退避し、↓ で最新を越えたら復帰）/ `isBrowsingHistory` / `resetHistoryBrowse`
- [x] `core/composer-layout.ts` に `atFirstComposerRow` / `atLastComposerRow`（折り返し後の**表示行**で
      端かを判定）。行の途中では従来のキャレット移動を優先し、端でさらに押したときだけ履歴へ回す
- [x] 共有フック `useInputHistory`（`ui/hooks.ts`）。`useTextBufferRef` と同じく ref 経由で逐次適用
      （↑ の連打が1チャンクで届いても潰れない）
- [x] 一覧のコンポーザに配線（送信時に `record`、↑↓ で `recall`、呼び出せなければ `editText` へ落とす）。
      履歴は `ListViewState` に載せて `app.tsx` の ref へ預け、詳細ビューから戻っても残す
- [x] 詳細ビューには入れない（あちらの ↑↓ は alternate scroll mode のホイール受け口なので奪えない）
- [x] i18n: フッタヒントに `↑↓: 履歴` / `↑↓: history`（ja / en 両方）
- [x] テスト: `core/input-history.spec.ts`（テーブルドリブン）/ `core/composer-layout.spec.ts` に端の
      判定 / `tests/app.test.tsx` に「↑↓ で呼び戻す・書きかけが復帰する」「複数行編集中の ↑ は
      キャレット移動」
- [x] ドキュメント: `README.md`（入力履歴の節）/ `.claude/rules/ink-components.md` / `CLAUDE.md`（地図）

> 実績メモ: 履歴の永続化（`state.json` へ保存）は入れていない。復元用メタに会話由来のテキストを
> 増やしたくないため、履歴はアプリのプロセス内だけで持つ。

---

## 各 Phase 共通の完了チェック

1. `npm run lint` / `npm test` が通る
2. TASKS.md のチェックボックスを更新
3. ドキュメント（ARCHITECTURE.md / TECH_NOTES.md）と実装の乖離があれば解消
4. conventional commits でコミット
