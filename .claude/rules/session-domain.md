# セッションドメイン規約

`SessionStatus` / `reduce` / 永続化まわりの不変条件。**セッションの状態・遷移・保存に触るときに読む。**
背景と設計理由は [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md)「セッション状態機械」。

## 状態の一覧（`core/types.ts`）

```
creating / running / awaiting_permission / awaiting_input / completed
interrupted / rate_limited / needs_login / failed / conflict / archived
```

- `interrupted` / `rate_limited` / `needs_login` は **resumable な idle**（エラーではない）。
  `failed` と混同しない。分類の根拠は `core/errors.ts`（`isAuthError` → `isRateLimitError` →
  `isConnectionError` の順に判定。**認証切れを最優先**）。
- `conflict` はマージ競合の可視化専用。自動解消しないので**終端状態**として扱う。

## 遷移の唯一の経路は reducer

- 状態を作るのは `reduce(state, CodivaEvent)`（`core/status-reducer.ts`、純関数）と
  `applySdkMessage(state, SDKMessage, at)`（`core/sdk-parse.ts`）だけ。**`SessionStore` に
  `status` を手書きで set しない**（過去に provision 失敗が reducer を迂回して、以後
  `send`/`allow` が黙って no-op になる不具合を作った）。失敗も
  `reduce(state, { kind: 'aborted', error, at })` を通す。
- `CodivaEvent` は UI/manager 由来のアクションのみ（`permission_request` / `permission_resolved` /
  `user_input` / `model` / `title` / `pr` / `conflict` / `aborted` / `interrupted` / `archived`）。
  全 variant が `at: number` を持ち、reducer は時刻を読まない（純粋・決定的）。
- **SDK メッセージは `CodivaEvent` ではない**。生の形を知るのは `sdk-parse.ts` だけ
  （[sdk-integration.md](./sdk-integration.md)）。
- 状態の確定は `Session.commit` の単一経路。ここが `accrueActive` を呼ぶので、
  個別の遷移に稼働時間の計算を散らさない。

## 状態の「性質」は STATUS_META が唯一の表

`core/status-meta.ts` の `STATUS_META: Record<SessionStatus, StatusMeta>` に集約する。
UI・永続・通知は**この表を参照**し、独自の集合（`TERMINAL` set 等）を作らない。

| フィールド | 用途 | 参照側 |
|---|---|---|
| `terminal` | 終端＝差分/操作を出す | `isTerminalStatus`（detail/list/manager） |
| `attention` | 一覧の ● 強調 | `needsAttention`（list） |
| `active` | 稼働時間を積算する区間 | `isActiveStatus`（`accrueActive`） |
| `resumable` | 再開アクション `r` の可否 | `isResumable`（両 view） |
| `restoreAs` | 保存時に丸める先 | `persistence.restorableStatus` |
| `notifyKey` | デスクトップ通知の文言キー | `core/notify.ts` |

`Record<SessionStatus, …>` なので状態を増やすと**型エラーで漏れが分かる**。この性質を壊さない。
状態を1つ増やす手順は skill `add-session-status` に従う。

## 永続化（`core/persistence.ts` / `utils/state-store.ts`）

- 保存対象の条件（`toPersistedSession`）: `restorableStatus(status)` が定義済み **かつ**
  `worktreePath` あり **かつ** `sdkSessionId` あり。`creating` / `conflict` / `archived`、および
  init 前に落ちて resume 不能なものは保存しない。
- 読み込み側（`fromPersistedJson`）は `completed` / `interrupted` / `failed` のみ受理し、
  壊れた JSON は空状態へフォールバックする（TUI を落とさない）。
- **会話ログは永続しない**。復元時は CLI のトランスクリプトから再構築する
  （`core/transcript.ts` + `utils/transcript.ts`）。state.json はメタデータのみに保つ。
- 稼働時間は wall-clock ではなく `activeMs` + `activeSince`（`active` な区間だけ積算）。
  保存時は `activeElapsedMs` で開いているセグメントを畳んで凍結し、復元時は `activeSince`
  を未設定にする（オフライン時間を数えない）。

## 終了とライフサイクル

- アプリ終了は `stop()`（quiet 停止。状態を変えずサブプロセスだけ落とす）。`abort()` は
  `failed` にするので「1件破棄」専用。両者を混同しない。
- `stop()` / 再開可能状態へ落ちる前に**保留中の許可を deny で解決**する。未応答の `tool_use`
  で終わるトランスクリプトは後の resume を壊す。
- 復元セッションは `start()` せず、最初の `send()` で遅延 resume（起動時にサブプロセスを乱立させない）。
- 1 SDK セッション 1 ライター。codiva 以外（外部 `claude --resume` 等）から同じセッションに繋がない。

## DI seam とファサード

- DI 用の interface は `core/session-ports.ts`（leaf）に集約する。ここに置くことで
  core 内の循環 import を防いでいるので、`WorktreeService` / `SessionHandle` / `PrAutomation` /
  `PrLookup` を他ファイルで再定義しない。
- `SessionManager` は**ファサード**。責務を戻さない:
  `session-store.ts`（購読と参照同一性）/ `session-actions.ts`（merge・discard・diffStat）/
  `pr-coordinator.ts`（autoPr・refreshPrs）/ `run-mode.ts`（`auto`⇄`confirm` ポリシー）/
  `persistence.ts`（`assemblePersistedState`）。
- スナップショットは毎回新配列だが、**変更のないセッションのオブジェクト参照は維持**する
  （`useSessions` の再描画抑制がこれに依存している）。
