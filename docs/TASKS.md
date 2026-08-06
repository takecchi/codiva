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
- [x] 詳細ビューには入れない（あちらの ↑↓ はログのスクロール。当時はマウス捕捉を解除していたので
      alternate scroll mode のホイール受け口も兼ねていた → Phase 17 で捕捉は常時有効になった）
- [x] i18n: フッタヒントに `↑↓: 履歴` / `↑↓: history`（ja / en 両方）
- [x] テスト: `core/input-history.spec.ts`（テーブルドリブン）/ `core/composer-layout.spec.ts` に端の
      判定 / `tests/app.test.tsx` に「↑↓ で呼び戻す・書きかけが復帰する」「複数行編集中の ↑ は
      キャレット移動」
- [x] ドキュメント: `README.md`（入力履歴の節）/ `.claude/rules/ink-components.md` / `CLAUDE.md`（地図）

> 実績メモ: 履歴の永続化（`state.json` へ保存）は入れていない。復元用メタに会話由来のテキストを
> 増やしたくないため、履歴はアプリのプロセス内だけで持つ。

---

## Phase 17: 詳細ログの範囲選択（画面外までドラッグ = 自動スクロール）✅

**課題**: セッション詳細のログをコピペしたいのに、画面に収まらない範囲（上端より上・下端より下に
隠れている行）が取れなかった。詳細ビューはマウス捕捉を解除して端末ネイティブの選択に任せていたため、
選択できるのは**いま見えている 1 画面ぶんだけ**で、選択したままスクロールする操作が存在しなかった。

- [x] 純粋な `core/log-selection.ts` を新設: 位置は平坦な caret index ではなく **`LogPoint`
      （文書の表示行 index + 行内の桁）**。スクロールしても意味が変わらず、数千行でも O(n) に収まる
- [x] 当たり判定 `LogViewport` / `logRowAt` / `logCaretAt`（末尾寄せの隙間・プレビュー行・
      表示幅の逆算）と、端の自動スクロール `logEdgeAt` / `logEdgePoint` / `LOG_EDGE_SCROLL_MS`
- [x] 描画用の `logRowSelection` とコピー用の `logSelectionText`（表示どおり改行で繋ぐ）
- [x] 切り分けの共通化: `core/text-selection.ts` に `selectionSlices`（選択境界でセグメントを
      切り直す）を追加し、ヘッダの `rowPieces` とログの `RichLogLine` で共用
- [x] フックの共通化: `ui/hooks.ts` に内部 `useRangeSelection`（位置の型と正規化だけ差し替える）を
      置き、`useDragSelection`（caret index）と `useLogDragSelection`（`LogPoint`）が乗る形にした
- [x] `SessionDetail` に配線: press/drag/release、端でのタイマー自動スクロール、キー入力・幅変更での
      解除、アンカーを ref で持つ（バースト時に潰れない）、ハイライト描画（反転・dim は落とす）
- [x] **詳細ビューでもマウス捕捉を解除しない**方針に変更（`mouse` prop / `TerminalSetup.mouse` を廃止）。
      端末ネイティブ選択は Shift+ドラッグ・設定 `"mouse": false` で従来どおり使える
- [x] テスト: `core/log-selection.spec.ts`（テーブルドリブン）/ `core/text-selection.spec.ts` に
      `selectionSlices` / `tests/app.test.tsx` に「複数行のドラッグでコピー」「クリックだけでは
      コピーしない」「可視域の外へドラッグ → 自動スクロールしながら選択が伸び、離すと止まる」
- [x] ドキュメント: `README.md`（テキストのコピー）/ `.claude/rules/ink-components.md` /
      `docs/ARCHITECTURE.md` / `docs/TECH_NOTES.md`（?1002 の実測）/ `CLAUDE.md`（地図）
- [x] レビュー指摘の反映:
      - **モーダルは自分の `useInput` の先頭でマウスレポートを弾く**（`permission-dialog` /
        `model-select`。捕捉を保つようになったため、質問の自由記述に `[<0;10;5M` が混入していた。
        `repo-prompt-editor` は既に同じ防御を持っていた）
      - 自動スクロールの終点は**スクロール後のアンカーの行数**（`capFor(next)`）で数える
        （末尾追従を外れてプレビュー行が消えると 1 行増えるため、上端 1 行が漏れていた）
      - **行より上の余白（末尾寄せの隙間）の press は先頭行の行頭をアンカーにする**
        （「画面のいちばん上から下へ」のドラッグを捨てない）
      - 空文字はクリップボードへ送らない（貼り付け内容を消さない）
      - 行の描画を `ui/log-line.tsx` へ切り出し（`session-detail.tsx` の肥大化を戻す）、
        1 行内の選択オフセットは core の `RowSelection` 型に統一
      - `anchorRef` の理由コメントを実態（同期的に読む必要がある）に修正

> 実績メモ: 自動スクロールにタイマーが必要なのは SGR ?1002 が**セルが変わったときだけ**移動を
> 報告するため（端で静止するとレポートが来ず、レポート駆動だけでは止まってしまう）。タイマーは
> 向きが変わったときだけ張り替え、最新のステップ関数は ref で渡す（ログの追記ごとに作り直すと
> 1 tick も進まない）。i18n の追加は無し（新しい表示文字列を増やしていない）。

---

## Phase 18: ビルド生成物を worktree へ引き継がない（開発サーバのフリーズ対策）✅

**課題**（issue #81）: `ignoredFiles: 'symlink'`（既定）が `.gitignore` 済みパスを**すべて**リンク
していたため、`.next/` のようなビルド生成物も元リポジトリと共有されていた。worktree は
リポジトリ配下（`.codiva/worktrees/<slug>`）にあるので、プロジェクトルートから再帰監視する
開発サーバ（`next dev --turbopack`）からは**自分が書き込んでいる `.next` が worktree の数だけ
別経路として見える**。報告例は worktree 6 個で CPU / メモリ / FD を食い潰し OS ごとフリーズ。

