# git / I/O 規約

`src/utils/` の副作用と、対象リポジトリに触る操作の不変条件。**worktree・マージ・PR・
ファイル入出力に触るときに読む。**

## git の実行

- git は必ず `utils/git.ts` の `git(cwd, args)` を使う（`promisify(execFile)` + **引数配列**）。
  **シェル文字列連結は禁止**（slug はサニタイズ済みだが多層防御）。
- 失敗は `GitError`（`args` と `stderr` を同梱）。呼び出し側は `stderr` を握り潰さず
  ユーザーに見える形で扱う（`core/errors.ts` の `errorMessage` で文字列化）。
- `gh` も同じ方針で `utils/pr.ts` に隔離し、`ExecLike` を DI してテストする。
  core は `git` / `gh` を直接知らない。

## worktree（`utils/worktree-manager.ts`）

- 配置は `<repo>/.codiva/worktrees/<slug>`、ブランチは `codiva/<slug>`。**この命名を変えない**
  （`takenSlugs()` が `refs/heads/codiva/` 前提で衝突回避している）。
- 起動時 `preflight()`: git リポジトリか / HEAD があるか（コミット 0 では worktree を作れない）。
- 作成は現在の HEAD、`followOrigin` が有効なら `syncedStartPoint(base)` = `origin/<base>` から切る。
  **稼働中の worktree へ pull しない**（未コミット変更と競合する）。
- `.git/info/exclude` へ `# codiva` マーカー付きで `.codiva/` を追記（冪等）。
  **対象リポジトリの `.gitignore` を書き換えない。**
- ignore 済みファイルの引き継ぎ `ignoredFiles`: `'symlink'`（既定・複製コストゼロ）/
  `'copy'`（完全独立）/ `'none'`。列挙結果のフィルタは純関数 `ignoredCopyEntries()` で、
  **`.codiva/` と `.git` は必ず除外**（再帰・内部状態破壊の防止）。実体化は entry 単位の
  ベストエフォート（1件失敗しても worktree 作成を止めない）。
- **ビルド生成物・キャッシュは引き継がない**（`DEFAULT_IGNORED_EXCLUDES`。モード共通）。
  worktree はリポジトリ配下にあるため、`.next` 等を共有するとルートで再帰監視している
  開発サーバが自分の書き込みを worktree の数だけ再検知して OS ごと固まる（issue #81）。
  判定は純関数 `isExcludedIgnoredEntry()`（`/` 無しは最終セグメント一致・`*` 前置は接尾一致・
  **最後に一致したパターンが勝つ**）。設定 `ignoredFilesExclude` で追加／`!` 打ち消しができる。
  **依存（`node_modules/`）と環境ファイル（`.env`）は引き継ぎ対象のまま**にする（symlink モードの
  存在理由なので、この既定を生成物と一緒に切らない）。
- 起動時の後片付け `pruneExcludedLinks()`: 既存 worktree に残る「もう引き継がないパス」の
  **シンボリックリンクだけ**を外す（best-effort）。**実体のディレクトリは絶対に消さない**
  （セッション自身のビルド結果でありうる）。ここを `rm -r` に緩めない。
- **`'symlink'` のときは「実体が共有である」ことをセッションにも伝える**（`core/system-prompt.ts` の
  `SHARED_IGNORED_FILES_NOTICE` が systemPrompt に載る）。依存更新やビルドはリンク越しに
  メインチェックアウトと他セッションへ波及するため、エージェント側で**書き込む前にそのパスだけ
  リンクを切って独立させる**手順を渡す。codiva 自身がリンクを張り替えることはしない
  （何が書き込み対象になるかは指示内容次第で、全部コピーすると symlink モードの利点が消える）。
- マージは `checkout <base>` → `merge --no-ff <branch>`。**競合したら
  競合ファイルを収集して `merge --abort` し `MergeConflictError` を投げる**（base ツリーを汚さない）。
  `-X ours/theirs` 等での**自動解消は禁止**（コードを無言に捨てる）。UI は `conflict` バッジまで。
- 破棄は `worktree remove [--force]` + `branch -D`。**アプリ終了時に worktree を消さない**
  （作業内容の保全。明示操作のみで消す）。

## PR 自動化（`utils/pr.ts`、best-effort）

