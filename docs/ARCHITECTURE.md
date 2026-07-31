# アーキテクチャ設計: codiva

## レイヤ構成

UI とコアロジックを完全に分離する。コアは Ink/React に一切依存せず、単体でテスト可能にする。

```
┌─ ui/ (Ink + React) ────────────────────────────────┐
│  App / SessionList / PromptInput                    │
│  PermissionDialog / ProgressBadge                   │
│        ▲ useSyncExternalStore で購読                 │
└────────┼────────────────────────────────────────────┘
┌────────┴─ core/ (純TypeScript, UIなし) ─────────────┐
│  SessionManager … セッションの生成・保持・イベント発火   │
│  Session        … 1セッション = SDK query + 状態     │
│  reduce()       … CodivaEvent → SessionState 畳み込み│
│  Worktree 型 / MergeConflictError / 純関数            │
└────────┬────────────────────────────────────────────┘
┌────────┴─ utils/ (I/O ラッパ, core にのみ依存) ──────┐
│  WorktreeManager… git worktree の作成・削除・マージ   │
│  git() / config / state-store / pr / notify …        │
└────────┬────────────────────────────────────────────┘
┌────────┴─ 外部 ─────────────────────────────────────┐
│  @anthropic-ai/claude-agent-sdk (query)             │
│  git CLI (worktree / diff / merge)                  │
└─────────────────────────────────────────────────────┘
```

依存方向は一方向（`ui → core ← utils`）。`WorktreeManager` は fs + git 実行の I/O 具象なので
utils レイヤに置く（`core` は node の I/O を import しない）。`core/worktree.ts` には純粋な型
（`Worktree` / `DiffStat`）・`MergeConflictError`・`ignoredCopyEntries()` だけを残し、
`SessionManager` は `WorktreeService` インターフェース越しに具象を DI で受ける。

`src/index.tsx` / `src/app.tsx` / `src/bootstrap/` は**合成レイヤ**（どのレイヤにも属さず core と utils を
束ねる）。副作用の配線（manager 組み立て・復元・永続・端末モード・PR ポーリング）は `bootstrap/` に切り出し、
`index.tsx` は「解決 → preflight → build → restore → render → shutdown」の直列だけに保つ。

## ディレクトリ構造