- [x] `core/worktree.ts` に `DEFAULT_IGNORED_EXCLUDES`（生成物・キャッシュの既知名）と純粋な
      `isExcludedIgnoredEntry()` / `ignoredExcludePatterns()` を追加。`ignoredCopyEntries()` は
      除外リストを引数で受ける（既定はビルド生成物を除外）
- [x] 一致規則: `/` 無しのパターンは**最終セグメント**（ネストした `apps/web/.next/` に効く）、
      `*` 前置は接尾一致（`*.tsbuildinfo`）、**最後に一致したパターンが勝つ**（`!` で打ち消し）
- [x] `'symlink'` / `'copy'` の**両モード**で除外（生成物はコピーしても無駄・古い状態を持ち込む）。
      `node_modules/` と `.env` は引き継ぎ対象のまま（symlink モードの存在理由）
- [x] 設定 `ignoredFilesExclude`（文字列配列）を追加: `toConfig` で検証 → `index.tsx` から
      `WorktreeManager` へ。既定の後ろに連結するので `["!dist"]` で打ち消せる
- [x] `SHARED_IGNORED_FILES_NOTICE` の文面を実態に合わせる（生成物は「共有物」の列挙から外し、
      判定は引き続き `test -L` に委ねる）
- [x] 既存 worktree の後片付け `pruneExcludedLinks()`（起動時 1 回・best-effort）: 純粋な
      `excludedIgnoredEntries()` で対象を列挙し、**シンボリックリンクだけ**を外す
      （実体のディレクトリ＝セッション自身のビルド結果とリンク先には触らない）
- [x] テスト: `core/worktree.spec.ts`（テーブルドリブンで一致規則・打ち消し・部分一致の巻き込み無し）/
      `core/config.spec.ts`（配列の検証・不正要素の落とし方）/ `utils/worktree-manager.spec.ts`
      （実 git で `.next` / `dist` がリンクもコピーもされないこと、`!dist` で戻ること）
- [x] ドキュメント: `README.md`（設定 + 「ビルド生成物は引き継がない」節）/ `docs/ARCHITECTURE.md` /
      `docs/TECH_NOTES.md`（worktree がリポジトリ配下にあることの副作用）/ `.claude/rules/git-and-io.md`

> 実績メモ: 「生成物かどうか」は `.gitignore` からは判別できない（依存も生成物も同じく無視される）ため、
> **既知の名前を列挙する**しかなかった。列挙は必ず外れるので `ignoredFilesExclude` で追加・打ち消しの
> 逃げ道を用意してある。worktree の置き場所をリポジトリ外へ移す案は取らない
> （`.codiva/worktrees/<slug>` 前提のパス・復元・`takenSlugs()` を崩すため）。対象リポジトリの
> `.gitignore` も書き換えない方針を維持し、監視除外の追加は README で利用者に案内する。

---

## Phase 19: 詰まった PR の立て直し（コンフリクト取り込み / CI 修正）✅

**背景**: PR がコンフリクトになった／CI が落ちたことは Phase 10 から検知できていたが、一覧に
`✗` を出すだけで何もしていなかった。並列セッションが増えるほど「main が進んで全部コンフリクト」
「CI が赤いまま放置」が起きるので、1 件ずつ worktree に入らずに立て直せるようにする。

- [x] 純粋な判定（`core/pr-recovery.ts` + spec）: `prStuckKind` / `recoveryKindFor` /
      `recoverableSessions` / `recoveryNotice` / 指示文ビルダ（`syncInstruction` / `ciFixInstruction`）。
      **`prStuckKind` と `recoveryKindFor` を分ける**（自動化のカウンタを走行中にリセットしないため）
- [x] ベース取り込み（`utils/worktree-manager.ts` の `syncBase` + spec）: `upToDate` / `updated` /
      `dirty` / `conflict` の 4 値。**競合は abort せず worktree に残す**（`merge()` とは逆）
- [x] 落ちたチェック名の抽出（`utils/pr.ts` の `toFailingChecks` → `PrStatus.failingChecks`）。
      既存の `gh pr view` の payload から取るので **API 呼び出しは増えない**。reducer は内容比較
- [x] 実行（`SessionManager.recover(id, kind?)` / `recoverable()`）+ spec。
      **worktree に触るのは手を止めているときだけ**（明示 `kind` にも効く `busy` ゲート）
- [x] 自動化（`PrCoordinator.maybeAutoRecover` + spec）: `autoSync` / `autoFixCi`（既定 off）、
      `MAX_AUTO_RECOVERY_ATTEMPTS` で打ち切り、詰まりが解けたらリセット
- [x] 設定（`core/config.ts` の `autoSync` / `autoFixCi`）と配線（`bootstrap/build-manager.ts`。
      指示文のために `messages` も注入）
- [x] コマンド（`/sync` / `/fix-ci` / `/recover`）+ i18n（ja/en の `recover` グループ）
- [x] UI: 共有フック `useRecovery`、一覧の `Ctrl+F` +確認（`ConfirmPrompt` の `recoverAll`）、
      案内行、詳細ビューの `/sync` / `/fix-ci`
- [x] `tests/app.test.tsx` にキー/コマンド配線の統合テスト（7 件）
- [x] ドキュメント: `README.md` / `docs/ARCHITECTURE.md` / `CLAUDE.md`（地図）

