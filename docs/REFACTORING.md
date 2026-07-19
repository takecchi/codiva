# リファクタリング作業書

> 2026-07-20 時点の全体設計レビュー(アーキテクチャ評価・コード品質・UI 共通化の3観点)の結果を、
> 実行可能なフェーズ単位の作業書に統合したもの。**実装エージェント(Opus 等)はこのファイルの
> Phase 順に作業し、各 Phase の DoD を満たしてから次へ進むこと。**
> 行番号は commit `bfd7cee` 時点の実測値。着手時に乖離していたら Grep で再特定する。

## 背景と評価サマリ

現状は **作り直し不要・中規模リファクタで十分** という評価。

- 健全性: 589 テスト全パス、core/utils カバレッジ 95%、lint/typecheck ほぼクリーン。
- 良い点: core の純粋性(Ink/React 非依存)、DI の徹底、純粋 reducer、i18n カタログ集約、
  text-buffer/scroll/mouse/key-sequence の純関数分離は高水準で守られている。
- 構造的な問題は次の5つに集約される:

| # | 問題 | 深刻度 | 対応 Phase |
|---|------|--------|-----------|
| 1 | `core/worktree.ts` のレイヤ違反(node I/O + `@/utils` 値 import)と core⇄utils バレル循環依存 | **CRITICAL** | R1 |
| 2 | `SessionStatus` の性質(terminal/attention/復元先…)が約9ファイルに散在(shotgun surgery) | HIGH | R2 |
| 3 | `session-list.tsx` / `session-detail.tsx` 間の制御フロー・確認フロー・描画の大規模重複 | HIGH | R4 |
| 4 | `SessionManager` の God object 化(ストア/ライフサイクル/PR自動化/永続化/モード…8責務・521行) | HIGH | R6 |
| 5 | reducer が raw `Record<string, unknown>` を再パース(SDK 形状知識が reducer に混入) | MEDIUM | R3 |

## 進め方の原則

1. **挙動を変えない。** 全 Phase はリファクタリングであり、ユーザ可視の動作・文言・キーバインドを変更しない。
2. **1 Phase = 1 ブランチ = 1 PR。** コミットは conventional commits(`refactor:` / `test:` / `docs:`)。
3. 各タスク完了ごとに `npm test` / `npm run lint` / `npm run typecheck` を通す。
   core/ と utils/ のカバレッジ 80% を下回らないこと(現状 95% を維持目標とする)。
4. **ドキュメント先行**: 実装と docs/ が乖離する変更(特に R1)は、docs/ を同じ PR 内で先に直す(CLAUDE.md のルール)。
5. 既存規約に従う: `.claude/rules/architecture.md` / `coding-rules.md` / `ink-components.md` / `i18n.md`。
   特に「core は I/O を import しない」「UI 文字列はカタログのみ」「1画面 1 useInput」を崩さない。
6. 移動を伴うタスクは「移動 → import 修正 → テストも移動」まで1コミットで完結させる(中間状態を作らない)。

### Phase 間の依存関係

```
R1 (レイヤ修復)  ← 最優先。他の全 Phase の前提(バレルが健全になる)
R2 (status-meta) ← R4 の一部(TERMINAL 置換)が依存
R3 (sdk-parse)   ← R6 と独立。R1 の後ならいつでも
R4 (UI 共通化)   ← R2 の後推奨。R5 と同一ファイルを触るので R5 と直列にする
R5 (UI→core 移動)← R4 の後推奨(共通化で残った純ロジックを移す)
R6 (Manager 分割)← R3 の後推奨。R4/R5 とは独立(並行可)
R7 (bootstrap)   ← R6 の後推奨(分割後の配線を整理する方が二度手間にならない)
R8 (小粒の重複)  ← ほぼ独立。すきまで随時
R9 (docs 整合)   ← 各 Phase 内で随時 + 最後に総点検
```

---

## Phase R1: レイヤ違反と循環依存の解消 【CRITICAL・最優先】