```
codiva/
├── src/
│   ├── index.tsx              # bin エントリ。解決 → preflight → build → restore → render → shutdown（合成ルート・薄い）
│   ├── app.tsx                # ルートコンポーネント。list ⇔ detail のビュー切替
│   ├── bootstrap/             # 副作用の配線（合成の分解。core/utils にのみ依存）
│   │   ├── build-manager.ts   # config + I/O seam → SessionManager 組み立て + /model の config 永続・/prompt の prompt.md 永続
│   │   ├── restore-sessions.ts # state.json + transcript から復元
│   │   ├── persist-controller.ts # debounce保存 / SIGTERM同期flush / 最終flush を集約
│   │   └── runtime.ts         # PRポーリング・alt-screen/mouse・SIGTERM/SIGHUP フラッシュ
│   ├── core/                  # 純粋ドメイン（Ink/React/node/utils 非依存。SDK は型 + 定数のみ）
│   │   ├── index.ts           # バレル（export *）
│   │   ├── types.ts           # SessionState, SessionStatus, CodivaEvent 等の型定義
│   │   ├── status-reducer.ts  # reduce(state, CodivaEvent): SessionState（型付きイベントのみ・純関数）
│   │   ├── sdk-parse.ts       # applySdkMessage()（SDK メッセージ形状の解釈を集約・純粋）
│   │   ├── status-meta.ts     # STATUS_META（terminal/attention/active/resumable/復元先/通知キーの一元表）
│   │   ├── session.ts         # 1 SDK query のライフサイクル
│   │   ├── session-store.ts   # 購読可能スナップショット（順序・状態・参照同一性保持）
│   │   ├── session-manager.ts # create/restore/dispose + passthrough のファサード
│   │   ├── session-actions.ts # merge/discard/diffStat（git 操作の純粋オーケストレーション）
│   │   ├── pr-coordinator.ts  # PrCoordinator（autoPr/refreshPrs）
│   │   ├── run-mode.ts        # RunMode + createModePolicy
│   │   ├── session-ports.ts   # DI seam の interface 集約（WorktreeService/SessionHandle/…）
│   │   ├── worktree.ts        # Worktree 型 + MergeConflictError + ignoredCopyEntries（純粋）
│   │   ├── list-hit.ts        # 一覧のマウス当たり判定（純粋）
│   │   ├── format.ts / math.ts / ansi.ts / errors.ts   # 小さな純粋ヘルパ（formatDuration/clamp/…）
│   │   ├── privacy.ts        # 学習データ利用（grove）の判定（JSON→TrainingOptIn・純粋）
│   │   ├── async-queue.ts / slug.ts / config.ts / cost.ts / notify.ts / persistence.ts / update.ts
│   │   ├── scroll.ts / text-buffer.ts / layout.ts / mouse.ts / key-sequence.ts / model.ts / models.ts / transcript.ts
│   │   ├── *.spec.ts          # 単体テストは実装の隣に co-located
│   │   └── __fixtures__/      # サニタイズ済み実 SDK メッセージ（sdk-parse テスト用）
│   ├── ui/                    # Ink コンポーネント（kebab-case, 識別子は PascalCase）
│   │   ├── index.ts           # バレル
│   │   ├── theme.ts           # アクセント色・状態色・logColor・グリフ（色は必ずここ経由）
│   │   ├── banner.tsx         # 起動時ヘッダ（マスコット + プラン/モデル + cwd + 使用状況ゲージ, 枠なし）
│   │   ├── session-list.tsx   # 一覧画面（composer/list の2フォーカスゾーン）
│   │   ├── session-detail.tsx # 詳細画面（ログ + 追加指示 + マージ/破棄。SDK セッションに直結）
│   │   ├── prompt-input.tsx   # 上下横罫線 + ❯ キャレットの入力欄（presentational）
│   │   ├── repo-prompt-editor.tsx # /prompt のリポジトリ追加指示エディタ（モーダル・composer を置換）
│   │   ├── dialog-box.tsx / confirm-prompt.tsx  # 共有 presentational（角丸枠・y/n 確認行）
│   │   ├── update-dialog.tsx  # /update の表示（presentational・useInput を持たない）
│   │   ├── status-footer.tsx / permission-dialog.tsx / model-select.tsx / command-palette.tsx / progress-badge.tsx
│   │   ├── hooks.ts           # useSessions / useClock / useTextBufferRef / useCommandRunner / useLifecycleAction
│   │   └── input.ts           # キー→テキストバッファ操作の対応（editText/resolveEnter/normalizeChord）
│   └── utils/                 # すべての I/O（core にのみ依存＝一方向）
│       ├── index.ts           # バレル
│       ├── git.ts             # execFile ベースの git 実行ヘルパ
│       ├── worktree-manager.ts # WorktreeManager（git worktree の I/O）
│       ├── exec.ts / terminal-mode.ts  # fireAndForget / toggleEscape（共通 I/O ラッパ）
│       ├── config.ts          # ~/.codiva/config.json の読み書き
│       ├── repo-prompt.ts     # <repo>/.codiva/prompt.md の読み書き（loadRepoPrompt / saveRepoPrompt）
│       ├── privacy.ts        # 学習データ利用の状態取得（~/.claude.json キャッシュ → 非公開 API）
│       ├── notify.ts / open-url.ts / pr.ts / title.ts / transcript.ts
│       ├── alt-screen.ts / mouse.ts    # alt screen / SGR マウスの有効化・無効化
│       └── state-store.ts     # <repo>/.codiva/state.json の読み書き + prune
├── scripts/
│   └── spike.ts               # Phase 1: SDK 挙動検証スクリプト
├── tests/                     # App 全体を通す機能/統合テスト（*.test.tsx）+ helpers.ts（共有フェイク）
└── docs/                      # 本ドキュメント群

# テスト: 単体は実装隣の *.spec.ts、機能/統合は tests/*.test.tsx。
# import は `@/*` → `./src/*` エイリアス（ディレクトリ跨ぎ）。ビルドは tsup、型チェックは tsc --noEmit。
```

## セッション状態機械

`SessionStatus` の遷移。導出元はすべて SDK メッセージストリームと canUseTool コールバック。

```
 creating ──(worktree作成完了 & query開始)──▶ running
 running ──(canUseTool 発火)───────────────▶ awaiting_permission
 awaiting_permission ──(ユーザー応答)────────▶ running
 running ──(result 受信 & 質問で終了)────────▶ awaiting_input
 running ──(result 受信 & 正常終了 & サブエージェント未稼働)──▶ completed
 running ──(result 受信 & サブエージェント稼働中)──▶ running    # 結果を deferredResult に保留し running 継続
 running ──(最後の task_notification で全タスク完了 & 保留結果あり)──▶ completed
 running ──(result subtype がエラー系)───────▶ failed
 running ──(レート制限に到達)─────────────────▶ rate_limited # rate_limit_event(rejected) / error='rate_limit' / usage-limit result・throw
 running ──(認証切れ)───────────────────────▶ needs_login  # assistant error='authentication_failed' / is_error 付き result / auth 文言の errors[]・throw
 awaiting_input ──(追加指示送信)─────────────▶ running
 completed ──(追加指示送信)─────────────────▶ running   # 完了後の追加作業も許す
 running ──(通信断で query が throw / エラー result & sdkSessionId あり)──▶ interrupted # 接続中断。resumable
 running ──(応答途中で API エラー)───────────▶ interrupted # assistant error='server_error'/'overloaded' / terminal_reason='api_error' & 一時的な status
 * ──(query の throw / abort)──────────────▶ failed  # 通信断以外（or sdkSessionId 無し）
 completed ──(マージで競合検知 → merge --abort)──▶ conflict  # 自動解消しない。解消は人手（終端扱い）
 conflict ──(手動解消後の再マージ or 破棄)────▶ archived
 completed ──(マージ or 破棄)────────────────▶ archived
 running/awaiting_* ──(アプリ終了 → 保存)────▶ interrupted # メモリ上は状態不変。保存時に丸める（restorableStatus）
 rate_limited ──(アプリ終了 → 保存)──────────▶ interrupted # 制限は一時的。復元時は resumable な interrupted に丸める
 needs_login ──(再ログイン後 追加指示 / 再開アクション)──▶ running # 認証が戻れば同じ SDK 会話を resume
 needs_login ──(アプリ終了 → 保存)───────────▶ interrupted # 次回起動時には再ログイン済みかもしれない
 interrupted ──(追加指示送信 / 再開アクションで resume)───────▶ running # 生存中セッションもその場で再開（consume ループ再起動）
```

`interrupted` は「クリーンに完了していないが resume で続行できる」セッションを表す。発生元は3つ:
(1) **通信断**（`Session.consume` の for-await が throw、または接続断を示すエラー `result`。`core/errors.ts`
の `isConnectionError` で判定し、resume 元となる `sdkSessionId` がある場合のみ。無い＝init 前の早期失敗は
`failed`）。(2) **応答途中の API エラー**（後述）。(3) **アプリ終了時の丸め**（`restorableStatus` が実行中/
入力待ちを保存時に `interrupted` にする。`stop()` はメモリ上の状態を変えない）。いずれも `completed` と同じく idle で resumable。追加指示または
**再開アクション（一覧/詳細の `r`）** で resume できる — 送信すると `SessionManager.send` → `Session.send`
が（通信断で終了した）consume ループを `resume: sdkSessionId` 付きで**再起動**し、同じ SDK 会話を続行する
（生存中セッションでもその場で再開でき、アプリ再起動を待たなくてよい）。通信断遷移時はデスクトップ通知
（`notify.interrupted`）で中断をユーザーに知らせる。判定ヘルパは `core/status-meta.ts` の `isResumable`
（`STATUS_META[status].resumable` = `interrupted` / `rate_limited` / `needs_login`）。再開時に送る指示文は
`core/resume.ts` の `resumeInstruction(status, m)`（既定は `resume.instruction`、認証切れは
`resume.authInstruction`）。

**復帰はワンプッシュ**（`Ctrl+R`）。中断の原因（通信断・レート制限・認証切れ）に関わらず、一覧でも詳細でも
**フォーカス／操作パネルの状態に関係なく**効く chord にしてある。フォーカス依存のキー（一覧リストの `r`、
詳細の操作パネルの `r`）は「Tab で移動 → r」の2手が必要で、既定フォーカスが入力欄である以上それは
「楽なリカバリ」にならない。印字キーを潰さない chord なので、入力中に打っても文字が化けない。
案内（`resume.oneKeyHint` / 認証切れは `auth.hint`）はフッタではなく**独立した行**として出す —
フッタヒントはフォーカスで切り替わるので、入力欄にいる間だけ復帰方法が消えてしまう。

**一括再開は `Ctrl+A`**（一覧のみ、2件以上のときだけ、y/n 確認あり）。回線が落ちる・蓋を閉じると走って
いたセッションが揃って中断されるため、1件ずつ選び直させない。対象は `core/resume.ts` の
`resumableSessions(sessions)`（純関数）で、件数を `resume.allHint(n)` / `action.resumeAllPrompt(n, auth)`
に出す。単体の `Ctrl+R` が確認なしで即送るのに対し一括は確認を挟む（全中断セッションへ同時に指示 =
誤爆が課金に直結するため）。確認文には**認証切れの件数**も出す — `needs_login` には「ログインし直した」
という指示文を送るので、まだログアウトのままだと transcript に嘘が残る。
自動リトライはしない（勝手に走り出さない・意図せず課金が進まないことを優先）。

**多重送信の防止は `SessionManager.resume(id, instruction)`** に置く（View ではなく core 側）。UI の
ストア購読は ~100ms スロットルなので、送信直後もビュー側の status は `interrupted` のまま見える —
キーの連打・オートリピートで同じ指示が2回積まれると二重課金＋ログ二重化になる。`resume()` は
**ストアの現在値**（`send` が同期的に `running` へ進める）で `isResumable` を確かめてから送り、送ったかを
返す。View（`Ctrl+R` / 一覧の `r` / 一括）はすべてこれを経由する。

**応答途中の API エラー（`API Error: Connection closed mid-response.`）**: ストリーミング中に接続が切れると
CLI は「そこまでの部分応答を確定させて」ターンを終える。ワイヤ上は `error: 'server_error'` を立てた
assistant メッセージ（本文が `API Error: Connection closed mid-response. The response above may be
incomplete.`）→ それを集約する `result`（`subtype: 'success'` + `is_error: true` +
`terminal_reason: 'api_error'` + `api_error_status: null`）の2連で届く。応答は途中で切れているのに
`subtype` だけ見ると成功なので、素直に扱うと**尻切れの回答が緑の「Completed」になる**。判定は2段構え:

1. **assistant メッセージの型付き `error` 種別**（`isTransientApiErrorKind` = `server_error` / `overloaded`）。
   文言・ロケールに依存しないのでこれが主シグナル。`max_output_tokens` は CLI がターンを継続して回復する
   ため対象外、`invalid_request` / `billing_error` は再試行で直らないので `failed` のまま。対象は
   **トップレベルターンのみ**（`parent_tool_use_id` が null）— サブエージェント内の同種エラーは失敗した
   tool_result として本体ターンへ返り Claude が回避できるので、セッションは止めない。
2. **result の `terminal_reason: 'api_error'` + `api_error_status`**（`isTransientApiStatus`。明示的な
   `null`＝HTTP 応答すら無い接続断、5xx/408/429 が一時的）。CLI の文言は多数（`Server error
   mid-response` / `Response stalled mid-stream` / `Please wait a moment and try again` …）で変わりうる
   ため、`isConnectionError` の文字列一致は最後の保険として残す。**フィールドが無い（`undefined`）場合は
   一時的扱いにしない** — `api_error_status` は success バリアントにしか存在せず、`error_during_execution`
   の result では欠落が何も意味しないので、欠落を「HTTP 応答無し」と読むと 400 まで resumable になる。

どちらも `toInterrupted` に落ちる。同じ失敗が assistant → result の2回届くため:

- `toInterrupted` は **最後の `system` ログが同文なら no-op**（`status === 'interrupted'` の間だけ）。
  間に別のログ（宙ぶらりんの tool_use に対する tool_result 等）が挟まっても重複しない。
- result 側は **すでに resumable な状態（`isResumable` = interrupted / rate_limited / needs_login）なら
  コストだけ拾って再分類しない**。型付きシグナルの方が文言判定より正確なので、CLI の言い回しが未知な
  ときに「ログインし直し」を `failed` の袋小路へ落とさない。

加えて `system/api_retry`（CLI が再試行する時に流れる）を system ログへ1行残す — 出さないと不安定な回線が
「ただ止まっている」ようにしか見えず、再試行が尽きた時の中断通知に前後の文脈が残らない。連続する再試行は
**同じ行を書き換える**（1リクエストで最大 `max_retries` 件来るので、追記すると会話がビューポートから
押し出される）。ダイアログ保留中に中断した場合は `Session.commit` が canUseTool の Promise を deny して
解決する（未応答の tool_use で transcript が終わると後の resume が失敗しうる）。

**サブエージェント（Task ツール）の完了ゲート**: サブエージェントが **バックグラウンド実行**されると、
その tool_result は即座に返り本体ターンは続行するため、サブエージェントがまだ稼働中でも**トップレベルの
`result/success` が先に届く**。この result をそのまま `completed` にすると、実際には作業継続中なのに
バッジが「Completed」へ倒れてしまう（本 issue の不具合）。対策として `system/task_started` /
`system/task_notification` で稼働中タスク集合（`activeTaskIds`）を追跡し、result 受信時にタスクが残って
いれば `completed` にせず結果を `deferredResult` に保留して `running` を維持する。最後のタスクが
`task_notification` で settle し集合が空になった時点で保留結果を使って `completed` を確定する
（`sdk-parse.ts` の `onTaskStarted` / `onTaskSettled` / `completeWith`）。`skip_transcript` の雑務タスクは
ゲート対象外。`activeTaskIds` / `deferredResult` は transient で永続しない。実データは
`__fixtures__/session-subagent.jsonl`（スパイクの `subagent` シナリオで採取）。

`rate_limited` は「使用量／レート制限に達して止まった」セッションを表す。`completed`/`failed` と同じく
idle だが、エラー扱い（`failed`）にはせず「制限が解けるのを待って再開できる」状態として区別する。
検知元は SDK の `rate_limit_event`（`rate_limit_info.status === 'rejected'`）、assistant メッセージの
`error === 'rate_limit'`、および usage-limit を示す `result`／throw されたエラー文言（`isRateLimitError`。
SDK の `USAGE_LIMIT_ERROR_PREFIXES` に追従）。制限は一時的なので保存時は `interrupted` に丸める。

`needs_login` は「Claude の認証が切れて止まった」セッションを表す。作業自体の失敗ではなく、ユーザーが
別ターミナルで `claude` に `/login` し直せば resume できるので、`failed` とは区別する。

**とくに `completed` にしてはいけない**。CLI は認証エラーを次の2メッセージで報告する（実バイナリで確認）:

```jsonc
// 1) CLI が合成する assistant メッセージ（型付きの error フィールドが本体）
{"type":"assistant","error":"authentication_failed",
 "message":{"content":[{"type":"text","text":"Failed to authenticate: OAuth session expired and could not be refreshed"}]}}
// 2) それを畳み込む result。subtype は "success" のまま is_error が立つ
{"type":"result","subtype":"success","is_error":true,"terminal_reason":"api_error",
 "result":"Failed to authenticate: OAuth session expired and could not be refreshed"}
```

`subtype === 'success'` だけを見て完了扱いにすると「何も作業していないのに緑の Completed」になり、
auto-PR まで走ってしまう（本 issue の不具合）。そのため result 処理は **`subtype === 'success' && !is_error`
のみを完了**とし、それ以外は文言分類（認証 → レート制限 → 通信断 → `failed`）へ流す。エラー系 subtype は
`result` を持たず `errors: string[]` で理由を運ぶ（`SDKResultSuccess` / `SDKResultError`）ので両方を読む。

検知の優先順は次の通り:

1. **assistant メッセージの型付き `error`**（`core/errors.ts` の `isAuthErrorKind` = `authentication_failed`
   / `oauth_org_not_allowed`）。`SDKAssistantMessageError` として型定義されており文言・ロケールに依存しない
   ため、これを一次シグナルにする（既存の `error === 'rate_limit'` フックと同じ位置）。
   `billing_error`（残高不足）は再ログインで直らないので対象外＝ `failed` のまま。
2. **`is_error` 付き result**、および認証文言を含む `result` / `errors[]` / throw された例外
   （`isAuthError`。CLI の実文言 = OAuth 失効・トークン失効・APIキー不正・クラウド資格情報失効・
   `/login` 指示・re-authenticate を網羅する二次シグナル）。

認証切れは待っても直らないので、レート制限・通信断より**先に**判定する（`Session.consume` の throw 経路も
同様。`Failed to authenticate through the broker: request timed out` のような文言を通信断と誤分類しない）。
再開可能な状態へ落ちるときは保留中の許可を deny して解決しておく（宙ぶらりんの tool_use は後の resume を
失敗させ得る。`stop()` と同じ理由）。同じ失敗が assistant と result の2回届くため `toNeedsLogin` は
冪等（同一 detail なら同一参照を返す）。

`attention: true`（一覧に ● を出す）なのは、`rate_limited` と違い放置しても解決せずユーザーの操作が
必須だから。UI は「別ターミナルで `claude` にログインして再開」という手順そのものを出す
（i18n `auth.hint` / `auth.listHint`）。保存時は `interrupted` に丸める（次回起動時には再ログイン済みかも
しれない）。なお `auth_status` メッセージは CLI の対話的 `/login` UI 用で、`--enable-auth-status`
オプトイン時のみ流れる（この SDK 版の型にも無い）ため API 認証エラーの検知には使えない。

`rate_limit_event` は `rejected` でセッションを `rate_limited` にする一方、`allowed` / `allowed_warning`
も含めて **アカウント全体の claude.ai サブスクリプション使用状況**（5時間枠・週次枠など）を運んでくる。
これはセッション状態ではなくアカウント横断の情報なので、`Session` は `onRateLimit`（DI）で生の
`rate_limit_info` を `SessionManager` へ渡し、manager が **ウィンドウ種別ごとに最新値**を保持する
（`core/rate-limit.ts` の `toRateLimitWindow` で正規化 = `resetsAt` は秒→ms、`utilization` は 0-100%）。
`getRateLimits()` は表示順にソートした安定参照を返し、`Banner` が `useRateLimit` で購読して
「現在のセッション ████░░░░ 42% 2時間45分後にリセット」のように描画する（枠が無い＝API キー利用時は非表示）。

#### プラン表示と使用状況ポーリング（ヘッダ）

`rate_limit_event` は **セッションがターンを回している間しか届かない**ので、起動直後や全セッションが
待機中のときは何も出せない。そこで Claude Code のステータスライン相当の表示を作るため、SDK の
control channel を叩く **probe** を第2の情報源として足している。

```
                    ┌─ Session.onRateLimit ──▶ rate_limit_event（ターン開始ごと・status を持つ）─┐
アカウント横断の情報 ─┤                                                                          ├─▶ SessionManager
                    └─ bootstrap/usage-poller ─▶ utils/usage-probe（5分ごと・plan と utilization）┘
```

- **probe の作り**（`utils/sdk-probe.ts`）: `query()` を streaming-input で開き、**何も送らないまま**
  control channel の応答（`supportedModels()` / `accountInfo()` /
  `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET()`）だけを読んで即 abort する。
  推論は走らないのでトークン消費はゼロ。`fetchModelCatalog` もこの共通基盤に載せ替えた。
- **プラン名の出所は `accountInfo()` だけ**（`core/account.ts` の `toAccountSummary`）。
  `subscriptionType`（例 `'Claude Team'`）は SDK 由来の表示文字列なのでそのまま出す
  （i18n の例外。モデル名と同じ扱い）。組織名は Team / Enterprise のときだけ付く。
- **usage 応答の解釈は `core/usage.ts` だけ**（`toUsageSnapshot`）。実測（TECH_NOTES 参照）で
  **`rate_limits_available: true` でも `rate_limits: null` があり得る**ため、「available」を根拠に
  枠を描かない。枠が無ければイベント側の情報だけで表示する。
- **2つの情報源の合流は `mergeUsageWindow`**（純関数）。usage 応答には `status` が無く、実際の
  `five_hour` イベントには `utilization` が無いので、どちらも他方の上位集合ではない。フィールド単位で
  合流し、`status` は最後にイベントが言った値を引き継ぐ。表示に影響が無ければ **同一参照を返す**
  （`useRateLimit` / `useAccount` の再描画抑制がこれに依存）。
- **ポーリング間隔は 5 分**（`bootstrap/usage-poller.ts`）。枠自体が 5時間／7日単位で、リセットまでの
  カウントダウンは `useClock` がローカルで毎秒進め、稼働中セッションはターンごとにイベントを押してくる
  ——ので、ポーリングは「待機中を埋める」役でよい。1回ごとにサブプロセスが1本立つため秒単位にはしない。
  **2回連続で何も取れなければ停止**する（API キー / Bedrock / Vertex ログインでは永久に取れないため）。
- **表示先はヘッダ（`Banner`）だけ**。プラン行は `bannerLines()`、使用状況の行（ゲージ + 使用率 +
  残り時間）は `bannerUsageRows()` + `gaugeCells()` が組む（記号は `theme.ts`。詳細は下の `Banner` の項）。
  **`utilization` が無い枠にゲージは描かない**（0% と読めてしまうため、残り時間だけ出す）。
- **`StatusFooter` は使用状況を持たない**。以前はフッタ右端にもプラン名 + 上位2枠を出していたが、
  1行に収めるための段階的縮退（2枠 → 1枠 → ゲージ → プラン名）が必要で、モードとヒントという
  フッタ本来の情報が読みづらくなっていた。**プラン / 使用状況はヘッダへ集約**し、フッタは
  「モード表示（縮まない） + ヒント（唯一縮む）」の2要素だけにした（どの幅でも1行を保つ点は不変で、
  `status-footer.spec.tsx` が実際の描画幅で検証している）。ヘッダを持たない詳細ビューでは出ない
  （見たいときは Esc で一覧へ戻る）。

`SessionState`（UI が購読する不変スナップショット）:

```typescript
interface SessionState {
  id: string;
  title: string;              // タスク名。起動直後は指示文由来の暫定値、Haiku 要約が返り次第差し替え（title イベント）
  status: SessionStatus;
  prompt: string;             // 最初の指示文
  branch: string;             // codiva/<slug>
  worktreePath: string;
  todos: TodoItem[];          // TaskCreate/TaskUpdate（+ 旧 TodoWrite）から構築した最新スナップショット
  progress?: { done: number; total: number }; // todos から導出
  messages: LogEntry[];       // 整形済みログ。SessionDetail のログビューで表示し、復元時は SDK transcript から再構築
  pendingPermission?: PermissionRequest;      // awaiting_permission / awaiting_input 時のみ
  sdkSessionId?: string;      // system/init から取得。resume 用に保持
  model?: string;             // セッション個別のモデル上書き（/model）
  pr?: PrRef;                 // 検知した PR の番号・URL（ブランチに対して不変。**永続する**）
  prStatus?: PrStatus;        // merge 可否 / checks / draft（揺れる。transient・期限付きキャッシュ）
  prLookup?: PrLookupState;   // 'loading'（確認中）/ 'error'（gh が答えられなかった）。transient
  conflictFiles?: string[];   // conflict 時の競合ファイル（自動解消はしない）
  startedAt: number;
  finishedAt?: number;
  activeMs: number;           // 「実際に動いた時間」の累積（active な区間のみ積算）
  activeSince?: number;       // 現稼働セグメントの開始時刻（idle なら未設定）
  totalCostUsd?: number;      // result の total_cost_usd 累計
  error?: string;
  rateLimitResetsAt?: number; // rate_limited のときの解除予定時刻
  streamingText?: string;     // stream_event の text_delta プレビュー（transient・永続しない）
  activeTaskIds?: string[];   // 稼働中のサブエージェント（完了ゲート用。transient）
  deferredResult?: { at: number; totalCostUsd?: number; resultText: string }; // 保留した result（同上）
  logSeq: number;             // LogEntry の採番カウンタ
}
```

### 状態導出ルール

- **Step n/m**: `assistant` メッセージ内の tool_use から TODO スナップショットを構築する。`TodoWrite`（`input.todos` 配列で全置換）と `TaskCreate`/`TaskUpdate`（増分更新）の**両方に対応**する（SDKの世代により流れてくるツールが異なる。TECH_NOTES.md 参照）。`done = status === 'completed' の数`, `total = 全数`。
- **質問あり**: Claude がユーザーへの質問に使う `AskUserQuestion` ツールは、allow ルールに関係なく必ず `canUseTool` コールバックに届く（公式仕様）。`toolName === 'AskUserQuestion'` を検知したら `awaiting_input` に遷移し、質問と選択肢を UI に表示。ユーザーの回答を `updatedInput` に載せて allow で返す。補助として、`result` 受信時に直近 assistant テキストが疑問文で終わる場合も `awaiting_input` にする（ツールを使わず地の文で質問するケース）。
- **許可待ち**: `canUseTool` コールバック（`AskUserQuestion` 以外）が呼ばれたら `PermissionRequest` を state に積み、UI の応答で Promise を resolve する。コールバックの Promise が解決されるまでセッションはブロックされる（公式仕様として保証）。

## 主要クラスの責務

### Session (`core/session.ts`)

1セッションのライフサイクルを保持する。

- コンストラクタで `queryFn`（SDK の `query` 関数）を **DI で受け取る**。テストでは合成メッセージストリームを注入する。
- streaming input mode を常用: `query()` の prompt に自前の `AsyncGenerator<SDKUserMessage>` を渡し、内部キュー（push可能な async queue）で管理。`send(text)` でいつでも追加メッセージを投入できる。
- 受信ループ: `for await (const msg of query)` で各 SDK メッセージを `applySdkMessage()`（`core/sdk-parse.ts`）に畳み込む。SDK メッセージ形状の解釈はここに閉じ、純粋 reducer（`reduce(state, CodivaEvent)`）は型付きイベントだけを扱う。UI アクション（追加指示・許可・モデル切替等）は `reduce` へ dispatch。変更のたびに `onChange` を発火。
- `respondToPermission(result)`: 保留中の canUseTool Promise を resolve。
- `interrupt()` / `abort()`: SDK の interrupt / AbortController。
- `SessionOptions`（`model`/`effort`/`permissionMode`/`maxBudgetUsd`/`appendSystemPrompt`/`ignoredFiles`）を DI で受け、`query()` の `options` に反映（設定ファイル由来）。`permissionMode` 未指定時は `acceptEdits`。
- **systemPrompt の組み立ては純関数 `core/system-prompt.ts`（`composeSystemPrompt`）**。要素は「worktree の環境説明」→「リポジトリ追加指示」の順（前提の説明が先、著者の具体的な指示が後）で、どちらも無ければ `undefined`（= `systemPrompt` を渡さない）。`session.ts` は文言も結合順も持たない。
- **worktree の環境説明（共有 symlink の注意書き）**: `ignoredFiles: 'symlink'`（既定）では ignore 済みパスが元リポジトリの実体を指すため、セッションが依存更新やビルドを走らせるとメインチェックアウトと並行セッションに波及する。そこで**このモードのときだけ** `SHARED_IGNORED_FILES_NOTICE` を systemPrompt に載せ、「読むのは安全 / 書く前にそのパスだけリンクを切って独立させる / リンク越しに消さない（`rm -rf <path>/` 禁止）/ 触らない作業では何もしない」を伝える。モードは合成レイヤの `sessionOptionsFrom(config, appendSystemPrompt)`（`bootstrap/build-manager.ts`。config → `SessionOptions` の対応付けだけを持つ純関数で、spec で固定してある）が `resolveIgnoredFilesMode(config)` で解決して `SessionOptions.ignoredFiles` へ渡す。解決箇所は合成レイヤの2つ（`index.tsx` の `WorktreeManager` 生成とここ）だが、どちらも同じ config 由来なので一致する。**既知の制約**: モードは state.json に永続していないので、`symlink` で作った worktree を後から `copy` / `none` 設定で復元すると注意書きが載らない（設定を変えた場合のみ。逆向き＝実体があるのに注意書きが載るケースは、手順1の `test -L` 判定で無害化される）。**codiva 側でリンクを張り替えることはしない** — 何が書き込み対象かは指示内容次第で、先回りして全部コピーすると symlink モードの利点（複製コストゼロ）が消えるため、判断はセッションに委ねる。文言は AI 向けなので英語・i18n カタログ対象外（`utils/title.ts` と同じ扱い）。
- **リポジトリ追加指示（`.codiva/prompt.md`）**: 合成ルート（`index.tsx`）が起動時に `loadRepoPrompt(repoRoot)` で読み、`buildManager` → `SessionOptions.appendSystemPrompt` へ流す。`consume()` は上記と合成して `options.systemPrompt` として渡す。SDK は systemPrompt 省略時に空文字へ写像する（claude_code プリセットは使わない）ため、文字列を渡すのは「空への追記」と等価で現挙動を変えない。CLAUDE.md は `settingSources: ['project']` 経由で別途注入されるので、これはそれへの上乗せ。将来ベースの systemPrompt を導入する場合は array / preset-append 形へ切り替える（`session.ts` の注入コメント参照）。
- **復元対応**: `resume`（SDK セッションID）と `restored`（復元済み `SessionState`）を DI で受けられる。復元セッションは `start()` せず、最初の `send()` で遅延的に query を開始（`resume` 付き）。これで起動時にサブプロセスを乱立させない。
- `stop()`: 状態を変えずにサブプロセスだけ落とす quiet 停止。アプリ終了時はこれを使い、実行中セッションを resumable のまま保存する（`abort()` は failed にする点が違い）。保留中の許可要求があれば deny で解決してから停止する（未応答の `tool_use` で resume が壊れるのを防ぐ）。

### SessionManager (`core/session-manager.ts`)

- `create(prompt)`: slug生成 → WorktreeManager.add() → Session 起動。同期的に `creating` 状態のエントリを即時返す（UI を待たせない）。
- **タイトル生成**: `generateTitle`（DI、`utils/title.ts` が Haiku で実装）を各 fresh セッションに渡す。`Session.start()` が指示文を要約させ、返り次第 `title` イベントで暫定タイトルを差し替える（restore 済みセッションは保存済みタイトルを維持し再生成しない）。I/O は注入なので reducer/session は純粋・テスト可能。
- 全セッションの `Map<id, Session>` を保持し、`subscribe(listener)` / `getSnapshot(): SessionState[]` を提供（React の `useSyncExternalStore` にそのまま接続できる形）。
- スナップショットは毎回新しい配列参照を返すが、**変更のあったセッション以外のオブジェクト参照は維持**する（不要な再描画防止）。
- `dispose()`: 全セッションを **`stop()`（quiet）**（worktree は残す）。実行中でも resumable なまま。
- `onTransition(prev,next)`: ステータス遷移ごとに発火（デスクトップ通知に配線）。
- `onPersist()`: 永続対象が変わった合図（合成ルートで debounce 保存に配線）。`persistableState()` が state.json 用スナップショットを組み立てる。
- **モデル切替（`/model`）**: `SessionOptions` を可変フィールドとして保持し、`getModel()` / `setModel(model)` で公開。`setModel` は**以降の新規セッション**に適用（実行中セッションは起動時のモデルを維持）し、`onModelChange(model)` で合成ルートに通知 → `~/.codiva/config.json` の `model` にマージ保存される。選択肢は **Claude Code のカタログ**（`Query.supportedModels()`）を唯一の出所にし、取得は `utils/model-catalog.ts`（`fetchModelCatalog`）・変換と突き合わせは `core/models.ts`（`toModelOptions` / `isCurrentModel`）が担う（詳細は [TECH_NOTES.md](./TECH_NOTES.md) の supportedModels 節）。コマンド解析は `core/commands.ts`（`parseSlashCommand`）。
- **リポジトリ追加指示の編集（`/prompt`）**: モデル切替と同じ形。`getRepoPrompt()` / `setRepoPrompt(text)` で `SessionOptions.appendSystemPrompt` を可変管理し、`setRepoPrompt` は**以降の新規セッション**に適用（実行中セッションは起動時の指示を維持。systemPrompt は query 開始時に確定するため）、`onRepoPromptChange(text)` で合成ルートに通知 → `utils/saveRepoPrompt()` が `<repo>/.codiva/prompt.md` へ永続化（空なら削除）。UI は一覧の `/prompt` で `ui/repo-prompt-editor.tsx`（現在値をシードしたモーダル。Enter 保存 / Shift+Enter 改行 / Esc 取消。composer と同じ `input.ts` の chord モデル）を開く。起動時読込は従来どおり `loadRepoPrompt()`。
- `restore(persisted)`: 起動時に前回セッションを再構築（worktree meta を再配線し、`Session` に `resume`/`restored` を渡す。id/slug を予約して衝突回避）。
- **責務分割**: SessionManager はライフサイクルと配線のファサードで、以下を委譲する:
  - `core/session-store.ts`（`SessionStore`）… 購読可能スナップショット（順序・状態・参照同一性保持）
  - `core/session-actions.ts` … `mergeSession` / `discardSession` / `sessionDiffStat`（git 操作）
  - `core/pr-coordinator.ts`（`PrCoordinator`）… `maybeAutoPr` / `refreshPrs`（PR 自動化）
  - `core/run-mode.ts` … `RunMode` + `createModePolicy`（shift+tab のツール許可モード）
  - `core/persistence.ts` の `assemblePersistedState` … state.json スナップショットの組み立て
  - DI seam の interface（`WorktreeService` / `SessionHandle` / `PrAutomation` / `PrLookup` / `ActionResult`）は `core/session-ports.ts`（leaf）に集約し循環を防ぐ。

### WorktreeManager (`utils/worktree-manager.ts`)

- 前提チェック: Gitリポジトリか、HEAD が存在するか（コミット0のリポジトリでは worktree を作れない）。
- `add(slug)`: `git worktree add .codiva/worktrees/<slug> -b codiva/<slug>` を現在の HEAD から作成。slug 衝突時は `-2`, `-3` を付与。
- `.git/info/exclude` に `.codiva/` を自動追記（初回のみ）。
- ignore 済みファイルの引き継ぎ: `ignoredFiles`（`'symlink'` | `'copy'` | `'none'`、既定 `'symlink'`）が `'none'` 以外なら、`git ls-files --others --ignored --exclude-standard --directory` で列挙した `.gitignore` 対象（`node_modules/`・`.env` など）をリポジトリルートから worktree へ引き継ぐ。git worktree は追跡対象しか引き継がないため、これで依存の再インストールや環境変数の再設定なしにセッションが即実行できる。`'symlink'` は `fs.symlink` で元へのリンクを張るだけ（複製コストゼロ・実体共有）、`'copy'` は `fs.cp` で実体を複製（worktree 完全独立・大きいと重い）。既定を `'symlink'` にしているのは、`node_modules/` 等の複製コストを避けて起動を速くするため。列挙結果のフィルタは純関数 `ignoredCopyEntries()` に切り出し（`.codiva/`・`.git` は再帰・内部状態破壊を避けるため必ず除外）、実体化はエントリ単位のベストエフォート（1件の失敗で worktree 作成を止めない）。設定値からモードへの解決は純関数 `resolveIgnoredFilesMode()`（非推奨 `copyIgnored` の後方互換: `true`→`'copy'` / `false`→`'none'`）。
- `diffStat(session)`: `git -C <worktree> diff <base>...HEAD --stat` 相当。未コミット変更がある場合はその旨も返す。
- `merge(session)`: セッションブランチをベースブランチへマージ（squash はしない。コンフリクト時はエラーを返し、手動解決を促すメッセージを表示するのみ）。
- `remove(session, { force })`: `git worktree remove` + `git branch -D`。

### UI (ui/)

Claude Code の実画面に寄せる: 画面は**端末の縦幅いっぱい**（web の 100dvh 相当。`App` が root Box に `useWindowSize()` の rows を指定。極端に低い端末では `isFullscreenViewport` が false になりインライン描画へフォールバック）に描画し、全画面時は起動時に **alt screen**（`utils/alt-screen.ts`）へ入ってスクロールバックを無効化（上へのスクロールをロック）し、下部に**上下の全幅横罫線だけ**の入力欄（`PromptInput`、角丸枠ではない）、その下にモード行（`StatusFooter` = `⏵⏵ auto mode on (shift+tab to cycle)` + 文脈ヒント）を flexGrow スペーサで**最下部に固定**。ヘッダは枠なしのワードマーク。色とグリフは `theme.ts` に集約。

- `App`: 全画面レイアウトの root と Ctrl+C の安全網。**list ⇔ detail のビュー切替**を `View` state で持ち、
  一覧で Enter/→ すると `onOpen(id)` で詳細へ、詳細で Esc すると `onBack` で一覧へ戻る。
- `Banner`: 起動時ヘッダ（マスコット + ワードマーク / プラン + モデル / cwd + 使用状況ゲージ）。枠なしで
  一覧上部に表示。**純粋に presentational** で、表示行は core の `bannerLines()`（`core/banner-lines.ts`）が
  組む（`BannerLine[]` = 1 要素 1 表示行。色は `BannerTone` という抽象で受け取り、実際の色は `theme.ts`）。
  可読性のため**プランとモデルは 1 行にまとめ**（`Plan: Claude Max   Model: sonnet`）、サブタイトルは出さない。
  ヘッダのテキストはドラッグで範囲選択してコピーできる（cwd の絶対パスを取り出す用途）。当たり判定は
  「行 index = 表示行」を前提に `bannerCaretAt()` で逆算するため、**行は `wrap="truncate-end"` で 1 行 1 行に
  固定し、選択可能なテキスト塊（`textRef` の Box）の中に margin を入れない**（折返し・margin が入ると以降の
  行が全てズレる）。位置の実測 ref は中央寄せの外側ではなく**行だけを包む内側 Box** に付ける。
  使用状況（`UsageSection`）と学習データ利用の警告（`PrivacySection`）は**その塊の外**に描くので、
  節の間隔は `marginTop` で空けてよい（行構成を揺らさない）。使用状況の行データは純粋な
  `bannerUsageRows()`（見出しを表示幅で揃え、使用率を右詰めにした `BannerUsageRow[]`）が組み、
  ゲージのセル数は `gaugeCells()`、記号（█ / ░）は `theme.ts` の `glyph` から取る（core に記号を置かない）。
  ゲージ幅は端末幅で段階的に縮退させる（`bannerGaugeWidth(columns)` = 20 / 12 / 8 / 0 セル）。
  低い端末ではヘッダも縮んで下段 UI に場所を譲る（`flexShrink` を止めない）ため、潰れて一覧の行に
  重なった場合は**一覧のクリックを優先**する（`SessionList` 側で `y >= rowsBox.top` を除外）。
  縦に潰れると中央寄せの負オフセットで**上端の行から**落ちるので、`SessionList` は実測高さ
  （`useBoxHeight`）が行数より小さい間はヘッダの当たり判定をやめる。一方**マスコットの Box だけは
  `flexShrink={0}`**（横方向の縮小でアスキーアートが折り返して崩れるのを防ぐ。縦の譲り合いには効かない）。
- `SessionList`: 一覧画面。`Banner` + 一覧 + 下部 `PromptInput`/`StatusFooter`。フォーカスは
  `composer`（起動時既定。タイピング + 矢印キャレット移動）と `list`（↑↓選択・Enter/→ = 詳細を開く・
  m/d = マージ/破棄）の2ゾーンで Tab 切替。選択セッションの `PermissionDialog` は list フォーカス時のみ
  アクティブ。マウスクリック（`core/mouse.ts` + `useAbsolutePosition`）で行選択・キャレット移動。
  コンポーザ上のドラッグで範囲選択し、離すとクリップボードへコピー（OSC 52 = `utils/clipboard.ts`。
  純粋ロジックは `core/text-selection.ts`、状態は共有フック `useDragSelection`）。詳細ビューの
  フォローアップ入力欄も同様。**ヘッダ（`Banner`）も同じ仕組みで選択・コピーできる**（`useDragSelection` を
  コンポーザとは別インスタンスで持つ = caret index の基準テキストが違うため）。ヘッダのドラッグは
  フォーカスも選択行も動かさない（パスをコピーしたいだけの操作でタイピング位置を奪わない）。
- `SessionDetail`: 詳細画面。**ステータスヘッダは持たず**、コンテンツ（末尾ビューポートのログ）+ フッタ
  （追加指示コンポーザ）だけの構成。SDK セッションに**直結**し、末尾ビューポートにログを描画（`core/scroll.ts` の
  `logLines` でエントリを CJK 幅対応で折り返した**物理行**（`DisplayLine[]`）へ展開してから、
  `logWindow`/`scrollUp`/`scrollDown` で PgUp/PgDn（半画面）と ↑/↓（1行 = `ARROW_SCROLL_LINES`）スクロール。
  詳細ビューはコピペのためマウス捕捉を解除しており、alt screen では端末がホイールを ↑/↓ に変換して
  送るため（alternate scroll mode）↑/↓ がホイールの受け口になる。捕捉が生きている隙間のために
  ホイールのレポート列も `parseSgrMouse` で先取り解釈し、コンポーザへ文字入力として漏れないようにする。
  描く行数は**実測した可視高さ**（`useBoxHeight`）に収める — Ink/Yoga は溢れた子を縮小するため、
  多く描くと行が虫食いで欠落する）、
  `streamingText` のタイピング風プレビュー、
  下部の追加指示コンポーザ（`manager.send(id, text)`）を持つ。Tab で入力↔操作パネルを切替し、
  操作パネルで m/d = マージ/破棄。`pendingPermission` があれば `PermissionDialog` に委譲。単一 `useInput` の
  state machine（panel = input | actions）でタイピングとキー操作の衝突を防ぐ。
- `PromptInput` / `StatusFooter`: presentational。キー処理は view の単一 `useInput` に集約（ロジックは持たない）。`PromptInput` は複数行対応（純粋モデルは `core/text-buffer.ts`、キー対応は `ui/input.ts` の `editText`/`resolveEnter`）。IME 対応で実端末カーソルをキャレットに重ねる（`useCursor`）。
- 再描画スロットリング: SessionManager の通知を UI 側で ~100ms にスロットルする。

**ランモード（shift+tab トグル）**: `SessionManager.mode`（`auto` | `confirm`）を全セッション共通で保持し、`shift+tab` で `cycleMode()`。`modePolicy` は tool 実行時に `mode` を読むので、切替は稼働中セッションにも即反映される。`auto` = AskUserQuestion 以外を自動承認、`confirm` = 毎回 allow/deny を求める（→ `awaiting_permission`／一覧に「許可待ち」）。UI は `useRunMode()` で購読し、`StatusFooter` が `⏵⏵ auto mode on` / `⏸ confirm mode on` を表示。

## 多言語対応（i18n）

UI 文字列は日本語/英語を設定で切り替えられる。規約は [.claude/rules/i18n.md](../.claude/rules/i18n.md)。

- **カタログ**: 全 UI 文字列は `core/i18n.ts` の `messages`（`Record<Lang, Messages>`）に集約する（純粋）。
  UI にリテラルを直書きせず、`useMessages()`（`ui/i18n-context.tsx` の React コンテキスト）で引く。
  純関数（`badgeFor` 等）は `Messages` を引数で受ける。動的差し込み・複数形は型安全な文字列テンプレート関数で持つ。
  （`banner` / `footer` グループもここに含む。）
- **設定**: 表示言語は `~/.codiva/config.json`（`{ "language": "ja" | "en" | "auto" }`）に永続化する
  （Claude Code の `~/.claude/` と同じユーザーグローバルの流儀）。検証変換は `core/config.ts` の
  `toConfig()`、ファイル I/O は `utils/config.ts`（`loadConfig` / `saveConfig`）。
- **言語解決**（`core/i18n.ts` の `resolveLang`、優先順）: `CODIVA_LANG` 環境変数 → 設定ファイルの
  `language`（`auto` 以外）→ OS ロケール（`LC_ALL`/`LC_MESSAGES`/`LANG` が `ja*` なら日本語、他は英語）。
  配線は合成ルート `index.tsx` で行い、解決済みカタログを `App` の `messages` prop に注入する。
- **番人**: `Messages` 型がキー欠落を型で捕え、`i18n.spec.ts` が ja/en のキー集合一致を実行時にも検証する。

## Phase 6 機能（設定 / コスト / 通知 / 復元）

純粋ロジックは core、副作用は utils／合成ルートという分離をそのまま踏襲する。

- **設定ファイル拡張**: `~/.codiva/config.json` に `model` / `effort` / `permissionMode` / `maxBudgetUsd` /
  `notifications` / `updateCheck` / `mouse` / `followOrigin` / `autoPr` を追加。検証変換は `core/config.ts` の `toConfig()` に
  集約し、不正値は静かに既定へ落とす。合成ルート（`index.tsx`）が `SessionOptions` に束ねて `SessionManager`
  へ注入する。`followOrigin` / `autoPr` は真偽値（既定 on。`false` 明示で無効）。
- **コスト表示**: reducer は `result.total_cost_usd` を `state.totalCostUsd` として既に保持。UI 用の導出だけ
  `core/cost.ts`（`totalCostUsd()` 合計 / `formatUsd()` 整形）に純粋関数で追加。一覧はバナーに合計、詳細は各行。
- **デスクトップ通知**: 発火判定は純粋な `core/notify.ts` の `notificationFor(prev,next,messages)`
  （**状態遷移時のみ**返す＝連続更新で鳴り続けない）。実 I/O は `utils/notify.ts` で 2 経路あり、
  **端末に出させる方を優先**する: (1) OSC 通知（`buildNotifySequence`。OSC 777 / 9 / 99 を
  `detectNotifyProtocol` で使い分け）→ 通知が**端末アプリ名義**になるのでクリックでその端末が
  前面に来る、(2) 非対応端末・非 TTY 向けのフォールバックとして OS コマンド（darwin=`osascript`,
  linux=`notify-send`。文字列は **argv 渡し**で注入防止）。macOS で (1) を優先するのは
  `osascript` の通知が **Script Editor 名義**になり、クリックするとスクリプトエディタが開いて
  しまうため（詳細は [TECH_NOTES.md](./TECH_NOTES.md)「デスクトップ通知の実装メモ」）。
  どちらも missing binary 等は握り潰す best-effort。`SessionManager.onTransition` に配線し、
  `config.notifications:false` で合成ルートが無効化。
- **セッション復元**: 永続スナップショットの型・変換・検証は純粋な `core/persistence.ts`
  （`toPersistedSession` / `restoredSessionState` / `fromPersistedJson`）。ファイル I/O は
  `utils/state-store.ts`（`<repo>/.codiva/state.json`。破損時は空へフォールバック、起動時に存在しない
  worktree を prune）。永続対象は `completed`/`interrupted`/`failed` かつ **`sdkSessionId` を持つ**もののみ
  （実行中/入力待ちは `interrupted`＝resumable だが「未完了」と分かる状態に丸める。`archived`/`creating`、
  および init 前に落ちて resume 不能なものは除外）。
  メッセージログは codiva 側では永続しない。ただし **resume はモデル側コンテキストを復元するだけで
  過去メッセージをストリームに再送出しない**ため、UI の会話ログは CLI 自身のトランスクリプト
  （`~/.claude/projects/<munged cwd>/<sessionId>.jsonl`）から復元時に再構築する — 純粋変換は
  `core/transcript.ts`（`transcriptLogEntries` / `transcriptProjectDir`）、ファイル読み込みは
  `utils/transcript.ts`、配線は合成ルート（履歴 Map を `manager.restore(persisted, histories)` へ渡す）。
  復元セッションは遅延 resume（最初の追加指示まで query を立てない）。復元時は `finishedAt` を
  `startedAt` にフォールバックし、経過時間が復元後に伸び続けないようにする。
  **動作時間は wall-clock ではなく「実際に動いた時間」で計る**: `SessionState.activeMs`（累積）と
  `activeSince`（現稼働セグメントの開始時刻）を持ち、`running`/`creating`（＝ `STATUS_META.active`）
  の区間だけを積算する。ユーザー操作待ち（`awaiting_*`）や終端状態は idle として除外。
  状態遷移ごとの積算は `accrueActive`（純関数）に集約し、全状態採用の単一経路 `Session.commit`
  から呼ぶ（reducer/SDK 由来の遷移を個別に触らずに済む）。表示は `activeElapsedMs(state, now)`
  ＝累積＋（稼働中なら開いているセグメント）を `formatDuration` で整形。永続時は
  `activeElapsedMs` で稼働中セグメントを畳み込んで凍結し、復元時は `activeSince` を未設定
  （idle）にしてオフライン時間を数えない。
  保存は `onPersist` → debounce（合成ルート）＋終了時の最終フラッシュ＋ SIGTERM/SIGHUP 時の
  同期フラッシュ（`saveStateSync`）。`stop()` は保留中の許可要求を deny で解決してから停止し、
  resume 先のトランスクリプトが未応答の `tool_use` で終わらないようにする（best-effort）。

## Phase 10 機能（origin 追従 / PR 自動化 / 競合検知）

同じく「純粋ロジック=core、副作用=utils／合成ルート」を踏襲。破壊的な確定操作（競合の解消・
マージの確定）は自動化せず、検知・足場作りだけを自動化する方針。

- **origin 自動追従（`followOrigin`, 既定 on）**: `WorktreeManager.syncedStartPoint(base)` が
  `git fetch origin <base>` して `origin/<base>` を start point として返す（origin 無し/オフライン/
  ブランチ不在なら `undefined` → ローカル HEAD にフォールバック）。`SessionManager.provision` が
  `worktrees.add(slug, startPoint)` に渡し、**作成時のみ**最新から切る（稼働中 worktree へは pull しない
  ＝未コミット変更との競合を避ける）。
- **PR 自動化（`autoPr`, 既定 on）**: セッションが `completed` へ遷移し、かつ base より先に
  **コミット済み差分がある**ときだけ、`worktrees.pushBranch` で push → `PrAutomation.createPr`（`gh pr create
  --draft --fill`）で **draft PR** を作成（1 セッション 1 回。`autoPrAttempted` で多重発火を防ぐ）。以降
  `refreshPrs` の 20 秒ポーリングで、draft PR のチェックが緑（`PrInfo.checks` = `passing`）になったら
  `markReady`（`gh pr ready`）で ready 化する。`gh` 依存はすべて `utils/pr.ts` に隔離し、`PrAutomation` として
  DI（失敗は best-effort でセッションに波及させない）。
- **PR ステータスの「分からない」を潰さない**（GitHub ステータスが時々消える不具合の修正）:
  `lookupPr` は `found` / `absent` / `unavailable`（+ 理由）の 3 値を返し、`PrCoordinator` は
  `unavailable` のとき**直前の PR を保持したまま** `prLookup: 'error'` を立てる。空セルは
  「PR が無い」だけを意味し、確認中は `⋯`、確認できなかったときは `?` を出す。
  `rate_limit` / `auth` / `cli` は 5 分（`PR_LOOKUP_BACKOFF_MS`）ポーリングを止める。
  チェック状態は PR 情報と同じ `gh pr view` 1 回で取得する（`--json mergeable` は GraphQL
  クォータ消費なので、毎ポーリング 2 回投げていたのを 1 回に）。
- **PR は「識別（`pr: PrRef`）」と「状態（`prStatus: PrStatus`）」に分ける**。番号・URL は
  ブランチに対して不変なので `state.json` に載せ、**復元直後からグリフ無しの `#<n>` を表示**する。
  状態（マージ可否・チェック・draft）は永続せず、復元後の最初のポーリング（`prPollIntervalMs`
  が 0 を返す）で埋める — 前回終了時の古いグリフを見せるより、まず番号だけ出す方が正しい。
  reducer は半分ずつ比較して参照を維持するので、チェックの進行で `state.json` が再保存されない。
- **ポーリングは「セッション数 × 20 秒」をやめる**（`core/pr-refresh.ts` / `PrCoordinator`）:
  20 秒 tick はスケジューラで、実際に `gh` を叩くのは陳腐化したセッションだけ（チェック実行中
  20 秒 / 未計算 60 秒 / 落ち着いた PR 180 秒 / `merged`・`archived` は永久に不要）。さらに同一
  サイクルで 3 件以上あるときは `gh pr list` 1 回（`lookupPrs`）に畳んで突き合わせるので、
  セッションを増やしても API コストがほぼ増えない。
- **競合検知（自動解消しない）**: `WorktreeManager.merge` は競合時に競合ファイルを収集して
  `merge --abort` した上で `MergeConflictError` を投げる（base ツリーは汚さない）。`SessionManager.merge` は
  これを捕えて `session.markConflict(files)` → reducer が `status: 'conflict'` + `conflictFiles` を立てる。
  **自動解消はしない**（`-X ours/theirs` 等でコードを無言に捨てない）。UI はバッジ表示のみで、解消は人手。
  `conflict` は詳細ビューでも終端状態扱い（差分・操作を表示）で、破棄や再マージは一覧/詳細から可能。

## 学習データ利用（grove）の警告

codiva は並列セッションで大量のコードを Claude へ流すため、claude.ai の「Help improve our AI models」
（= モデル学習へのデータ提供。Anthropic 内部名 **grove**）が ON のまま気付かずに使い続けるのを防ぐ。
**警告するだけで、codiva 側の挙動は変えない**（勝手に無効化はしない = ユーザーのアカウント設定を
アプリが書き換えない）。

- **判定は 2 段構え**（`utils/privacy.ts` の `fetchTrainingOptIn`。安いほうから試す）:
  0. **認証方式の門番**: API キー / Bedrock / Vertex / 独自 `ANTHROPIC_BASE_URL` のときは claude.ai の
     設定と無関係（かつ API 利用は学習対象外）なので、**キャッシュも読まずに** `'unknown'`。
     過去に claude.ai へログインした残骸で誤警告しないため、この門番が最初に来る。
  1. `~/.claude.json` の `groveConfigCache[accountUuid]`（Claude Code が書くキャッシュ。ネットワークも
     認証情報も不要。7 日より古い値は使わない）。キーは `oauthAccount.accountUuid` と一致させ、
     **アカウントが読めないときに限り**単一エントリを流用する（切替後に前アカウントの値を使わない）。
  2. `GET https://api.anthropic.com/api/claude_code_grove`（Keychain `Claude Code-credentials`（macOS）
     または `~/.claude/.credentials.json` の OAuth トークンを使う）。
- **キャッシュの信頼は非対称**: `'off'` はそのまま採用してここで終える（安い）が、**`'on'` は必ず
  問い合わせで確認する**。claude.ai 側で OFF にしてもこのキャッシュは書き換わらないため、
  信用すると「言われた通り切ったのに警告が出続ける」ことになる。確認が取れなかったときだけ
  キャッシュの `'on'` に据え置く。
- **判定は `'on' | 'off' | 'unknown'`**（`core/privacy.ts`）。警告は **`'on'` と確定したときだけ**出す。
  レスポンスの `domain_excluded === true`（意味は未検証）も `'unknown'` に倒す。
- **起動をブロックしない / 終了を止めない**: 合成ルート（`index.tsx`）が render 前に投げ、
  `useTrainingOptIn` が解決したらバナーに注意行が増える。終了時は `AbortController` で打ち切る。
  `security`（Keychain）呼び出しには `signal` と `timeout`（2 秒）を必ず渡す — 生きた子プロセスが
  イベントループを掴むと、終了してもシェルのプロンプトが返らなくなる。abort 済みシグナルでは
  `addEventListener('abort')` が発火しないので、問い合わせ前に `signal.aborted` を先手チェックする。
- **失敗はすべて `'unknown'`**（非公開エンドポイントなので仕様変更で壊れうる。壊れたときは
  「黙る」= 誤った警告を出さない）。設定 `privacyWarning: false` で判定自体を走らせない。
- **描くのは `bannerLines` の行ではなく、その外の `PrivacySection`**。ヘッダのドラッグ選択は
  `bannerText(lines)` への caret index で、当たり判定が「行 index = 表示行」を前提にしている
  （`core/banner-lines.ts` の `bannerCaretAt`）。警告はコピー対象ではないうえ `⚠` は `theme.ts` が
  持つ記号なので、選択可能なテキスト塊（`textRef` の Box）の**外**に置いて行構成を揺らさない。

エンドポイントの実測（User-Agent 要件など）は [TECH_NOTES.md](./TECH_NOTES.md#学習データ利用grove-の検知実測-2026-07-30) を参照。
## アップデート通知 / `/update`

npm 配信された自分自身の更新を検知して知らせ、安全に確定できる経路のときだけ適用する。
「検知は自動、確定操作は人手」という PR 自動化と同じ方針。

- **純粋ロジック（`core/update.ts`）**: semver の precedence 比較（`compareVersions` /
  `isUpdateAvailable`。prerelease 規則まで実装）、結果 union（`UpdateCheck` =
  `available` / `up-to-date` / `unavailable`）への変換（`resolveUpdateCheck`）、インストール経路
  （`InstallKind` = `global` / `local` / `npx` / `unknown`）から更新コマンドを組む
  `updateCommandFor`（**argv 配列**で返す）/ `updateCommandLine`、自己更新の可否 `canSelfUpdate`。
  DI 境界 `UpdateService`（`initial` / `check()` / `install()`）とダイアログ状態 `UpdateViewState` もここ。
- **I/O（`utils/update.ts`）**: `fetchLatestVersion` が `https://registry.npmjs.org/<pkg>/latest` を
  1 回だけ引く（全 packument 21KB ではなく 2.3KB。認証不要。**3 秒でタイムアウトし throw しない**。
  タイマーは unref、外部 `AbortSignal` でも打ち切れる）。`installKindFor` は
  `packageRoot` / `execPath` / `cwd` / `platform` を**引数で受けるパス比較のみ**（`notifyCommand(spec, platform)`
  と同じ方針でテスト可能）。`runUpdate` が `execFile`（シェルなし）で `npm install` を実行し、失敗は
  stderr の最終行を `ok: false` で返す。`createUpdateService` がこれらを束ねる。
- **経路判定の安全側**: npx / dlx / bunx のキャッシュ（**パス要素の完全一致**で判定。部分一致だと
  `bunx-tools` のような無関係なディレクトリを誤検出する）は `npx`、volta / asdf 配下・Windows・
  それ以外の判別不能は `unknown`。**実行するのは `global` だけ**（`canSelfUpdate`）で、`unknown` /
  `local` / `npx` は実行すべきコマンドの提示に留める。静的判定が `unknown` のときだけ
  `npm root -g` を 1 本起こして `global` へ格上げする（homebrew の Cellar・`npm config set prefix`・
  pnpm/yarn global を拾うため。標準的な配置ではサブプロセス 0 本）。`npm install -g` の cwd は
  ホームに固定する（対象リポジトリの `.npmrc` に宛先を書き換えられないため）。
- **配線**: 合成ルート（`index.tsx`）が起動時に `createUpdateService` を作り、**await せずに**
  `initial` を投げる（`modelCatalog` と同じ扱い。終了時に `updateAbort.abort()`）。`App` は
  `useUpdateCheck(updater?.initial)` で state に解決し、`available` のときだけ
  `bannerLines` の `updateLatest` へ渡す（最新・未確認では**ヘッダに行を増やさない**）。
  ヘッダの文字組みは純粋な `core/banner-lines.ts`、色は `accent` トーン →`ui/theme.ts` の
  `theme.accent`（`.tsx` に生の色名を書かない）。`/update` は `useCommandRunner` の
  `update` ハンドラ → 毎回 `check()` し直し、`UpdateDialog` を出す。
- **キー処理**: `UpdateDialog` は presentational で `useInput` を持たない。キーは一覧ビューの
  単一ハンドラが `confirm` / `confirmResumeAll` と同じ位置で処理する（更新可能なら y/n、
  それ以外は任意キーで閉じる）。非同期の決着は**世代カウンタ**で無効化し、閉じた後・開き直した
  後に stale な結果でダイアログが蘇らないようにする。
- **モーダルの相互排他は必須**: `PermissionDialog` は**自前の `useInput`** を持ち、Ink は 1 つの入力
  チャンクを**マウント中の全ハンドラへ配る**。同時に出ていると更新確認の `y` が未読のツール実行の
  許可も兼ねてしまう（このビューがキーを飲んでも相手は独立に反応する）。`pending` の導出に
  `!update` を入れて構造的に禁じ、さらにモーダル中は**マウスレポートも飲む**
  （クリックで `focus` が list に移ると許可ダイアログが立つ経路を塞ぐ）。
- **実行中に操作不能にしない**: `installing` 中も **Esc は通す**。codiva は Ctrl+C を拾わず
  （`exitOnCtrlC: false`）終了は `/exit` だけなので、全キーを飲むと `npm install` が終わるまで
  最長 `INSTALL_TIMEOUT_MS` のあいだ何もできなくなる。Esc はダイアログを閉じるだけで npm は続行する。
- **設定**: `updateCheck`（既定 on）。`false` で起動時の通信を完全に止める（`/update` は
  `unavailable` を返すだけになる）。

## 設計判断

| 判断 | 理由 |
|------|------|
| 復元は「メタ + SDK resume」で、ログは永続しない | state.json を小さく保つ。会話履歴は SDK の resume が持つので二重管理しない。復元直後はアイドル表示、追加指示で継続 |
| 復元セッションは遅延 resume（起動時に起こさない） | セッション毎に ~1GiB のサブプロセスを起動時に乱立させない。触られたものだけ起こす |
| 終了は `abort()` ではなく `stop()`（quiet） | 実行中セッションを failed にせず resumable のまま保存するため（quit と「1件破棄」を区別） |
| 通知の発火判定は純粋関数・遷移時のみ | テスト可能にし、ストリーミングの連続更新で鳴り続けるのを防ぐ。OS I/O は utils に隔離し best-effort |
| 設定検証は `toConfig()` に集約・不正値は既定へ | 設定ミスで TUI をクラッシュさせない。SDK union は実行時リテラルで検証（型が変われば型エラー） |
| 分離手段は git worktree | 同一リポジトリの並列作業では最軽量。ブランチがそのまま成果物になる。Docker 等はMVPではオーバーキル |
| 競合は「検知のみ」で自動解消しない | 汎用的に安全なマージ競合の自動解消は存在しない（`-X ours/theirs` はコードを無言に捨てる）。可視化（`conflict` バッジ）に留め、解消は人手に委ねる |
| PR は draft で作り、緑になってから ready 化 | チェックは PR が無いと走らない（鶏卵）。完成前に push→draft で足場を作り、`gh pr checks` が緑になった時点で ready へ。確定操作は自動でも“レビュー可能”状態までに留める |
| origin 追従は作成時のみ（稼働中は pull しない） | 稼働中 worktree へ取り込むと未コミット変更と競合し得る。作成時に `origin/<base>` から切る安全な部分集合に限定 |
| PR 自動化は `PrAutomation` として DI・best-effort | `gh` 未導入/未認証/オフラインでもセッションを壊さない。core は `gh` を直接知らず、`utils/pr.ts` に隔離 |
| 自己更新は経路を判定できたときだけ実行する | `npm i -g` は npx キャッシュ・volta 配下・別 prefix では宛先が違い、環境を壊す。判定不能（`unknown`）なら**コマンドの提示だけ**に留め、誤爆のコストを「自動化されない」に限定する |
| 更新チェックは `latest` の 1 リクエスト・3 秒で打ち切り・await しない | 起動を絶対にブロックしない。オフライン/レジストリ障害でも `unavailable` に落ちるだけで TUI を壊さない。全 packument（21KB）ではなく `/latest`（2.3KB）を引く |
| 「最新だった」と「確認できなかった」を型で区別する | オフラインを「最新です」と表示すると嘘になる。`UpdateCheck` の union で UI が取り違えられないようにする |
| UI 文字列はカタログ集約 + 設定で言語切替 | 日本語/英語の利用者が混在する。ハードコードを排し、追加言語も `Lang`/`messages` 拡張だけで済む |
| セッション = SDK `query()` 1本（サブプロセス1本） | SDK の設計単位に素直。プロセス分離により1セッションのクラッシュが他に波及しない |
| streaming input を常用（単発 prompt を使わない） | 追加指示（F-6）と質問への回答（F-7）を同一機構で実現でき、セッションを開いたまま維持できる |
| コアと UI の分離 + queryFn の DI | SDK もネットワークも不要なユニットテストを可能にする（N-3 の 80% カバレッジはこれが前提） |
| worktree は `.codiva/worktrees/` 配下、exclude は `.git/info/exclude` | 対象リポジトリのファイルを一切汚染しない |
| アプリ終了時に worktree を消さない | N-4（作業内容の保全）。明示的な削除操作のみで消す |

## リスクと対応

| リスク | 対応 |
|--------|------|
| SDK メッセージ形式の想定違い | Phase 1 のスパイクで実メッセージを JSONL 収集し、reducer のテストフィクスチャに使う（想定で書かない） |
| 大量ストリームで Ink 再描画が重い | 一覧はステータス行のみ描画（ログは詳細ビューでのみ、末尾ビューポートにクリップ）+ 購読スロットリング |
| 質問検出の誤判定 | MVP はヒューリスティック + 詳細ビューで追加指示を送って対話を続けられるので誤判定の実害は小さい。スパイク結果で改善 |
| 並列セッションのAPIコスト | Backlog でコスト表示を追加。MVP では result メッセージの usage をログに残すのみ |
| ユーザーのメインworktreeが dirty | worktree は HEAD から切るため影響なし。起動時チェックで警告のみ表示 |