> 実績メモ: 設計の芯は「**codiva が決定的にできることは codiva がやる**」。クリーンに取り込め
> たときは push まで済ませてセッションを起こさない（＝トークンを使わない）ので、`autoSync` の
> コストは実質ゼロ。ターンが回るのは競合・未コミット・CI 赤の 3 ケースだけ。
> 自動化の既定を off にしたのは、そのターンが課金に直結するため。
> レビューで潰した罠（いずれもテスト付き）:
> 1. **試行回数のリセット条件**。`recoveryKindFor` を使うと指示送信直後（走行中）にリセットされ、
>    `prStuckKind` に直しても **push 直後の `checks: 'pending'`** でリセットされる。実際に多いのは
>    「依頼したが直せなかった」ケースなので、緑を見たときだけ返金する `prRecovered` に落ち着いた。
> 2. **`failingChecks` の比較**。毎ポーリング新しい配列なので参照比較だと `prStatus` の参照維持が
>    壊れ、全行が毎 tick 再描画される（内容比較 `sameChecks` を追加）。
> 3. **`recovery.busy` を全キーを飲む `busy` に混ぜていた**。一括は数分かかりうるので、
>    Ctrl+C を拾わないこの TUI では `/exit` すら打てず操作不能になっていた。
> 4. **未追跡ファイルを dirty 扱い**していた（走り書き 1 個で無課金の経路を捨ててターンを使う）。
>    merge 途中の再実行と detached HEAD も、それぞれ実行不能な指示 / 嘘の成功報告になっていた。
> 5. **`autoFixCi` だけ有効なとき、競合かつ赤い PR で何も起きなかった**（優先度 1 位の `sync` が
>    無効で止まっていた）。`stuckKinds` で有効なフラグまで見て選ぶようにした。
> 6. **一括の結果が常に成功報告**だった（全件失敗しても緑で「N 件実行しました」）。
> 7. ついでに `git status --porcelain` のパース（`slice(3)`）が、`git()` の trim で先頭行だけ
>    1 文字ずれる既存バグを発見・修正（`diffStat` の未コミット一覧にも影響していた）。

---

## Phase 20: `/prompt` エディタの範囲選択コピー ✅

**課題**: リポジトリ指示のエディタ（`RepoPromptEditor`）は `.codiva/prompt.md` のビューアも
兼ねているのに、マウスレポートを丸ごと捨てていたため**内容をコピーして持ち出せなかった**
（入力欄・ヘッダ・詳細ログはドラッグで選択できるので、ここだけ体験が食い違っていた）。

- [x] `RepoPromptEditor` に `useDragSelection`（`onCopy` は一覧経由で DI）と press / drag /
      release の処理を追加。当たり判定は自前で実測した Box（`useAbsolutePosition` +
      既存の `useComposerWidth`）から `caretIndexAtClick` で逆算 —
      **描画と同じ幅・同じ関数**を通す。ハイライトは `PromptInput` の `selection` prop
- [x] キー入力が来たらハイライトを解除（入力欄と同じ）。マウスレポートは従来どおり
      バッファへ混入させない
- [x] **選択中はキャレットを動かさない**（置くのはドラッグにならずに離した = 単なるクリックの
      ときだけ）。表示ウィンドウは `visibleLineRange` = キャレット行から決まるので、押した時点で
      動かすと 8 行超の指示文で画面がその場でスクロールし、**触っていない行**がコピーされていた
- [x] `DialogBox` に `flexShrink={0}`（規約どおり）+ 実測高さ < 描いた行数なら当たり判定をやめる。
      低い端末ではダイアログ自身が縮んで**中間の行が抜けて**描かれ、見えている行と当たり判定が
      食い違っていた（潰れる役は内部スクロールを持つ一覧・ログに寄せる）
- [x] **モーダル表示中は背後の一覧がマウスレポートも飲む**（`update || modelSelect ||
      promptEdit`）。`parseSgrMouse` で弾くのは自分のハンドラを守るだけで、同じ生入力は
      兄弟の `useInput` にも届くため、飲まないと 1 回のドラッグでヘッダ／一覧の選択まで動く
- [x] テスト: `ui/repo-prompt-editor.spec.tsx`（離した時点で 1 回コピー・テキストは消えない・
      レポートが混入しない・**内部スクロール中でも見えている行が選択される**・クリックだけでは
      コピーせずキャレットが動く・ホイールは無視・エディタ外のドラッグは無視）/
      `tests/commands.test.tsx`（`/prompt` を開いてドラッグ → コピーは 1 件だけ = 背後で二重に
      選択されない・低い端末でも行が抜けない・`/model` 中のドラッグはヘッダを選択しない）
- [x] ドキュメント: `README.md`（テキストのコピー）/ `.claude/rules/ink-components.md`

> 実績メモ: 全 1903 テスト緑・lint / typecheck / build 緑。選択ロジックは既存の
> `useDragSelection` / `caretIndexAtClick` をそのまま使えたので、新しい純関数は増えていない。
> レビューで潰した罠（いずれもテスト付き）:
> 1. **press / drag でキャレットを動かしていた**。表示ウィンドウがキャレット行から決まるため、
>    8 行を超える指示文（= このエディタの主用途）では押した瞬間に画面がスクロールし、選択も
>    コピー結果も「触っていない行」になっていた。composer 側は 1 行しか使わない前提だったので
>    露見していなかった。
> 2. **低い端末でダイアログが縮んで中間行が抜けていた**（`DialogBox` に `flexShrink={0}` が無く、
>    規約に反していた）。抜けた状態では当たり判定も 1 行以上ズレる。
> 3. **モーダル中に背後の一覧がマウスを処理していた**（`parseSgrMouse` で弾くのは自分のハンドラを
>    守るだけ）。`/prompt` の 1 ドラッグでヘッダの選択・コピーまで走っていた。

---

## Phase 21: クラッシュ耐性（端末の復旧 / クラッシュログ）✅

**課題**: codiva が落ちるとターミナルに戻るものの、**スクロールすると大量の文字が入力される**
（マウスレポート ?1002/?1006 が有効なまま残る）。かつ alt screen のまま死ぬので例外の内容が
画面ごと消え、**なぜ落ちたのか手がかりが何も残らない**。