**問題**: `src/core/worktree.ts:1-3` が `node:fs/promises` / `node:path` / `@/utils`(`git`, `GitError` の**値** import)に依存。
規約(「core は node の I/O を import しない」「依存は utils → core の一方向」)に違反し、さらに
utils 側 6 ファイル(`config.ts` / `notify.ts` / `pr.ts` / `state-store.ts` / `transcript.ts` 等)が `@/core` を
import しているため **core バレル ⇄ utils バレルの循環依存**が成立している(現状は評価順で偶然動作)。

### T1-1 docs/ARCHITECTURE.md の修正(先行)
- `ARCHITECTURE.md` のレイヤ図(13-18行付近)とディレクトリ節(164行付近)は WorktreeManager を core に
  図示している。これが違反実装の原因。**WorktreeManager を utils 層(I/O)に置く図へ先に修正する。**

### T1-2 WorktreeManager の utils 移設
- `src/core/worktree.ts` を分割:
  - **core に残す** → `src/core/worktree.ts`(純粋部のみ): 型 `Worktree` / `DiffStat`、`MergeConflictError`、
    純関数 `ignoredCopyEntries()` 等。node / `@/utils` の import をゼロにする。
  - **utils へ移す** → `src/utils/worktree-manager.ts`: `WorktreeManager` クラス(fs + git 実行の具象)。
- `WorktreeService` インターフェースは `core/session-manager.ts:14` に既にあるため、core は具象を知らない。
- `src/index.tsx` の import を `@/utils` 経由に変更。spec(`core/worktree.spec.ts`)のうち I/O 部分は
  `utils/worktree-manager.spec.ts` へ移動、純関数部分は core に残す。

### DoD
- [ ] `grep -rn "node:" src/core/` が 0 件
- [ ] `grep -rn "from '@/utils'" src/core/` が 0 件(= core→utils の逆流ゼロ、循環解消)
- [ ] ARCHITECTURE.md の図・ディレクトリ節が実装と一致
- [ ] 全テスト green・カバレッジ維持

---

## Phase R2: SessionStatus メタデータの一元化(shotgun surgery 解消)

**問題**: 状態の「性質」が中心テーブルなしに各所へコピーされており、`SessionStatus` を1つ増やすと
約9ファイルを触る: `core/types.ts:4`(union) / `status-reducer.ts`(遷移) / `persistence.ts:51` `restorableStatus` /
`notify.ts:10` `labelFor` / `ui/progress-badge.tsx:8` `badgeFor` / `ui/theme.ts` `statusColor` /
`ui/session-detail.tsx:44-51` `TERMINAL` set / `ui/session-list.tsx:426` 付近の attention 判定 / `core/i18n.ts`(ja+en)。

### T2-1 `core/status-meta.ts` の新設

```ts
export interface StatusMeta {
  terminal: boolean;   // detail の TERMINAL set を置換
  attention: boolean;  // list の attention 判定を置換
  restoreAs?: 'completed' | 'interrupted' | 'failed'; // persistence.restorableStatus を置換
  notifies: boolean;   // notify.notificationFor の発火判定を置換
}
export const STATUS_META: Record<SessionStatus, StatusMeta> = { /* 全10状態 */ };
export const isTerminalStatus = (s: SessionStatus): boolean => STATUS_META[s].terminal;
```

- テーブルドリブンの spec(`status-meta.spec.ts`)を先に書く(TDD)。全 `SessionStatus` を網羅していることを
  型で保証(`Record<SessionStatus, …>` なので欠落は型エラー)。

### T2-2 参照箇所の置換
- `ui/session-detail.tsx:44-51` の `TERMINAL` set → `isTerminalStatus` に置換(UI から状態知識を排除)。
- `core/persistence.ts` の `restorableStatus` → `STATUS_META[s].restoreAs` から導出。
- `core/notify.ts` の判定 → meta 参照に置換(ラベル文言は i18n に残す)。
- `ui/session-list.tsx` の attention 判定 → meta 参照に置換。
- 色(`theme.statusColor`)とラベル(`i18n` / `badgeFor`)は表示の関心なので**そのまま残す**。

### DoD
- [ ] 新状態を追加した場合の変更点が「types.ts + status-meta.ts + reducer + theme + i18n」の想定内に収まる
- [ ] `grep -rn "TERMINAL" src/ui/` が 0 件
- [ ] 全テスト green

