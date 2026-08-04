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
  `user_input` / `model` / `title` / `pr` / `pr_lookup` / `conflict` / `aborted` / `interrupted` /
  `archived`）。`pr` は「`gh` が答えた」ときだけ流すので `prLookup` も必ずクリアする。
  失敗（`unavailable`）は `pr_lookup: 'error'` で表現し、**`pr` を undefined で上書きしない**
  （PR 番号がポーリングごとに消える不具合の再発防止）。
- **PR は「識別」と「状態」に分けて持つ**。`pr: PrRef`（番号・URL。ブランチに対して不変なので
  **永続化**し、復元直後から `#<n>` を出す）と `prStatus: PrStatus`（マージ可否・チェック・draft。
  揺れるので transient、`core/pr-refresh.ts` の間隔でキャッシュ）。reducer は**半分ずつ**比較して
  参照を維持する: 状態だけ変わったときに `pr` の参照を変えないことで、`persistRelevantChanged`
  （= state.json の保存）がチェックの進行ごとに走らない。番号が分かっていてステータス未取得
  （復元直後・PR 作成直後）は `prPollIntervalMs` が 0 を返し、すぐ取得して埋める。
  全 variant が `at: number` を持ち、reducer は時刻を読まない（純粋・決定的）。
- **SDK メッセージは `CodivaEvent` ではない**。生の形を知るのは `sdk-parse.ts` だけ
  （[sdk-integration.md](./sdk-integration.md)）。
- 状態の確定は `Session.commit` の単一経路。ここが `accrueActive` を呼ぶので、
  個別の遷移に稼働時間の計算を散らさない。

## ログ（`messages`）は上限付き

- **追記の経路は `core/log-buffer.ts` の `pushLogEntry` だけ**（`appendLog` と `sdk-parse` の
  追記もここを通す。例外は `onApiRetry` の**書き換え** = 末尾 1 件の差し替えで、件数を増やさない）。
  `[...state.messages, entry]` を新しく書かない — 上限なしの追記 + 全体コピーが
  **実際にヒープ枯渇で TUI を落とした**（`FATAL ERROR: Ineffective mark-compacts`）。
- 上限は 3 つ: 件数 `MAX_LOG_ENTRIES` / **合計文字数 `MAX_LOG_CHARS`** / 1 件あたり
  `MAX_LOG_ENTRY_CHARS`（`…` を付けて切る）。**件数だけでは何も縛れない**（1 件が 1 文字でも
  20,000 文字でもよい）ので、文字数の予算を外さない。**ログは会話の「記録」ではなく「表示」**で、
  正本は CLI のトランスクリプトなので古い行を落としてよい。
- **`seq` は振り直さない**。描画キー（`<seq>:<行>`）がこれで決まる。ただし**行 index は変わる**ので、
  スクロール位置は落ちた行数ぶんズレ、選択はクリアする（`SessionDetail` が先頭 `seq` の変化で捨てる）。
- 復元（`transcriptLogEntries`）は**読みながら**畳み（`History`）、最後に `capLogEntries` で同じ上限に収める。
- 詳細ビューの行展開（`core/scroll.ts` の `logLines`）は**エントリ単位でメモ化**され、
  保持行数にも上限がある（`MAX_CACHED_ROWS`・LRU。展開後の行は元テキストの数倍を占めるので、
  上限が無いと一過性のゴミが永続的な保持に化ける）。エントリが immutable であること
  （変更時は必ず別オブジェクト）が前提なので `LogEntry` をその場で書き換えない。
  返る `DisplayLine` は read-only 扱い。

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