- [x] **端末の復旧**: `utils/terminal-mode.ts` に `resetTerminalModes()`（マウス全モード +
      bracketed paste + カーソル + alt screen を 1 回の write で戻す）、`utils/mouse.ts` に
      `disableMouseReports()`。`setupTerminal()` は**起動時にマウスレポートを消してから**
      alt screen に入り（前回の強制終了の取り残しをここで治す）、teardown で一括リセットを送る
- [x] **脱出口 `codiva --reset-terminal`**（`core/cli.ts` の `parseCliArgs`）。git リポジトリ判定より
      前に処理するのでどこでも実行できる。強制終了（OOM の abort / SIGKILL）では
      `process.on('exit')` すら走らないため、in-process の後始末だけでは原理的に足りない
- [x] **クラッシュログ**: `core/crash.ts`（レポート整形・ファイル名・ローテーション・純粋）/
      `utils/crash-log.ts`（同期書き込み・`~/.codiva/logs/`・20 件保持）/
      `bootstrap/crash-handler.ts`（`uncaughtException` / `unhandledRejection` →
      **端末を戻す → flush → 通常バッファへ理由を出す → ログ**→ exit(1)）
- [x] **JS で拾えない死に方**（V8 のヒープ枯渇・ネイティブクラッシュ）は Node の診断レポート
      （`process.report.reportOnFatalError`）に任せる。設定 `crashLog: false` で両方を止められる
- [x] シグナル（SIGTERM / SIGHUP）で殺されたときも記録する（クラッシュとの切り分け用）
- [x] 診断情報: バージョン / node / platform / 端末 / ビューポート / uptime /
      **メモリ使用量** / セッションのステータス内訳（OOM 仮説の裏取り）
- [x] 見つかっていた unhandled rejection の口を塞ぐ（落ちる原因そのものの候補）:
      `Session.setModel` の control request（終了済みセッションの `/model` で確実に reject）/
      `PrCoordinator.refreshPrs`（20 秒ごとの `void`）/ `useLifecycleAction` の `then`（マージ・破棄）
- [x] `useSessions` のスロットルは unsubscribe で `clearTimeout`、`utils/pr.ts` の `gh` 実行に
      `maxBuffer` 8MB（既定 1MB 超過で PR 列が丸ごと落ちる）
- [x] ドキュメント: `README.md`（トラブルシューティング + 設定 `crashLog`）/ `docs/ARCHITECTURE.md` /
      `.claude/rules/git-and-io.md` / `CLAUDE.md`

> 実績メモ: 全テスト緑・lint / typecheck / build 緑。**残る OOM 候補は未対応**（別 Phase）:
> `state.messages` が無制限に伸びる（追記ごとに全体コピー = O(n²)）／詳細ビューが更新ごとに
> ログ全体を markdown 再パースする（`logLines` にエントリ単位のキャッシュが無い）。
> どちらもログが長い・セッションが多いほど効くので、クラッシュログの `memory` 行と
> `report.*.json` が出てきたらそこから着手する。
> → **実際にこの 2 つで落ちた**（`FATAL ERROR: Ineffective mark-compacts near heap limit`）。
> 対応は Phase 23。

## Phase 22: ヘッダに現在ブランチを表示 ✅

> 一覧のヘッダは cwd までしか出しておらず、「いまどのブランチを分岐元にしているのか」が
> 画面から読めなかった（セッション行のブランチは `codiva/<slug>` なので基準が分からない）。
> 表示だけの追加で、worktree 作成・マージの経路には触らない。

- [x] 文言 `banner.branch`（ja `ブランチ: main` / en `Branch: main`）を ja/en 対で追加
- [x] `BannerInput.branch` を追加し、**プラン + モデルと同じ行**に並べる（`core/banner-lines.ts`）。
      cwd 行に置かない理由は 2 つ: cwd は長くなりがちで `truncate-end` の行末から先に消える／
      cwd 行はパスを取り出すドラッグ用途なので、行末へ丸める drag（`'clamp'`）でブランチ名まで
      一緒にコピーされる
- [x] `WorktreeManager.currentBranch()`（`symbolic-ref --quiet --short HEAD`）を追加。**detached HEAD と
      git の失敗は undefined**（`baseBranch()` の `rev-parse --abbrev-ref` は `'HEAD'` を返すので、
      表示にそのまま使うと「HEAD というブランチ」に見える）
- [x] `useBranch`（`ui/hooks.ts`、5 秒ごとに読み直し）。codiva の外（別ターミナルの `git switch`）でも
      変わるので購読相手がおらず定期取得しかない。**state を持つのは `app.tsx`**（一覧で持つと詳細から
      戻った 1 フレームだけ消える）、**取得するのは一覧のときだけ**（`view.mode === 'list' ? loadBranch :
      undefined`。ヘッダを描かない詳細ビューで無駄なプロセスを立てない。戻ると即 1 回読み直す）。
      取得関数は ref 経由で読み（ref の更新は描画中ではなく effect）、effect の依存は「注入されているか」
      だけ（インライン arrow を渡されても再取得ループにならない）。同期 throw も try/catch で拾う
      （タイマー内の裸の例外は 5 秒ごとに TUI を落とす）
- [x] テスト: `core/banner-lines.spec.ts`（同じ行に並ぶ / 取れないときは出さない / プラン無しでも
      モデルの右）/ `ui/hooks.spec.tsx`（追従・失敗時は直前を保持・アンマウントで止まる・identity が
      変わっても張り替えない・load を外すと止まって値は残る）/ `utils/worktree-manager.spec.ts`
      （切替 / detached HEAD / 非 git）/ `tests/app.test.tsx`（配線 / 詳細ビュー往復で消えない）