- 使う `gh` は次だけ。増やすときもここに閉じる:
  `pr view <branch> --json number,url,state,mergeable,isDraft,statusCheckRollup` /
  `pr list --state all --limit <n> --json headRefName,<同じ項目>` /
  `pr create --draft --fill --head <branch>` / `pr ready <branch>`。
  **チェック状態は PR 情報と同じ 1 回の `pr view` で取る**（`--json mergeable` は GitHub の
  **GraphQL** クォータを消費し、ユーザーの他のツールと共有の 5000/h なので、毎ポーリングで
  2 回投げない）。
- **セッション数に比例させない**。同じサイクルで `PR_BATCH_MIN_SESSIONS`（3）件以上を
  問い合わせるときは `lookupPrs`（`pr list` 1 回 + ローカルの `git rev-parse` で突き合わせ）に畳む。
  1〜2 件なら `pr view` の方が安いのでそちら（list は全件のチェック rollup を運ぶため）。
  worktree はどれも同じ repo を指すので、list の cwd はどのセッションのものでもよい。
- **問い合わせ頻度はセッションごとの陳腐化で決める**（`core/pr-refresh.ts`）。20 秒の tick は
  スケジューラに過ぎず、実際に `gh` を叩くのは「チェック実行中=20秒 / 未計算=60秒 / 落ち着いた
  PR=180秒 / PR 未検出=状態次第」を超えたものだけ。`merged` と `archived` は二度と問い合わせない。
- 方針は「足場作りは自動、確定操作は緑判定/人手」: `completed` かつコミット済み差分があれば
  push → **draft** PR（1セッション1回）、20 秒ポーリングでチェックが緑になったら ready 化。
- `gh` 未導入・未認証・オフラインでも**セッションを壊さない**（失敗は握り潰す）。
  `PrAutomation` として DI するのはこのため。
- **失敗と「PR が無い」を混同しない**（`lookupPr` は `found` / `absent` / `unavailable` の
  3 値を返す）。レート制限・オフライン・未認証を `absent` として扱うと、表示中の `#<n>` が
  ポーリングごとに消えて復活する（実際に起きた不具合）。`unavailable` のときは**直前の PR を
  保持**し、セッションに `prLookup: 'error'` を立てて一覧に「確認できていない」印を出す。
- **失敗の理由は分類する**（`PrUnavailableReason`）。`rate_limit` / `auth` / `cli` は次の
  20 秒で成功し得ないので `PR_LOOKUP_BACKOFF_MS`（5 分）ポーリングを止める。`cli`（`gh` 未導入）は
  機能自体が使えないだけなので印も出さない（全行に警告を出しても直せない）。
- ポーリングは**多重実行しない**（`gh` が 20 秒より遅いとサイクルが重なる）。`merged` になった
  PR と `archived` セッションは以後問い合わせない（状態が確定しているのでクォータの無駄）。

## 生成・参照するファイル

| パス | 内容 | 書き手 |
|---|---|---|
| `<repo>/.codiva/worktrees/<slug>` | セッションの worktree | `WorktreeManager` |
| `<repo>/.codiva/state.json` | 復元用メタ（会話ログは入れない） | `utils/state-store.ts` |
| `<repo>/.codiva/prompt.md` | リポジトリ追加指示（空保存で削除） | `utils/repo-prompt.ts` |
| `<repo>/.git/info/exclude` | `# codiva` + `.codiva/` を追記 | `WorktreeManager` |
| `~/.codiva/config.json` | ユーザー設定 | `utils/config.ts` |
| `~/.codiva/logs/crash-<時刻>-<pid>.log` | クラッシュレポート（20 件でローテーション。**同期書き込み**） | `utils/crash-log.ts` |
| `~/.codiva/logs/report.*.json` | Node の診断レポート（OOM 等 JS が動けない死に方の唯一の記録） | Node（`process.report`） |
| `~/.claude/projects/<cwd の非英数字を '-' 化>/<sessionId>.jsonl` | CLI のトランスクリプト（**読み取り専用**） | Claude CLI |
| `~/.claude.json` / `~/.claude/.credentials.json` / Keychain `Claude Code-credentials` | 学習データ利用の判定に使う Claude Code の状態・OAuth トークン（**読み取り専用**。`utils/privacy.ts`） | Claude CLI |
| `scripts/fixtures/*.jsonl` | spike の生ログ（gitignore） | `scripts/spike.ts` |