---

## Phase R3: reducer から SDK パースを分離

**問題**: `core/status-reducer.ts`(501行)は純粋 reducer のほかに SDK メッセージ形状のパース
(`reduceSdk`/`reduceAssistant`/`reduceUser`/`reduceStreamEvent`)、ツール要約、todo 適用が同居し、
`reduce` の `case 'sdk'` が `SDKMessage` を `Record<string, unknown>` に落として手書きパースしている。
`core/types.ts:138` のコメント「Session translates SDK output ... into events」とも矛盾。

### T3-1 `core/sdk-parse.ts` の新設
- `status-reducer.ts` から移動: `summarizeToolUse` / `toolResultSummary` / `applyTaskTool` / `asString` /
  `isRateLimitError` / block 型ガード(`TextBlock` 等)。
- 新 API(シグネチャは実装時に調整可、方針は「SDK 形状の知識をここに閉じ込める」):
  `sdkMessageToEvents(msg: SDKMessage, at: number): CodivaEvent[]`
  既存の `CodivaEvent` union に必要なら型付きイベント(例 `{ kind: 'assistant_blocks', … }`)を追加する。
- `transcript.ts` が共有している `summarizeToolUse`/`toolResultSummary` の import 元を差し替え。

### T3-2 reducer の縮小
- `core/status-reducer.ts` は **型付き `CodivaEvent` のみ**を受ける `reduce` + `appendLog` / `progressOf` /
  `initialState` に縮小(目安 250 行以下)。raw `Record<string, unknown>` への cast を排除。
- `Session.consume`(`core/session.ts:314-316`)で `sdkMessageToEvents` を通してから `dispatch` する。

### T3-3 provision 失敗も reducer 経由にする
- `core/session-manager.ts:262-268` の catch は Session を経由せず `states` に `status:'failed'` を手書きしており、
  「reducer が唯一の状態遷移の真実」に反する(このセッションは以後 `send`/`allow` が黙って no-op)。
- `reduce(placeholder, { kind: 'aborted', error: String(err), at })` を通した状態を set する形に統一する。

### DoD
- [ ] `status-reducer.ts` に SDK メッセージの形状知識(`message.subtype` 等の生参照)が残っていない
- [ ] `tests/fixtures` 由来の実データテストが sdk-parse 側で従来ケースを網羅
- [ ] 全テスト green・reducer/parse のカバレッジ 90%+

---

## Phase R4: UI の共通化(session-list ⇄ session-detail の重複解消)

**問題**: 両 view の `useInput` 制御フロー・確認フロー・オーバーレイ描画がほぼ逐語一致で重複している。
純関数(editText/scroll/mouse 等)は既に共有されており、**重複しているのは「呼び出す制御フローと JSX」**。

主な重複対(現行行番号):

| 内容 | session-list.tsx | session-detail.tsx |
|------|-----------------|--------------------|
| buffer + bufferRef + updateBuffer ブロック | 117-125 | 97-104 |
| マウスレポート先取り→wheel 分岐→return | 264-277 | 195-209 |
| modelSelect/showHelp/busy/pending ガード群 | 284-315 | 216-246 |
| confirm の y/n 応答 | 316-323 | 258-265 |
| m/d → setConfirm('merge'/'discard') | 346-353 | 270-277 |
| Enter(resolveEnter→command→submit)+ editText フォールスルー | 370-395 | 279-301 |
| runCommandInput(exit/help/model 分岐) | 187-206 | 157-181 |
| runAction(busy→merge/discard→エラー反映) | 208-220 | 141-154 |
| modelSelect→pending→composer の分岐 JSX + footerHint | 398-404, 508-539 | 312-318, 367-424 |

### T4-1 共有フックの抽出(`src/ui/hooks.ts` または `src/ui/use-*.ts`)
1. `useTextBufferRef()` — `{ buffer, bufferRef, updateBuffer, reset }`。両 view の 6 行重複ブロックを置換。
2. `useCommandRunner(handlers)` — `runCommand` 解決 + `exit`/`help`/`model` の共通 action、
   view 固有(`diff`)はハンドラ注入。unknown → `setActionError(m.command.unknown(...))` も内包。