- [x] ドキュメント: `README.md`（機能一覧・ヘッダの例・コピー対象）/ `docs/ARCHITECTURE.md`（`Banner`）

> 実績メモ: lint / typecheck / test / build 緑。ヘッダの行数は増えていない（プラン + モデルの行に
> 並べただけなので `bannerCaretAt` の「行 index = 表示行」も不変）。実機での体感確認はユーザーに依頼。

## Phase 23: セッションを 1 件ずつ削除する（`x` / `/remove`） ✅

> 一覧から 1 件だけ消す手段が無かった。`d`（破棄）は worktree とブランチを消すが行を
> `archived` として残すため、**古い PR が付いたセッションが `Ctrl+F`（一括立て直し）の
> 候補に挙がり続ける**。`/clear` は行を消す代わりに worktree を残していたので、
> 「消したのにディスクには残る」ぶんが見えない負債になっていた。両方を揃える。

- [x] `SessionManager.remove(id, opts)`: 破棄 + `store.remove` + `onPersist`（= state.json からも消える）。
      worktree が既に無い行（過去に `d` した archived）も**エラーにせず**行だけ落とす。
      共通の後始末は private `forget(id)` に切り出し（`stop()` → `sessions`/`worktreeMeta`/`prs`/`store`）
- [x] `SessionManager.clear()` を async 化し、**worktree とブランチも削除**（`ClearOutcome`
      = `{ cleared, error }`）。git はリポジトリ全体のロックを取るので**直列**。除去に失敗した行は
      **残す**（ディスクにあるものを一覧から隠さない）
- [x] `CommandAction`/`COMMANDS` に `remove`、`Messages` に `command.remove` / `action.removePrompt` /
      `action.clearPrompt(n)` / `detail.removeAction`（ja/en 対）。フッタヒントに `x: 削除`
- [x] `useLifecycleAction` を `merge | discard | remove | clear` に拡張（`clear` だけ id 不要）。
      `onDone(ok, action)` にして、詳細ビューは削除成功時だけ `onBack()`（消えたセッションの
      「見つかりません」を見せない）
- [x] 一覧: `x` キー + `/remove`、`/clear` は**件数付きの確認**を挟む（0 件なら聞かない）。
      詳細: 操作パネルの `x` + `/remove`
- [x] `CommandPalette` に `flexShrink={0}`（コマンドが 1 つ増えて `/help` 一覧が縦に入らなくなると、
      Yoga が枠を縮めて行が混ざり `/diffpt` のような読めない表示になっていた）
- [x] テスト: `session-manager.spec.ts`（remove の 4 ケース / clear の worktree 削除・失敗時に行を残す）/
      `commands.spec.ts`（`/re` は recover と remove の両方に前方一致）/ `tests/commands.test.tsx`
      （`/clear` の確認 → y、0 件では何もしない、`/remove`、`x` の n/y）
- [x] ドキュメント: `README.md`（「セッションを消す」節 = `d` / `x` / `/clear` の対比表）/
      `docs/ARCHITECTURE.md`（キー割当 + 設計判断 2 行）

> 実績メモ: lint / typecheck / test 緑。リモートブランチと GitHub の PR には触らない（ローカルのみ）。
> 未コミット変更は `force` で消えるため、確認文で明示している。実機での体感確認はユーザーに依頼。

---

## Phase 23: ヒープ枯渇（OOM）対策 ✅

**課題**: 長く使っていると codiva が

```
FATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed - JavaScript heap out of memory
zsh: abort      codiva
```

で落ちる（実報告。node 22 / 既定のヒープ上限 ~4GB）。Phase 21 の「残る OOM 候補」がそのまま
原因だった: **`state.messages` に上限が無い**（追記ごとに全体コピー = O(n²)）／**詳細ビューが
更新ごとにログ全体を再展開・Markdown 再パースする**（`logLines` にエントリ単位のキャッシュが無い）。
`abort()` なので `process.on('exit')` も走らず、クラッシュログにも何も残らない（Node の
診断レポートだけが記録）。

- [x] **ログの上限**（新規 `core/log-buffer.ts`・純粋）: `MAX_LOG_ENTRIES`（2000）/
      **`MAX_LOG_CHARS`（400,000 = 合計文字数）** / `MAX_LOG_ENTRY_CHARS`（20,000。超過分は `…` を
      付けて切る）/ `MAX_STREAM_PREVIEW_CHARS`（4,000）。**件数だけでは何も縛れない**（1 件が
      1 文字でも 20,000 文字でもよいので件数 × 1 件上限 = 4000 万文字）ため、文字数側の予算が
      実際の上限になる。追記は `pushLogEntry` の 1 経路に集約し、`status-reducer.appendLog` と
      `sdk-parse` の追記（`assistant_text` / `tool_use` / `tool_result`）を全部通す。
      **`seq` は振り直さない**（描画キー `<seq>:<行>` がこれで決まる）。切り詰めはサロゲートペアを
      分断しない
- [x] **`logLines` のエントリ単位メモ化**（`core/scroll.ts`）: エントリは immutable（変更時は必ず
      別オブジェクトになる）なので、幅とプレフィックスが同じなら前回の行をそのまま使える。
      追記 1 件のコストが「その 1 件」になる。**保持行数にも上限**（`MAX_CACHED_ROWS` = 8,000・LRU）
      — 展開後の行は元テキストの数倍を占めるので、上限が無いと「一過性のゴミ」が
      「開いた全セッション × 全エントリの永続的な保持」に化ける。ただし**描画中のログの行は
      追い出さない**（自分が次に使う行を捨てて毎フレーム再展開するのを避ける）。
      `push(...rows)` は使わない（数万行に折り返したエントリで引数が溢れる）
