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
  `pr view <branch> --json number,url,state,mergeable,isDraft` /
  `pr create --draft --fill --head <branch>` /
  `pr view <branch> --json statusCheckRollup` / `pr ready <branch>`。
- 方針は「足場作りは自動、確定操作は緑判定/人手」: `completed` かつコミット済み差分があれば
  push → **draft** PR（1セッション1回）、20 秒ポーリングでチェックが緑になったら ready 化。
- `gh` 未導入・未認証・オフラインでも**セッションを壊さない**（失敗は握り潰す）。
  `PrAutomation` として DI するのはこのため。

## 生成・参照するファイル

| パス | 内容 | 書き手 |
|---|---|---|
| `<repo>/.codiva/worktrees/<slug>` | セッションの worktree | `WorktreeManager` |
| `<repo>/.codiva/state.json` | 復元用メタ（会話ログは入れない） | `utils/state-store.ts` |
| `<repo>/.codiva/prompt.md` | リポジトリ追加指示（空保存で削除） | `utils/repo-prompt.ts` |
| `<repo>/.git/info/exclude` | `# codiva` + `.codiva/` を追記 | `WorktreeManager` |
| `~/.codiva/config.json` | ユーザー設定 | `utils/config.ts` |
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