3. `useLifecycleAction(manager, id, { onSuccess })` — `confirm`/`busy`/`actionError` state と
   `run(action, force?)`(merge/discard 実行シーケンス)を集約。
- 注意: **`useInput` はフックに移さない**(1画面1 useInput の規約維持)。フックは state とハンドラのみ提供し、
  view の useInput から呼ぶ。キー処理の共通前半(マウス先取り/ガード群/confirm y/n/Enter+editText)は
  純粋なヘルパ関数(例 `ui/input.ts` に `handleCommonKeys(ctx, input, key): 'handled' | 'fallthrough'`)として
  くくり、差分(wheel の実体・submit の実体・Tab の対象)はコールバック注入で吸収する。

### T4-2 presentational コンポーネントの抽出
1. `<DialogBox borderColor>` — `borderStyle="round" + paddingX={1}` の角丸枠 6 箇所
   (`command-palette.tsx:19` / `permission-dialog.tsx:44,125` / `model-select.tsx:47` /
   `session-detail.tsx:395` / `session-list.tsx:499`)を集約。
2. `<ConfirmPrompt kind busy>` — y/n 確認ボックス(list:498-506 / detail:396-401)。色は theme に統一。
3. `<ComposerArea buffer focused placeholder>` — 「`isCommandInput` なら CommandPalette + PromptInput」
   ブロック(list:529-538 / detail:414-423)。

### T4-3 theme 迂回の生色排除
- `session-detail.tsx:34-42`(LOG マップ) / `346` / `362` / `368` / `395` / `399` / `404` / `408`、
  `model-select.tsx:59` の生 ANSI 色名(`'red'` / `'green'` / `'blue'` / `'cyan'` / `'yellow'`)を
  `theme.ts` のトークン(`theme.yes` / `theme.no` / `theme.accent` / `statusColor.*`)に置換。
  足りない意味には `theme.warn` / `theme.info` 等を**追加してから**使う(直書き禁止)。
- `permission-dialog.tsx:136` のハードコード `'❯'` → `glyph.caret` に統一。

### T4-4 i18n の共有グループ化
- `core/i18n.ts` の `list.*` と `detail.*` で完全重複している 5 キー
  (`mergePrompt` / `discardPrompt` / `confirmRun` / `busySuffix` / `actionErrorLabel`)を
  `messages.action.*` に新設・移動し、ja/en 両方を更新(`i18n.spec.ts` のキー一致検証が番人)。

### T4-5 型の二重定義解消
- `src/app.tsx:15` のローカル `ListViewState` を削除し、`session-list.tsx:73` の export 済み型を
  `@/ui` バレル経由で import する。

### DoD
- [ ] `session-list.tsx` / `session-detail.tsx` がそれぞれ 400 行以下
- [ ] 両 view の diff で逐語一致ブロックが残っていない(buffer 管理・runCommand・runAction・confirm JSX)
- [ ] `grep -n "color=\"red\"\|color=\"green\"\|color=\"blue\"\|color=\"yellow\"\|color=\"cyan\"" src/ui/*.tsx` が 0 件
- [ ] `tests/*.test.tsx`(app/commands/ime-cursor/restore)が無変更のまま green(挙動不変の証明)

---

## Phase R5: UI に残った純ロジックの core への移動

**問題**: 「状態計算は core の純関数に委譲」の規約に反して UI 側に残っている計算がある。

### タスク(それぞれ移動 + co-located spec 追加)
1. **クリック→キャレット逆写像**: `session-list.tsx:223-240` の composer ヒットテストは
   `promptCaretColumn`(順方向)の逆関数のインライン実装。
   → `core/text-buffer.ts` に `caretIndexAtClick(buffer, clickRow, clickCol, maxRows)` を新設。
   ボーダー/プレフィックスの座標オフセット(+1/-2)だけ UI に残す。
2. **一覧行のヒットテスト**: `session-list.tsx:241-262` 付近の行インデックス・PR セル範囲の逆算
   → `core/list-hit.ts`(`rowIndexAtPoint` / `isPrCellHit`)。UI は測定値を渡すだけにする。