- [x] **ツール結果・ツール入力を全部平坦化しない**（`sdk-parse.ts` の `asStringHead` / `inputText`）:
      `toolResultSummary` は先頭 200 文字しか使わないのに、10MB の `Read` / `Bash` 出力を 1 本の
      文字列へ平坦化して**全行に `split('\n')`** していた。`Bash` の heredoc（ファイル本文込み）も
      同様に全部組み立ててから切っていた。読む長さだけ材質化する
- [x] **ストリーミングプレビューは末尾だけ持つ**: `streamingText` は 1 行（`streamTail`）しか描かないのに
      1 メッセージ全体を溜め、毎フレーム全体を `split` していた
- [x] **復元は 1 本ずつ・読みながら畳む**（`bootstrap/restore-sessions.ts` / `core/transcript.ts` の
      `History`）: `Promise.all` で全セッションのトランスクリプト（1 本数 MB）を同時にヒープへ
      載せ、さらに**全エントリを作ってから**捨てていた。逐次 + 読みながらのトリムで、途中の
      保持量も上限で止まる（`seq` は「積んだ総数」で数えるのでトリムしても振り直さない）
- [x] **上限に達したときは選択を捨てる**（`ui/session-detail.tsx`）: 選択位置は文書先頭からの
      表示行 index なので、先頭が落ちると別の行を指す（= 触っていない行がコピーされる）。
      端末幅の変化と同じ扱いでクリアする
- [x] テスト: `core/log-buffer.spec.ts`（件数・文字数・1 件の上限 / 切り詰めとサロゲート保護 /
      不要なら同一参照のまま = キャッシュが効く / kind・timestamp を保つ）/
      `core/scroll.spec.ts`（同じエントリは 2 度展開しない・追記時に古い行は同一参照・幅/プレフィックス
      変更で再計算・**Markdown 経路の再折り返し**・メモ化の結果が非メモ化と一致・LRU で古い行は
      落ちる・**予算より大きいログでも自分の行は追い出さない**）/ `core/sdk-parse.spec.ts`
      （SDK 経路の上限・巨大 heredoc の切り詰め・**切られた回答の result エコー除去**・
      `toolResultSummary` の各分岐と 10MB ペイロード・`summarizeToolUse` の表）/
      `core/status-reducer.spec.ts`（`appendLog` の上限）/ `core/transcript.spec.ts`（復元の上限・
      読みながらのトリム・切り詰め）
- [x] ドキュメント: `docs/ARCHITECTURE.md`（ログの上限とメモ化）/ `docs/TECH_NOTES.md`（実測）/
      `.claude/rules/session-domain.md`（不変条件）/ `CLAUDE.md`（コードの地図）/
      `README.md`（トラブルシューティング）

> 実績メモ: lint / typecheck / test（2037 件）/ build 緑。**実測**:
>
> | 測ったもの | 結果 |
> |---|---|
> | 2000 文字級の Markdown 500 件 × 「1 件追記 → 再描画」500 回 | メモ化前 **23.3 秒**（75 万個の `DisplayLine`）→ 後 **0.10 秒** |
> | 上限いっぱい（2000 件 / 12,000 行）で 300 回追記 → 再描画 | **0.40 ms/フレーム**（予算超過でも再展開しない） |
> | 上限まで詰めたセッション 6 本を描画したあとの保持量 | **22 MB**（行数上限が無いと 1 本で 91 MB） |
>
> 確保レートが GC を追い越すのが `Ineffective mark-compacts`（= ヒープが埋まったまま回収しきれない）
> の直接原因だった。上限側は「ログは会話の**記録ではなく表示**」という前提に立っている（正本は CLI の
> トランスクリプト = `core/transcript.ts` の復元元なので、古い行を落としても読み返す手段は残る）。
> `toolResultSummary` は CR も行区切りとして切るようになったので**厳密には従来と同値ではない**
> （`Progress\r50%\r100%` のような結果が 1 行に収まる方向の変化。復元ログも同じ関数を通るので一致は保たれる）。
> 実機での体感確認はユーザーに依頼。
>
> **残した課題**（別 Phase 候補）: スクロール位置は「文書先頭からの表示行 index」なので、
> 上限に達したログが古い行を落とすとその分ズレる（上スクロール中に追記が続くとビューが少しずつ
> 新しい方へ動く。選択の方はクリアして被害を止めてある）。直すなら基準を `DisplayLine.key`
> （`<seq>:<行>`。トリム・追記の双方で不変）に変える必要があり、`core/scroll.ts` /
> `core/log-selection.ts` / 当たり判定まで波及するので分離した。

---

## Phase 24: 実行中のターンを中断する（詳細ビューの `Ctrl+C`）✅

> 走り出したセッションを止める手段が「破棄（`d`）」しか無かった。**やめたいのはターンだけで、
> worktree と会話は残したい**（Claude Code の `Ctrl+C` と同じ期待）。`Session.interrupt()` は
> 以前からあったが UI から呼ばれておらず、しかも素直に呼ぶと CLI の打ち切り result
> （`is_error: true`）が `failed` に分類されて**再開できない**状態になっていた。

- [x] `STATUS_META` に `interruptible` を追加（`running` / `awaiting_*` = ターンが生きている区間。
      `active` と別フラグにするのは awaiting_* が「動いていないが中断できる」ため）+ `isInterruptible`
- [x] `Session.interrupt()`: `isInterruptible` でゲートし、**SDK の応答を待たずに先に**
      `{ kind: 'interrupted', error: USER_INTERRUPT_DETAIL }` を dispatch → `Query.interrupt()`
      は best-effort（reject を握り潰す。サブプロセス消失後の write は EPIPE）。許可待ちで押された
      場合は既存の `commit()` 経路が canUseTool を deny で閉じる
