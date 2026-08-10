---
name: add-config-option
description: codiva の設定項目（~/.codiva/config.json のキー）を追加・変更するときの手順。core/config.ts の toConfig 検証、bootstrap での配線、SessionOptions への注入、spec、README の設定表までを通す。「設定を追加したい」「config.json のキーを増やす」「デフォルト値を変える」ときに使う。
---

# 設定項目を追加する

設定は **純粋な検証（core）→ 合成ルートで配線（bootstrap）→ 各所へ注入** の一方向。
ファイル I/O は `utils/config.ts`（`~/.codiva/config.json`）だけが行う。

## 1. 型と検証を書く — `src/core/config.ts`

```ts
export interface CodivaConfig {
  // 既存: language / model / effort / permissionMode / maxBudgetUsd /
  //       notifications / mouse / followOrigin / autoPr / ignoredFiles /
  //       ignoredFilesExclude / copyIgnored(非推奨)
  <newKey>?: <型>;
}
```

`toConfig(json)` に検証を追加する。**原則:**

- 全フィールド optional。**不正値は静かに落とす**（キーを書かない）。設定ミスで TUI を
  クラッシュさせない。
- リテラル union は実行時の配列（`EFFORT_LEVELS` 等）で検証する。SDK の union をそのまま
  受けるものは、**型が変わったら型エラーになる形**で書く（`as` で潰さない）。
- 数値は `Number.isFinite` + 範囲チェック（例: `maxBudgetUsd > 0`）。
- 真偽値は「既定 on」なら**保存側では触らず、読み側で `config.x !== false`** と解釈する
  （`followOrigin` / `autoPr` / `notifications` / `mouse` の前例）。
- 非推奨化するときは新旧の解決を純関数に切り出す（`resolveIgnoredFilesMode` の前例）。

## 2. 配線する

どこに注入するかで置き場所が変わる:

| 用途 | 配線先 |
|---|---|
| セッション起動時の SDK options | `SessionOptions`（`core/session.ts`）→ `bootstrap/build-manager.ts` |
| SessionManager の挙動（`followOrigin` / `autoPr` 等） | `SessionManagerDeps`（`bootstrap/build-manager.ts`） |
| 端末・プロセス系（`mouse` 等） | `src/index.tsx` の `setupTerminal` / `bootstrap/runtime.ts` |
| 言語（`language`） | `src/index.tsx` の `resolveLang`（env → config → OS ロケール） |
| worktree の作り方（`ignoredFiles`） | `src/index.tsx` の `new WorktreeManager(...)` |

**core は設定ファイルを読まない**（純粋のまま保つ）。読むのは合成ルート＝`src/index.tsx` と
`src/bootstrap/*`。

## 3. TUI から変更できるようにする場合

**真偽値なら `/config` に 1 行足すだけ**（専用コマンドを作らない）:

1. `core/config-items.ts` の `CONFIG_TOGGLES` に `booleanToggle(...)` を 1 エントリ追加
   （既定値もここで宣言する。既定と同じ値に戻したらキーごと消える）。
2. `core/i18n.ts` の `config` グループに `<key>` と `<key>Help` を **ja / en 両方**。
3. `core/config-items.spec.ts` の表（表示順・既定値）を更新。
4. 反映が次回起動からで良いか確認する（`/config` はそう案内している）。即時反映が要るなら
   下の「値を持ち回すもの」の手順で setter を足し、行ごとの印を導入する。

多肢選択・文字列など**値を持ち回すもの**は `/model` と `/prompt` が前例:

1. `SessionManager` に `getX()` / `setX(v)` を足し、**以降の新規セッション**に適用する
   （稼働中セッションは起動時の値を維持。SDK options は query 開始時に確定するため）。
2. `onXChange(v)` コールバックで合成ルートへ通知。
3. `bootstrap/build-manager.ts` の `saveConfigPatch`（= `bootstrap/config-store.ts` の
   `ConfigStore.update`）へ**差分**で渡す。**`saveConfig` を直接呼ばない** — 丸ごと上書きなので、
   自前のスナップショットを持つと他の書き手（`/config` 等）の変更を消す。
4. UI は `/コマンド` + ダイアログ（skill `add-slash-command` を参照）。

## 4. テスト

- `src/core/config.spec.ts` … テーブルドリブンで「正常値・不正値・未指定」を網羅。
  **不正値が既定へ落ちること**を必ずケース化する。
- `src/utils/config.spec.ts` … 読み書き（壊れた JSON で throw しないこと）。
- 挙動が変わるなら `src/core/session-manager.spec.ts` や `tests/*.test.tsx` も更新。

## 5. ドキュメント

- **ユーザー可視なら `README.md`「設定」節を更新**（既定値と選択肢の意味まで書く）。
- 設計判断（なぜその既定か）は `docs/ARCHITECTURE.md`、SDK options に関わるなら
  `docs/TECH_NOTES.md` の Options 節。

## チェックリスト

- [ ] `CodivaConfig` の型 + `toConfig()` の検証（不正値は既定へ）
- [ ] 合成ルート（`index.tsx` / `bootstrap/*`）での配線
- [ ] TUI から変える場合: manager の get/set + `onXChange` + マージ保存 + コマンド
- [ ] `core/config.spec.ts`（テーブル）＋関連 spec
- [ ] README の設定表（ユーザー可視なら必須）
- [ ] `npm run lint` / `npm run typecheck` / `npm test`