3. `caretIndexForColumn` / `promptCaretColumn`(`ui/input.ts:152-176`)→ `core/text-buffer.ts` の
   ジオメトリ群へ移動(表示幅版の cursorRowCol/indexAtRowCol の対)。
4. `formatElapsed`(`ui/input.ts:178-186`)→ core へ(例 `core/format.ts`。`formatUsd` と同層)。
   **現状未テストなので spec を必ず追加。**
5. `streamTail`(`session-detail.tsx:54-63`)→ `core/scroll.ts` か `core/transcript.ts` へ。
6. **一覧ビューポート行数**: `session-list.tsx:163-165` の `termRows - 15` マジックナンバー
   → `core/layout.ts` に `LIST_CHROME_ROWS` 定数 + `listViewportRows(termRows)` を新設
   (`logViewportRows` と対になる)。
7. `prStatusBadge`(`session-list.tsx:59-70`)→ `badgeFor` と同様の純関数として
   `ui/progress-badge.tsx` 隣接か core 側へ寄せ、spec を追加。

### DoD
- [ ] `ui/input.ts` が「キー→操作の対応」のみ(ink-components.md の記述どおり)になる
- [ ] 移動した全関数に spec があり、core カバレッジ 80%+ を維持
- [ ] マウス操作(クリック選択・キャレット移動・PR セルクリック)の手動確認(/tmp の使い捨てリポジトリで)

---

## Phase R6: SessionManager の分割(God object 解体)

**問題**: `core/session-manager.ts`(521行)に 8 責務が同居:
購読ストア(145-195,317-391) / ライフサイクル(202-370,471-476) / git 操作(419-464) /
PR 自動化(127,290-315,489-520) / ランモード+ポリシー(169-191) / モデル既定値(152-167) /
永続スナップショット(373-385) / slug 予約(225-229)。状態も 6 フィールドに分散。

### T6-1 分割(既存の public API は SessionManager がファサードとして維持し、UI 変更を最小化する)
- `core/session-store.ts` — 購読可能ストア。`subscribe` / `getSnapshot` / `get` / `set` / `appendOrder`。
  スナップショットの参照同一性維持(変更行以外は再生成しない)もここに閉じる。
- `core/session-actions.ts` — `merge` / `discard` / `diffStat`。`WorktreeService` + store を DI 受け。
- `core/pr-coordinator.ts` — `maybeAutoPr` / `refreshPrs` / `autoPrAttempted`。状態遷移を購読して駆動。
- `core/run-mode.ts` — `RunMode` + `createModePolicy(getMode): PermissionPolicy`。
- `persistableState()` の組み立て → `core/persistence.ts` の自由関数
  `assemblePersistedState(order, states, meta): PersistedState` へ移動。
- `session-manager.ts` に残るのは create/provision/restore/dispose + UI passthrough(目安 250 行以下)。

### T6-2 小さな一貫性修正(分割と同 PR で)
- `create()` で `now()` を 2 回読んでいる(213 と 245 で startedAt が別値になる)
  → 冒頭で 1 回読んで使い回す。
- `restore()` と `provision()` の `new Session({...})` フォールバック構築の重複(247-257 / 349-360)
  → private `buildSession(input, onChange, extra?)` に集約。
- `rebuild()` が streamingText の delta ごとに `onPersist` を発火している
  → 永続対象(status/sdkSessionId/todos/title/pr)が変わったときだけ dirty にする。

### T6-3 テストの再配置
- `session-manager.spec.ts`(928行)を分割先に合わせて `session-store.spec.ts` /
  `session-actions.spec.ts` / `pr-coordinator.spec.ts` 等へ分割。既存ケースは削らない。

### DoD
- [ ] 各新モジュールが単独でテスト可能(fake は WorktreeService / store のみ)
- [ ] `session-manager.spec.ts` の既存シナリオが全て(分割先で)green
- [ ] UI 側(`hooks.ts` の useSessions / useRunMode)は無変更で動く

---

## Phase R7: 合成ルート(index.tsx)の分解