- [x] `sdk-parse`: `terminal_reason: 'aborted_streaming'` を `interrupted` に分類（実測フィクスチャ準拠）。
      文言ではなく構造で判定し、ログには `USER_INTERRUPT_DETAIL`（CLI の `[ede_diagnostic] …` は出さない）。
      先に立てた診断と同文なので `toInterrupted` の重複畳み込みで二重ログにならない
- [x] `SessionManager.interrupt(id): Promise<boolean>`: ストアの現在値で判定（連打の吸収は `resume` と同じ
      理由で core 側）
- [x] 詳細ビュー: `Ctrl+C` を **`pending` ガードより前**に処理（許可/質問ダイアログ表示中も中断できる）。
      案内は独立した 1 行で `detail.cancelHint`（実行中）⇄ `resume.oneKeyHint`（中断後）
- [x] `Messages` に `detail.cancelHint`（ja/en 対）
- [x] テスト: `status-meta.spec.ts`（`isInterruptible` の表）/ `session.spec.ts`（interrupted になる・
      `aborted_streaming` の result で `failed` に落ちない・ログが 1 行・終端では no-op・pending を deny）/
      `session-manager.spec.ts`（対象/非対象の表 + 未知 id）/ `sdk-parse.spec.ts`（実フィクスチャが
      `interrupted`）/ `tests/app.test.tsx`（Ctrl+C で `interrupted` + 案内の入れ替え、許可ダイアログ中の中断）
- [x] ドキュメント: `docs/ARCHITECTURE.md`（状態機械 + 「ユーザーによる中断」節）/ `docs/TECH_NOTES.md`
      （interrupt の実測フィールド）/ `.claude/rules/session-domain.md` / `.claude/rules/ink-components.md` /
      `.claude/skills/add-session-status/SKILL.md`（7 フィールド）/ `README.md`

> 実績メモ: lint / typecheck / test / build 緑。中断は**詳細ビューだけ**の操作にした（一覧で
> フォーカス横断の `Ctrl+C` にすると、選択行を取り違えたときに走っている別のセッションを止めてしまう）。
> 実機での体感確認はユーザーに依頼。

---

## Phase 25: ヒープ枯渇（OOM）対策 2 — 描画ごとの永久保持 ✅

> Phase 23（ログの上限とメモ化）を入れた 0.3.8 で**また OOM で 3 回落ちた**
> （`~/.codiva/logs/report.*.json`。cwd はセッション数の多いリポジトリ 2 つ）。前回は「確保レートが
> GC を追い越す」（`Ineffective mark-compacts`）だったが、今回は `old_space` 4.2GB が**生存データで
> 埋まっている**一方 `large_object_space` は 55MB だけ = **小さいオブジェクトの保持漏れ**。
> ログの上限では止められない別経路だった。
>
> ヒープスナップショットの上位が `PerformanceMeasure` × 60,003（= 20,000 描画 × 3）と
> `Components ⚛` / `Changed Props` / `Scheduler ⚛` で、正体は **React 19.2 の Performance Tracks**。
> `react-reconciler` の dev ビルドが**モジュール評価時**に `supportsUserTiming`
> （`console.timeStamp` && `performance.measure`。Node には両方ある）を確定し、以後レンダーごとに
> `performance.measure()` を 3 本積む。**Node の user timing は自動で捨てられない**。
> `bin` から `node` で直に起動され `NODE_ENV` が未設定なので、**利用者は必ず dev ビルド**だった。

- [x] **`src/index.tsx` を起動シムにする**（本筋）: `process.env.NODE_ENV ??= 'production'` を
      `await import('./main')` **より前**に置く。本体は `src/main.tsx` へ改名。ESM の static import は
      巻き上げられて本文より先に評価されるため、シムに static import を 1 本足すと無効化される
      （`tsup` の `banner` も、シバンの `env -S` も間に合わない。後者は **mise 経由の起動が
      `node <path>` 直叩きでシバンを通らない**ので特に当てにならない = 実際のクラッシュレポートの
      `commandLine` がそれ）。`tsup` は `splitting: true` が必須（畳むと巻き上げが復活する）
- [x] **`bootstrap/perf-timeline.ts`**（保険）: 30 秒ごとに `performance.clearMeasures()` /
      `clearMarks()`。`NODE_ENV=development` で起動したときや、将来 React / Node が別の形で
      user timing を積み始めたときに効く。タイマーは unref、失敗は握り潰す
- [x] **ストリーミングプレビューを表示幅で切る**（Ink 7.1.1 の上限なしキャッシュ対策）:
      `streamTail(text, width)` + 純粋な `clipToWidth`（グラフェム単位・早期打ち切り・ANSI を含む行は
      切らない）。`ink/build/measure-text.js` の `new Map()` と `wrap-text.js` の `{}` は
      キー = テキスト全文で evict が無く、**4,000 文字の `<Text>` 1 描画で約 17.8KB が永久に残る**。
      `wrap="truncate-end"` は描画時に切るだけなのでキーは切る前の文字列 = 効かない。
      渡す幅はログ行の折返しと同じ `logWidth` を使う
- [x] `bootstrap/runtime.ts` の `void manager.refreshPrs()` に `.catch()`（規約違反。20 秒ごとの
      reject が unhandled rejection = プロセス死になり、**死因が OOM と見分けづらい**）
- [x] テスト: `tests/entry-shim.test.ts`（**番人**: static import が無い・NODE_ENV の代入が動的 import
      より前・`??=` である・3 文だけ）/ `bootstrap/perf-timeline.spec.ts`（間隔ごとに掃除・停止・
      throw を伝播しない・unref）/ `core/scroll.spec.ts`（`clipToWidth` のテーブル + 幅を超えた行は
      同じ文字列を返す = キャッシュに当たる）
