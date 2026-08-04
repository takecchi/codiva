---
name: add-session-status
description: codiva の SessionStatus（running / completed / rate_limited など）を追加・変更するときの手順。types.ts の union、STATUS_META、reducer の遷移、theme の色、i18n のバッジ/通知文言、永続化の丸め先、docs の状態機械図までを漏れなく通す。「新しいステータスを追加」「状態を増やしたい」「バッジを増やす」ときに使う。
---

# SessionStatus を追加する

状態は9ファイル前後に波及する。**`STATUS_META` を中心表に据えているので、この順で進めれば
型エラーが漏れを教えてくれる。**背景は `docs/ARCHITECTURE.md`「セッション状態機械」と
[.claude/rules/session-domain.md](../../rules/session-domain.md)。

## 1. union に足す — `src/core/types.ts`

`SessionStatus` に値を追加する。ここを変えた瞬間に `Record<SessionStatus, …>` の
各テーブルが型エラーになる（それが正しい状態）。

必要なら遷移を運ぶ `CodivaEvent` variant も追加する（`kind` + `at: number` は必須）。
**生の SDK メッセージを event にしない**（SDK 形状は `core/sdk-parse.ts` の担当）。

## 2. 性質を決める — `src/core/status-meta.ts`

`STATUS_META` に1行足す。7フィールドすべてを意識して決める:

| フィールド | 問い |
|---|---|
| `terminal` | 差分・マージ/破棄操作を出す状態か |
| `attention` | 一覧で ● 強調してユーザーの操作を促すか |
| `active` | 稼働時間（`activeMs`）を積算する区間か（＝実際に動いているか） |
| `interruptible` | `Ctrl+C`（中断）が意味を持つか（＝ターンが進行中か。`active` と違い `awaiting_*` も true） |
| `resumable` | `r`（再開）で SDK 会話を続行できるか |
| `restoreAs` | アプリ終了時に何へ丸めて保存するか（`undefined` = 保存しない） |
| `notifyKey` | デスクトップ通知の文言キー（`Messages['notify']` のキー。不要なら省略） |

判断の型: 「一時的な停止で待てば解ける」→ `resumable` + `restoreAs: 'interrupted'`。
「ユーザー操作が必須」→ `attention: true`。「作業の失敗」→ `failed` 相当（`resumable` false）。

## 3. 遷移を書く — `src/core/status-reducer.ts` / `src/core/sdk-parse.ts`

- UI/manager 起因なら `reduce` の `case '<kind>'` に追加。
- SDK メッセージ起因なら `sdk-parse.ts` に検知を書く。**分類順は
  認証切れ → レート制限 → 通信断 → `failed`**（`core/errors.ts` のガードを使う）。
  同じ失敗が assistant と result の2回届くので、遷移関数は冪等（同一 detail なら同一参照）にする。
- 状態を `SessionStore` へ直接 set しない（必ず reducer 経由）。

## 4. 表示 — `src/ui/theme.ts` + `src/core/i18n.ts`

- `statusColor` に色を追加（`.tsx` に生 ANSI 名を書かない）。
- `Messages['badge']` にラベル、通知するなら `Messages['notify']` にも追加。**ja / en 両方**。
- バッジの導出は純関数 `badgeFor`（`ui/progress-badge.tsx`）で `Messages` を引数で受ける。
- ユーザーに手順を示す必要がある状態（例: `needs_login` の「別ターミナルで `claude` にログイン」）は
  ヒント文言もカタログへ（`auth.hint` 等の前例に倣う）。

## 5. 永続化 — `src/core/persistence.ts`

`restorableStatus` は `STATUS_META[s].restoreAs` から導出されるので**基本は追加不要**。
ただし読み込み側 `fromPersistedJson` は `completed` / `interrupted` / `failed` のみ受理する
ホワイトリストなので、保存先をそこ以外にするなら合わせて更新する。

## 6. テスト

- `src/core/status-meta.spec.ts` … テーブルドリブンに1行追加（**先に書く**）。
- `src/core/status-reducer.spec.ts` / `sdk-parse.spec.ts` … 遷移のケース。SDK 起因なら
  `src/core/__fixtures__/*.jsonl` の実データで駆動する（無いなら skill `sdk-spike` で採取）。
- `src/core/persistence.spec.ts` … 保存/復元の丸め。
- `src/ui/progress-badge.spec.tsx` … バッジ表示。
- 一覧/詳細の挙動が変わるなら `tests/app.test.tsx`。

## 7. ドキュメント

`docs/ARCHITECTURE.md`「セッション状態機械」の遷移図と説明に追記する（**実装より先か同 PR 内**）。

## チェックリスト

- [ ] `types.ts` の union（＋必要なら `CodivaEvent`）
- [ ] `status-meta.ts` の6フィールド
- [ ] reducer / sdk-parse の遷移（分類順を守る）
- [ ] `theme.statusColor` + `i18n` の badge / notify（ja・en）
- [ ] persistence の受理リスト（必要時）
- [ ] spec 4種 + 必要なら `tests/app.test.tsx`
- [ ] `docs/ARCHITECTURE.md` の状態機械
- [ ] `npm run lint` / `npm run typecheck` / `npm test`