- 設定・状態の読み込みは**壊れていても throw しない**（`{}` / 空状態へフォールバック）。
  設定ミスや壊れた JSON で TUI を落とさない。
- 保存は debounce（500ms、`bootstrap/persist-controller.ts`）+ 終了時 flush +
  SIGTERM/SIGHUP の**同期 flush**（`saveStateSync`）。この3経路を1つに減らさない。

## 端末・OS への副作用

- 端末モード（alt screen / SGR マウス）は `utils/alt-screen.ts` / `utils/mouse.ts` で
  **冪等な enter/leave**（共通化は `utils/terminal-mode.ts` の `toggleEscape`）。
  クラッシュで端末を壊さないよう `process.on('exit')` に leave を保険登録する。
- **`process.on('exit')` だけを頼りにしない**。強制終了（OOM の abort・SIGKILL・segfault）では
  JS が一切走らず、マウス捕捉が残った端末はスクロールが大量の文字入力に化ける。3 層で守る:
  (1) teardown、(2) `bootstrap/crash-handler.ts`（捕捉できた例外）、(3) **起動時の自動修復**
  （`setupTerminal()` 冒頭の `disableMouseReports()`）と脱出口 `codiva --reset-terminal`
  （`resetTerminalModes()`）。(3) を消さない — 強制終了に対して in-process の後始末は原理的に無力。
- **異常終了の理由はファイルに残す**（`bootstrap/crash-handler.ts` → `utils/crash-log.ts`）。
  alt screen のまま死ぬと stderr の内容は画面ごと消えるため、ログが唯一の手がかりになる。
  JS で拾えない死に方は Node の診断レポート（`process.report.reportOnFatalError`）に任せる。
- **`void` した Promise には必ず catch を付ける**。TUI の unhandled rejection はプロセス死
  （= 上記のクラッシュ経路）になる。とくに定期タイマー（PR ポーリング）と SDK の control
  request（`setModel` 等。サブプロセスが居ないと reject する）は裸で投げない。
- **デスクトップ通知は OSC（端末自身に出させる）を優先**する（`utils/notify.ts`）。
  `osascript` の `display notification` は **Script Editor 名義**になり、クリックすると
  スクリプトエディタが開いてしまう（バンドルを持たないプロセスの通知は AppleScript の
  代表バンドルに紐づく）。OSC なら通知が端末アプリ名義になり、クリックでその端末が前面に来る。
  対応方言は端末ごとに違う（OSC 777 / 9 / 99）ので `detectNotifyProtocol` で判定し、
  **確実に対応している端末だけ**を列挙する（OSC は解釈されたか分からず、誤判定すると
  通知が無音で消える＝動いていた OS 通知まで失う）。非対応端末・非 TTY は OS コマンドへ
  フォールバックする。判定は `TERM_PROGRAM` / `TERM` **だけに頼らない**（tmux が
  `TERM_PROGRAM` を上書きし `TERM` も screen-* に化けるため、tmux 内で必ず漏れる）。
  端末自前の変数（`GHOSTTY_BIN_DIR` / `WEZTERM_PANE` / `KITTY_WINDOW_ID` / `LC_TERMINAL` …）
  も見る。
- 外部コマンド起動（OS 通知フォールバック・URL オープン）は `utils/exec.ts` の
  `fireAndForget`（**argv 渡し**でシェル注入を防ぐ）。失敗は握り潰す best-effort。
- クリップボードは OSC 52（`utils/clipboard.ts`）。SSH 越しでも動くのでネイティブ依存を足さない。
  tmux 内での DCS パススルー包み（`wrapForTmux`）は通知の OSC と共用（`utils/terminal-mode.ts`）。
- **Claude Code の認証情報・非公開 API を触るのは `utils/privacy.ts` だけ**（学習データ利用の判定）。
  読み取り専用・失敗は必ず `'unknown'` に丸めて黙る・設定 `privacyWarning: false` で完全に無効化できる、
  の 3 点を崩さない（アカウント設定を codiva から書き換えない）。