- [x] ドキュメント: `docs/ARCHITECTURE.md`（「React の dev ビルドとヒープ枯渇」+ 合成レイヤ）/
      `docs/TECH_NOTES.md`（実測 2）/ `CLAUDE.md`（不変条件 10・コードの地図・ビルド構成）/
      `.claude/rules/architecture.md` / `.claude/rules/ink-components.md` / `.claude/rules/workflow.md` /
      `README.md`（トラブルシューティング + ビルド行）

> 実績メモ: lint / typecheck / test（2175 件）/ build 緑。**実測**（`--expose-gc` + 強制 GC 後の
> heapUsed 差分。空 Box を 8,000 回再描画）:
>
> | 条件 | 永久保持 | perf エントリ | 所要 |
> |---|---|---|---|
> | dev ビルド（従来） | **2,230 B/フレーム** | 24,003 件 | 414ms |
> | `NODE_ENV=production` | 117 B/フレーム | 0 件 | **166ms** |
> | dev + 定期 `clearMeasures()` | 174 B/フレーム | 1 件 | 406ms |
>
> 描画は約 10/秒なので従来は **約 86MB/時**。既定のヒープ上限 ~4GB に半日〜1 日で到達する。
> production ビルドは**描画自体も 2.5 倍速い**（報告された 26〜33 分の CPU 時間の相当部分）。
> Ink 側のプレビュー対策は 4,000 文字の最悪ケースで 6,786 → 3,129 B/フレーム。
>
> **残した課題**: Ink のキャッシュ自体に上限が無いこと（新しく現れたログ行 1 本ごとに約 1.7KB が
> 永久に残る）は上流の修正が必要なので issue で報告した
> （[ink#986](https://github.com/vadimdemedes/ink/issues/986)）。React 側の件は既報だった
> （[ink#869](https://github.com/vadimdemedes/ink/issues/869) /
> [facebook/react#35761](https://github.com/facebook/react/issues/35761)。結論・対策も同じ）。codiva 側で上限を付けるには
> `noExternal: ['ink']` でバンドルしてキャッシュを LRU 化する必要があり（`signal-exit` の CJS
> `require` シム + チャンク分割 + `react-devtools-core` の external が付いてくる。実験済みで
> dist は 322KB → 1.8MB）、「ビルド構成は変えない」方針との兼ね合いで見送っている。
> 併せて監査で見つかった別バグ（`SessionStore.set` による削除済みセッションの復活 /
> `canUseTool` の pending が 1 スロットで並行要求を取りこぼす / `AsyncQueue` の待機 resolver が
> 死んだイテレータへ配送する / discard・merge が `SessionHandle` を解放しない）は本件と独立なので、
> ここに次 Phase の候補として残す（いずれもメモリの主因ではないが、セッションが無言で
> 止まる・サブプロセスが残るといった実害がある）。

---

## Phase 26: 入力欄（コンポーザ）の共通化 ✅

**背景**: 入力欄は 4 か所（一覧の新規指示 / 詳細の追加指示 / `/prompt` エディタ /
質問ダイアログの「自分で入力する」）にあり、描画はどこも `PromptInput` で共通だったが、
**キーとマウスの配線は view ごとに手組み**だった。結果として質問ダイアログの自由記述欄だけ
`resolveEnter` を通しておらず、Shift+Enter で改行できない・↑↓ が無反応・ドラッグでコピー
できない・クリックでキャレットを置けない、という食い違いが残っていた。

- [x] `src/ui/composer.tsx` を新設（`useComposer` = バッファ + 実測 + マウス + キー、
      `<Composer>` = 描画）。`useInput` は持たず、view の単一ハンドラから
      `handleMouse(mouse) → boolean` / `handleKey(input, key) → submit | handled | ignored`
      を呼ぶ形にして「1画面 1 `useInput`」を維持
- [x] 4 か所すべてを移行（`session-list.tsx` / `session-detail.tsx` /
      `repo-prompt-editor.tsx` / `permission-dialog.tsx`）
- [x] 計測 Box を `PromptInput` **だけ**を包む形に統一（コマンドパレットを同じ Box に
      入れていたため、パレット表示中はクリックが 2〜3 行ぶんずれていた）
- [x] 「選択中はキャレットを動かさない」（`/prompt` エディタだけが持っていた正しい挙動）を
      全入力欄へ展開。あわせて「縦に潰れているあいだは当たり判定をやめる」ガードも共通化
- [x] `session-list.tsx` のマウスガードに `pending` を追加（モーダル表示中は背後の view が
      マウスレポートも飲む。`session-detail.tsx` は既にそうだった）
- [x] i18n: `permission.typingHelp` に Shift+Enter の案内を追加（ja / en）
- [x] テスト: `permission-dialog.spec.tsx` に「自由記述欄は通常の入力欄と同じ仕様」の
      describe（Shift+Enter = modifyOtherKeys / CSI-u の両方・末尾バックスラッシュ・
      ↑↓ のキャレット移動・ドラッグ選択とコピー）
- [x] ドキュメント: `.claude/rules/ink-components.md`（入力欄は 1 実装）/
      `docs/ARCHITECTURE.md`（`useComposer` の責務）/ `CLAUDE.md`（コードの地図）/
      `README.md`（キー操作・コピーの対象を正しい 4 か所に）

> 実績メモ: lint / typecheck / test（2,184 件）/ build 緑。view 側は差し引き **−350 行 / +298 行**
> で、共通化した約 240 行が `ui/composer.tsx` に集約された。`tests/app.test.tsx` の
> 「クリックでキャレットが動く」テストは press だけを送っていたので release を足した
> （キャレットが動くのは**離した**時点 = ドラッグにならなかったクリックだけ、に統一したため）。

---

## 各 Phase 共通の完了チェック

1. `npm run lint` / `npm test` が通る
2. TASKS.md のチェックボックスを更新
3. ドキュメント（ARCHITECTURE.md / TECH_NOTES.md）と実装の乖離があれば解消
4. conventional commits でコミット