**問題**: `src/index.tsx`(205行)に preflight / i18n 解決 / notify 配線 / 永続 debounce / model 永続 /
manager 構築 / restore / PR ポーリング / signal ハンドラ / alt-screen / render / 最終 flush が直列に同居。

### タスク: `src/bootstrap/` を新設し、`main()` を「解決 → preflight → build → restore → render → shutdown」の直列に縮小
- `bootstrap/build-manager.ts` — `buildManager(config, deps): SessionManager`(現 102-124 の配線)。
- `bootstrap/restore.ts` — `restoreSessions(manager, statePath): Promise<void>`(現 126-140)。
- `bootstrap/persist-controller.ts` — `createPersistController(manager, path)` が
  `{ schedule, flushSync, flushAsync }` を返す(現 77-86 / 155-164 / 194-197 は同一関心事)。
- `bootstrap/runtime.ts` — PR ポーリングタイマ / alt-screen / mouse の enter・leave(現 142-149 / 166-176 / 199-201)。
- 配置は ui/core/utils のどのレイヤでもない「合成」なので、`src/bootstrap/` は core にのみ依存する utils 扱い
  (architecture.md にレイヤ図の追記を同 PR で行う)。

### DoD
- [ ] `index.tsx` が 80 行以下
- [ ] `tests/restore.test.tsx` 等の統合テストが green
- [ ] 起動・終了・SIGTERM 時の状態保存の手動確認

---

## Phase R8: 小粒の重複・デッドコード整理

独立性が高く、すきま時間で個別 PR にできる粒度。各項目 1 コミット。

| # | 内容 | 対象 |
|---|------|------|
| 1 | `clamp` の同一実装 2 箇所 → `core` の共通モジュール(例 `core/math.ts`)へ | `core/text-buffer.ts:19-21` / `core/scroll.ts:26-28` |
| 2 | 先頭 ESC 除去の重複 → `stripLeadingEscape()` を共通化 | `core/key-sequence.ts:63` / `core/mouse.ts:20` |
| 3 | エラー文字列化の2流派統一 → `core/errors.ts` に `errorMessage(err: unknown): string` | `session.ts:319` / `session-manager.ts:265,445,462` / `index.tsx:60` |
| 4 | fire-and-forget execFile の重複 → `utils/exec.ts` に `fireAndForget(file, args)` | `utils/notify.ts:46-58` / `utils/open-url.ts:32-44` |
| 5 | 冪等 enter/leave + exit フックの重複 → `utils/terminal-mode.ts` に `toggleEscape(enter, leave, stream)`。mouse 側に欠けている exit フック解除テストも共通 spec で補完 | `utils/mouse.ts:11-32` / `utils/alt-screen.ts:11-33` |
| 6 | `promisify(execFile)` の重複整理(#4 と同時に) | `utils/git.ts` / `utils/pr.ts` |
| 7 | **テストヘルパ集約**: `makeManager` / `fakeWorktrees` / `noopSession` / `flush` / `FakeStdin` が 4 ファイルに逐語重複(commands 版 `noopSession` には存在しないメソッド `detach()` のコピペ跡あり) → `tests/helpers.ts` に集約 | `tests/app.test.tsx:20-102` / `tests/commands.test.tsx:15-57` / `tests/ime-cursor.test.tsx:17-89` / `tests/restore.test.tsx:12-21` |
| 8 | 未使用 export の整理(公開 API として不要なら export を外す): `defaultPolicy` / `isRateLimitError` / `CommandAction` / `PrLookup` | `core/session.ts:38` / `core/status-reducer.ts:19` / `core/commands.ts:17` / `core/session-manager.ts:56` |
| 9 | Biome 警告 3 件の解消: `banner.tsx:30` の未使用引数 `ch`、`FakeStdin` の未使用 private(→ #7 で同時解消) | `ui/banner.tsx` / `tests/*.tsx` |
| 10 | (任意) `toConfig()` の同型 if×9 のテーブル化。型安全性(`any` 禁止)を崩さずに書ける場合のみ | `core/config.ts:101-147` |

### DoD
- [ ] `npx biome check .` 警告 0 件
- [ ] `npx knip` で新たな未使用 export が増えていない
- [ ] 全テスト green

---

## Phase R9: ドキュメント整合の総点検

各 Phase 内でも随時更新するが、最後に以下を総点検する。

1. `ARCHITECTURE.md` のレイヤ図・ディレクトリ節が R1/R6/R7 後の構成と一致しているか。
2. `core/types.ts:138` のコメント「Session translates SDK output ... into events」が R3 後の実装と一致。
3. `ARCHITECTURE.md:122` 付近「messages は現 UI では未表示」→ detail ビューで表示済み。記述を更新。
4. `ARCHITECTURE.md:267` 付近の Phase 10 節に表の行が散文へ混入している整形崩れを修正。
5. `PRD.md:38-45` の「MVP 対象外」(設定/通知/コスト/復元)は全て実装済み。PRD を歴史的資料として
   凍結する注記を入れるか、現行仕様に更新するかを決めて反映。
6. `.claude/rules/ink-components.md` に、R4 で導入した共有フック/presentational の使い方を追記。

---

## 付録A: リファクタ完了後の目標構成

```
src/
  index.tsx                    # bin: 解決→preflight→build→restore→render→shutdown の直列のみ
  app.tsx                      # View(list|detail) 切替のみ(現状維持)
  bootstrap/                   # 副作用の配線(R7)
    build-manager.ts / restore.ts / persist-controller.ts / runtime.ts
  core/                        # 純粋ドメイン(node/utils import ゼロ。SDK は型のみ)
    types.ts                   # SessionState / SessionStatus / CodivaEvent / PrInfo …
    status-meta.ts             # STATUS_META 表(R2)
    status-reducer.ts          # reduce(state, CodivaEvent) 純粋(R3 で縮小)
    sdk-parse.ts               # SDKMessage → CodivaEvent[] + summarize/applyTaskTool(R3)
    session.ts                 # 1 SDK query のライフサイクル
    session-store.ts           # 購読可能ストア(R6)
    session-manager.ts         # create/restore/dispose + passthrough のファサード(R6)
    session-actions.ts         # merge/discard/diffStat(R6)
    pr-coordinator.ts          # autoPr/refreshPrs(R6)
    run-mode.ts                # RunMode + createModePolicy(R6)
    list-hit.ts                # 一覧マウス当たり判定(R5)
    worktree.ts                # Worktree/DiffStat 型 + MergeConflictError + 純関数のみ(R1)
    i18n.ts config.ts cost.ts notify.ts persistence.ts scroll.ts layout.ts
    text-buffer.ts slug.ts async-queue.ts transcript.ts model.ts models.ts mouse.ts key-sequence.ts
  ui/                          # Ink 表示のみ
    hooks.ts                   # useSessions/useClock + useTextBufferRef/useCommandRunner/useLifecycleAction(R4)
    dialog-box.tsx confirm-prompt.tsx composer-area.tsx   # 共有 presentational(R4)
    session-list.tsx session-detail.tsx                   # 各 400 行以下
    banner.tsx prompt-input.tsx status-footer.tsx permission-dialog.tsx
    model-select.tsx command-palette.tsx progress-badge.tsx theme.ts input.ts i18n-context.tsx
  utils/                       # すべての I/O(core にのみ依存 = 一方向)
    worktree-manager.ts        # ← core から移設(R1)
    exec.ts terminal-mode.ts   # 共通 I/O ヘルパ(R8)
    git.ts config.ts state-store.ts transcript.ts title.ts notify.ts pr.ts open-url.ts
    alt-screen.ts mouse.ts
tests/
  helpers.ts                   # 共有フィクスチャ(R8)
  app.test.tsx commands.test.tsx ime-cursor.test.tsx restore.test.tsx
```

## 付録B: やらないこと(non-goals)

- モノレポ化・パッケージマネージャ変更・ビルド構成変更(npm + tsup + bundler resolution を維持)
- 挙動・文言・キーバインドの変更(純粋なリファクタリングのみ)
- 新機能の追加(このドキュメントのスコープ外)
- `SessionStatus` 自体の再設計(meta テーブル化に留める)
- Ink 以外の UI フレームワークへの移行検討
