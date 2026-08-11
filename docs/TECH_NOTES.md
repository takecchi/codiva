# 技術ノート: Claude Agent SDK / Ink

実装時に参照する技術リファレンス。SDK に関する記述は公式ドキュメント（https://code.claude.com/docs/en/agent-sdk/ 配下）を v0.3.214 時点で確認したもの。**着手前に Phase 1 のスパイクで実挙動を必ず検証すること**（「要スパイク検証」印の項目は特に）。

## 依存パッケージ

| パッケージ | 用途 | 備考 |
|-----------|------|------|
| `@anthropic-ai/claude-agent-sdk` | Claude Code セッションの起動・制御 | ESM専用。CLIバイナリ同梱（別途 claude インストール不要）。Node 18+ |
| `ink` (v7) + `react` (v19) | TUI | |
| 入力欄 | `useInput` で自作（`ui/input.ts` + presentational `PromptInput`） | ink-text-input は不採用（Ink 7 互換リスク回避） |
| `vitest` | テスト | カバレッジは `@vitest/coverage-v8` |
| `@biomejs/biome` | lint + format | ESLint/Prettier は使わない |
| `tsx` | 開発時実行 | `npm run dev` / spike 用 |
| `tsup` | ビルド（esbuild） | `dist/index.js` に単一ファイルバンドル。banner で shebang 付与 |

## モジュール/ビルド構成（バンドラ前提）

- `tsconfig`: `module: ESNext` / `moduleResolution: bundler` / `verbatimModuleSyntax: true` / `noEmit: true`。
- **import は拡張子なし**（`@/core`、`./app`）。`nodenext` + `.js` 拡張子は**使わない**（バンドラ前提の解決に統一）。
- 型チェック = `tsc --noEmit`（`npm run typecheck`）、ビルド = `tsup`（`npm run build`）。tsup は `dependencies` を external 扱いにするので SDK 同梱 CLI バイナリは実行時に解決される。

## Agent SDK: コアAPI

### query()

```typescript
import { query } from '@anthropic-ai/claude-agent-sdk';

const q = query({
  prompt,   // string | AsyncIterable<SDKUserMessage> — codiva は常に後者（streaming input mode）
  options,
});
// q は AsyncGenerator<SDKMessage> かつ以下のメソッドを持つ:
//   interrupt(): Promise<void>          ← streaming mode のみ
//   setPermissionMode(mode)             ← streaming mode のみ
//   setModel(model)                     ← streaming mode のみ
//   supportedModels(): Promise<ModelInfo[]>   ← streaming mode のみ。モデル一覧
//   initializationResult()              ← models/commands/agents/account をまとめて取得
//   close(): Promise<void>
```

- **streaming input mode**（prompt に AsyncIterable を渡す）でのみ、追加メッセージ投入・interrupt・setPermissionMode が使える。エラー result 後もストリームが生き続ける。codiva は必ずこのモードを使う。
- string prompt の単発モードはエラー時に throw して終わるため使わない。

### supportedModels(): モデル一覧は SDK から取る（直書きしない）

`/model` の選択肢は **`Query.supportedModels()` を唯一の出所にする**。モデル ID・表示名・
説明文をアプリ側に直書きすると、リリースごとに陳腐化するだけでなく、**アカウント種別・
サブスクリプション・エンタープライズの `availableModels` ポリシー・CLI バージョン**で
実際に選べるモデルが変わるため、ユーザーが使えないモデルを出してしまう。

```typescript
// prompt は「何も yield しない AsyncIterable」で良い（init ハンドシェイクだけで完結する）。
// モデル推論は走らないのでトークン消費もコストも無い。実測 0.3〜2 秒。
const models = await q.supportedModels();
```

`ModelInfo` の主要フィールド:

| フィールド | 内容 |
|---|---|
| `value` | `query({ options: { model } })` へ渡す文字列。`'default'` は「CLI 既定」の番兵 |
| `resolvedModel` | `value` が解決される正規 ID（`'sonnet'` → `'claude-sonnet-5'`）。保存済みの明示 ID をエイリアス行に突き合わせるのに使う |
| `displayName` / `description` | 表示用（**英語のみ**） |
| `supportsEffort` / `supportedEffortLevels` / `supportsAdaptiveThinking` / `supportsFastMode` / `supportsAutoMode` | 能力フラグ |

実測出力（SDK v0.3.214 / Claude Team / 2026-07-28）— `value` がエイリアスと
`[1m]` 付きフル ID の混在になる点、既定行にも `resolvedModel` が付く点に注意:

```jsonc
[
  { "value": "default",            "resolvedModel": "claude-opus-4-8[1m]", "displayName": "Default (recommended)",
    "description": "Opus 4.8 with 1M context · Best for everyday, complex tasks",
    "supportsEffort": true, "supportedEffortLevels": ["low","medium","high","xhigh","max"],
    "supportsAdaptiveThinking": true, "supportsFastMode": true, "supportsAutoMode": true },
  { "value": "opus[1m]",           "resolvedModel": "claude-opus-4-8[1m]", "displayName": "Opus" },
  { "value": "claude-fable-5[1m]", "resolvedModel": "claude-fable-5",      "displayName": "Fable" },
  { "value": "sonnet",             "resolvedModel": "claude-sonnet-5",     "displayName": "Sonnet" },
  { "value": "haiku",              "resolvedModel": "claude-haiku-4-5-20251001", "displayName": "Haiku" }
]
```

**落とし穴**: 既定行の `resolvedModel` で突き合わせてはいけない。`'default'` は
「未設定」専用として扱う（そうしないと明示的に Opus を選んだ設定が「デフォルト」行に
チェックされる）。`core/models.ts` の `isCurrentModel` がこれを担保している。

配線: 取得は `utils/model-catalog.ts`（`fetchModelCatalog`、I/O・throw しない）、
変換と突き合わせは `core/models.ts`（純粋）、起動時の発火は `src/index.tsx`（合成ルート）で
await せずに投げ、`App` の `useModelCatalog` が state に解決する。取得失敗時は
`FALLBACK_MODEL_OPTIONS`（**バージョンを含まないファミリーエイリアスのみ**）へ落ちる。

### codiva が使う Options

```typescript
const options = {
  cwd: worktreePath,             // ツールの作業ディレクトリ = セッションの worktree
  permissionMode: 'acceptEdits', // 既定。設定 permissionMode で上書き可
  canUseTool,                    // 下記参照
  abortController,               // セッション強制終了用
  maxTurns: 200,                 // 暴走防止の上限（要調整）
  settingSources,                // 既定 ['project']（対象リポジトリの CLAUDE.md / settings）。
                                 // 設定 claudeSettingSources で 'user' / 'local' を追加できる（下記）
  // Phase 6 で公開済み（設定ファイル ~/.codiva/config.json 由来、SessionOptions 経由で注入）:
  model, effort, maxBudgetUsd,   // それぞれ存在時のみ付与
  systemPrompt,                  // composeSystemPrompt() の結果。中身があるときのみ付与（下記メモ参照）
  resume: sdkSessionId,          // 復元時のみ付与。モデル側の会話コンテキストを引き継いで継続
};
```

**`settingSources` と Claude Code のプラグイン（実測）**:

プラグインの有効化（`enabledPlugins`）は `claude plugin install` が **`~/.claude/settings.json`（user 層）**
へ書く。`settingSources` に `'user'` が無いとその層自体が読まれないため、**プラグインは 1 つもロードされない**。
同一マシン・同一プラグイン構成（`frontend-design@…` / `rust-analyzer-lsp@…` の 2 件が有効）で
`claude --print --output-format stream-json --verbose` の `system/init` を比較した実測:

| 設定ソース | init の `plugins` | プラグイン由来の slash command |
|---|---|---|
| `--setting-sources project`（codiva の既定） | `[]` | なし |
| 既定（user + project + local） | 2 件ロード | `/frontend-design:frontend-design` |

そこで設定 `claudeSettingSources`（`core/config.ts`）で層を選べるようにし、
`resolveClaudeSettingSources()` → `createClaudeAdapter({ settingSources })` で注入する
（配線は `bootstrap/build-manager.ts` の `buildAgents`。`codexSandbox` と同じ「provider 固有の
設定はアダプタ工場へ」の形）。**`'project'` は指定に関わらず必ず含める** — CLAUDE.md はこの層でしか
読まれず、設定ミスで落ちると「リポジトリの決まりを知らないセッション」が黙って生まれるため。
既定を広げなかったのは、user 層を読むと hooks / permissions / statusLine といった**手元の Claude Code
用の設定まで worktree のセッションに載る**から（オプトインにして README に副作用を明記した）。

なお probe（`utils/sdk-probe.ts` = モデルカタログと `/usage`）は `['project']` 固定のまま。
init と control channel しか読まない短命プロセスで、プラグインも CLAUDE.md も要らない一方、
user 層を読むと**ポーリングのたびにユーザーの SessionStart hook が走る**ことになる。

**Phase 6 実装メモ（Options 関連）**:
- `model` (`string`) / `effort` (`'low'|'medium'|'high'|'xhigh'|'max'`) / `permissionMode`
  (`'default'|'acceptEdits'|'bypassPermissions'|'plan'|'dontAsk'|'auto'`) / `maxBudgetUsd` (`number>0`) は
  `~/.codiva/config.json` から読み、`core/config.ts` の `toConfig()` で検証。`SessionOptions` に束ねて注入。
- `resume` は復元セッションの最初の追加指示で付与（遅延 resume）。`sdkSessionId` は `system/init.session_id`。
- **`systemPrompt`（リポジトリ追加指示）**: `<repo>/.codiva/prompt.md` を `utils/repo-prompt.ts` の
  `loadRepoPrompt()` で読み、`core/repo-prompt.ts` の `toRepoPrompt()` で正規化（BOM 除去＋trim、空は無し）。
  存在時のみ `options.systemPrompt` に載せる。**SDK は `systemPrompt` 省略時に空文字（`""`）へ写像し、
  claude_code プリセットは使わない**（`sdk.mjs` の内部変換 `uO` で確認: `i===undefined → f=""`、
  `{type:'preset',preset:'claude_code',append}` を渡すと逆にプリセットが有効化される）。よって文字列を
  そのまま渡すのは「空への追記」と等価で、追加指示が無い場合の現挙動を一切変えない。CLAUDE.md は
  `settingSources: ['project']` 経由なので systemPrompt とは独立に効き続ける（両立）。**将来ベースの
  systemPrompt を導入する場合はこの単純代入では上書きになるため、array / preset-append 形へ要変更。**
  - **編集は `/prompt` から**: 一覧画面の `/prompt` で `ui/repo-prompt-editor.tsx`（現在値をシード）を開き、
    保存すると `SessionManager.setRepoPrompt()` が `options.appendSystemPrompt` を差し替え（**以降の新規
    セッション**に適用。既存の稼働中セッションは systemPrompt が query 開始時に確定済みなので不変）、
    `onRepoPromptChange` → `utils/saveRepoPrompt()` が `.codiva/prompt.md` を書き戻す（空保存で削除）。
- **`systemPrompt` の組み立て**: 純関数 `core/system-prompt.ts` の `composeSystemPrompt()` が
  「worktree の環境説明」→「リポジトリ追加指示」の順で連結する（両方無ければ `undefined` = 付与しない）。
  - **環境説明 = 共有 symlink の注意書き（`SHARED_IGNORED_FILES_NOTICE`）**: `ignoredFiles: 'symlink'`
    のときだけ載る。実測（このリポジトリ自身のセッション worktree）で `node_modules` / `dist` /
    `coverage` が元リポジトリを指すリンクになっており、worktree 内で `npm run build` すると
    **メインチェックアウトの `dist/` を書き換えてしまう**（他セッションのビルド結果も踏む）。
    ※ `dist` / `coverage` のような**既知の生成物は後に引き継ぎ対象から外した**（issue #81 /
    `DEFAULT_IGNORED_EXCLUDES`）ので現在はリンクにならないが、プロジェクト固有の生成物は
    依然リンクとして現れ得るため注意書き自体は必要。
    エージェントは「自分の worktree の中だから安全」と判断するのでこれは防げず、環境として
    伝えるしかない。必須要素は「書き込む前に該当パスだけリンクを切る」「`rm -rf <path>/` や
    `<path>/*` はリンクを辿って共有先を消すので禁止」「読むだけ・触らない作業では何もしない」の
    3点で、`system-prompt.spec.ts` が意味アンカー（`test -L` / `readlink` / `rm -rf` 等）で固定する。
    言語・ツールチェイン非依存にするため対象は `node_modules` 等の名前ではなく **`test -L` の結果**で
    判定させる。AI 向けプロンプトなので英語（i18n カタログ対象外。`utils/title.ts` と同じ扱い）。
  - **切り離し手順の実測**（macOS BSD / GNU coreutils 両方で確認）: 渡している手順は
    `target="$(readlink <path>)" && rm <path> && cp -Rp "$target/." <path>`。
    - `cp -RL`（リンクを全て実体化）は**採用しない**。ツリー内に循環リンク（`packages/*` を
      指す相互リンクや `..` を指すリンク）や壊れたリンクがあると **exit 1 で途中終了し、
      半端なコピーが残る**（BSD: `directory causes a cycle` / GNU: `cannot copy cyclic
      symbolic link`）。`"$target/."` なら**最上位リンクだけを辿る**ので、内部の symlink は
      symlink のまま残り、循環・壊れたリンク込みでも exit 0（実測）。
    - `mv <path> <path>.bak` で退避する形も**採用しない**。前回の失敗で `<path>.bak`
      （ディレクトリを指すリンク）が残っていると `mv` が**その中＝共有先へ移動**してしまう。
      加えて `<path>.bak` は `.gitignore` のディレクトリパターン（`node_modules/`）に
      マッチせず untracked として現れる。`readlink` 方式なら一時名が不要。
    - `-p` を付けるのはモードの保全のため（`.env` の 600 が umask で 644 に落ちるのを防ぐ）。
    - `rm <path>`（`-r` なし・末尾スラッシュなし）はリンクだけを消す。逆に `rm -rf <path>/` は
      **リンクを辿って共有先のディレクトリごと消える**（BSD / GNU 両方で実測）ので、
      注意書きで明示的に禁じている。
  - **symlink は `.gitignore` の末尾スラッシュパターンに載らない**（実測。使い捨てリポジトリで再現）:
    `.gitignore` の `node_modules/` は**ディレクトリにしかマッチせず symlink にはマッチしない**ため、
    symlink モードの worktree では `git check-ignore node_modules` が exit 1 で、`git status` に
    `?? node_modules` として現れる。`git add -A` すると **mode 120000（symlink）でステージされ**、
    コミット→マージすると絶対パス入りのリンクが base ブランチに入る。注意書きで
    「`git add -A` / `git add .` を使わずパス指定でステージする」ことを明示している。
    副作用として `diffStat().uncommitted`（一覧の表示用）にもリンクが混ざる（表示のみ。
    auto-PR はコミット済み差分だけを見るので誤発火はしない）。
- **`resume` はモデル側の会話コンテキストのみ復元する。過去メッセージはストリームに再送出されない**
  （検証済み: 復元直後の consumer には何も流れない）。そのため UI の会話ログは CLI が書く
  トランスクリプト `~/.claude/projects/<cwd の非英数字を '-' 化したもの>/<sessionId>.jsonl` から再構築する
  （純粋変換 `core/transcript.ts` の `transcriptLogEntries`、読み込みは `utils/transcript.ts`）。
  codiva 自身は会話ログを永続しない（state.json はメタデータのみ）。詳細は ARCHITECTURE.md「Phase 6 機能」。

`permissionMode` の全値: `'default' | 'dontAsk' | 'acceptEdits' | 'plan' | 'bypassPermissions' | 'auto'`。
`'acceptEdits'` は Edit/Write + ファイル操作系 Bash（mkdir/touch/rm/mv/cp/sed）を自動許可する。

### SDKMessage: 状態導出に使うメッセージ

```typescript
// 1. セッションID取得（resume 用に保存）
{ type: 'system', subtype: 'init', session_id: string }

// 2. assistant ターン（テキスト / tool_use を含む）
{ type: 'assistant', message: { content: Array<
    | { type: 'text', text: string }
    | { type: 'tool_use', id: string, name: string, input: any }
    | { type: 'thinking', ... }
>}}

// 3. 最終結果
{ type: 'result',
  subtype: 'success' | 'error_max_turns' | 'error_max_budget_usd' | 'error_during_execution' | ...,
  result?: string,          // success 時のみ最終テキスト
  session_id: string,
  total_cost_usd: number,
  usage: { input_tokens, output_tokens, ... },
  num_turns: number }
```

**注意**: streaming input mode では `result` はターンの区切りごとに届き、セッション終了を意味しない。`result` 受信 = 「Claude のターンが終わり入力待ちになった」と解釈する（completed 判定はこのタイミング）。

**サブエージェント（Task ツール）**: 本体エージェントが Task ツールで作業を委譲すると、サブエージェントのメッセージは `parent_tool_use_id`（= Task の tool_use id）付きで流れてくる（トップレベルは `null`）。サブエージェント自身は独自の `result` を出さず、**`result/success` は最後にトップレベル1件だけ**。ライフサイクルは `system/task_started` → `system/task_progress` → `system/task_updated`（`patch: { status: 'completed', end_time }`）→ `system/task_notification`（`status: 'completed'|'failed'|'stopped'`）。**決着が 2 系統で届く**点が重要で、codiva は両方を `task_settled` に写す（通知が来ないまま終わるタスクでも完了ゲートが解けるように）。Task が**バックグラウンド実行**されると tool_result が即返り本体ターンが続行するため、サブエージェント稼働中に `result/success` が先に届きうる。このとき素直に completed 判定すると「作業中なのに Completed」になる。対策は `task_started` と決着イベントで稼働中タスクを追跡し、稼働中に届いた result を保留 → 全タスク settle 後に completed 確定（ARCHITECTURE.md「完了ゲート」参照）。**逆にゲートが解けなくなるとセッションが永久に `running` に張り付く**ので、決着の判定は取りこぼさない側（「まだ走っている状態の否定」）に倒してある。実データは `scripts/spike.ts` の `subagent` シナリオで採取（`__fixtures__/session-subagent.jsonl`）。

`includePartialMessages: true` にすると `{ type: 'stream_event', event }`（`SDKPartialAssistantMessage`）で生のストリーミングデルタが届く。**Phase 6 で採用**：`event.type === 'content_block_delta'` かつ `delta.type === 'text_delta'` のときのみ `delta.text` を `state.streamingText` に連結し、詳細ビューにタイピング風プレビューを出す。確定 `assistant` メッセージ / `result` / 追加入力で `streamingText` はクリア（確定ログが正）。`streamingText` は transient で永続しない。非テキストデルタ（`input_json_delta`・thinking 等）は状態を変えない。`~100ms` スロットル（`useSessions`）で再描画コストを抑える。

### TODO進捗の抽出（Step n/m）— 要スパイク検証

Claude Code のタスク管理ツールは世代交代中。**両対応必須**:

```typescript
// 旧: TodoWrite — todos 配列で毎回全置換
{ type: 'tool_use', name: 'TodoWrite',
  input: { todos: Array<{ content: string, status: 'pending'|'in_progress'|'completed', activeForm?: string }> } }

// 新: TaskCreate / TaskUpdate — 増分更新
{ type: 'tool_use', name: 'TaskCreate',
  input: { subject: string, description?: string, activeForm?: string } }
{ type: 'tool_use', name: 'TaskUpdate',
  input: { taskId: string, status?: 'pending'|'in_progress'|'completed'|'deleted', subject?: string, ... } }
```

- TaskCreate はツール結果（`type: 'user'` メッセージ内の tool_result）に生成された taskId が入るはず。reducer は tool_use と tool_result を突き合わせる必要がある。**実際の tool_result の形はスパイクで確認**。
- どちらのツールが流れてくるかは SDK バージョン / env（`CLAUDE_CODE_ENABLE_TASKS`）依存。スパイクで確認し、確認結果をこのファイルに追記すること。

### canUseTool: 許可要求と質問の受け口

```typescript
type CanUseTool = (
  toolName: string,
  input: any,
  opts: { signal?: AbortSignal, suggestions?: PermissionUpdate[] },
) => Promise<
  | { behavior: 'allow', updatedInput?: any, updatedPermissions?: PermissionUpdate[] }
  | { behavior: 'deny', message: string }
>;
```

- Promise を解決するまで**セッションはブロックされる**（公式保証）。UI がユーザー応答を得るまで pending のままにしてよい。
- 自動許可されたツール（acceptEdits 対象や allowedTools マッチ）ではコールバックは呼ばれない。
- **`AskUserQuestion` は allow ルールに関係なく必ずコールバックに届く**。これが「質問あり」機能の実装点:
  - `toolName === 'AskUserQuestion'` → `awaiting_input` 状態にし、`input` に入っている質問・選択肢を UI 表示
  - ユーザーの回答を `updatedInput` に反映して `{ behavior: 'allow', updatedInput }` を返す
  - **AskUserQuestion の input スキーマと回答の返し方はスパイクで実物を確認すること**（要スパイク検証）
- deny 時の `message` は Claude に伝わり、別アプローチを試みる。

許可評価の優先順位: hooks → deny rules → ask rules → permissionMode → allow rules → canUseTool。

### streaming input: 追加メッセージの投入

Session 内部に push 可能な async キューを持ち、それを generator として渡す:

```typescript
class AsyncQueue<T> implements AsyncIterable<T> {
  push(item: T): void;   // UI から呼ぶ
  end(): void;
  // [Symbol.asyncIterator]() は push を待って yield し続ける
}

function toUserMessage(text: string): SDKUserMessage {
  return {
    type: 'user',
    message: { role: 'user', content: text },
    parent_tool_use_id: null,
  };
}
```

- generator は開きっぱなしで問題ない（SDK 側から close されない）。
- 追加メッセージは順次処理される。ターン実行中に push した場合の割り込み挙動はスパイクで確認（要スパイク検証。必要なら `interrupt()` してから送る）。

### 並列実行・リソース

- `query()` 1本 = `claude` サブプロセス1本。cwd を分けている限り相互干渉なし。
- メモリはセッションあたり最大 ~1GiB を見込む（公式ホスティングガイドの目安）。10並列なら開発機で現実的。
- セッションにタイムアウトはない。`maxTurns` で暴走を抑止する。
- 認証はサブプロセスが `~/.claude` の既存ログインを継承する。`ANTHROPIC_API_KEY` があればそれも使える。

### 補助的な `query()` は既定値のまま呼ばない（実測 2026-08-05 / SDK v0.3.214, haiku）

タイトル生成（`utils/title.ts`）のような**要約 1 回きり**の呼び出しでも、Options を既定のままにすると
Claude Code のプリセット（全ツール定義）と拡張思考が丸ごと積まれる。同一プロンプトでの実測:

| Options | 所要時間 | コスト/回 | 入力トークン |
|---|---|---|---|
| 既定のまま | 8.4 〜 11.1 秒 | **$0.086** | 56,144（`cache_creation_input_tokens`） |
| `tools: []` + `settingSources: []` + 文字列 `systemPrompt` + `thinking: {type:'disabled'}` | 2.3 〜 4.3 秒 | **$0.0011** | わずか |

**約 80 倍のコスト差**で、要約の質は変わらない。さらに遅さが実害になっていた: タイトル生成は
セッション開始と同時に走る（本体の `claude` サブプロセスと競合する）ため、既定のままだと
20 秒のタイムアウトを超えて `null` に落ち、**一覧のタイトルが指示文のまま残る**ことが実際に
あった（失敗は握り潰す設計なので何も表示されない）。タイムアウトは 30 秒へ広げた。

教訓: **エージェントではない補助呼び出しには、ツールも設定も思考も渡さない。**

## Ink 7 の実装メモ

- Ink 7 は React 19 前提。コンポーネントは通常の React。`render(<App/>)` で起動。
- **全画面（100dvh 相当）**: Ink はコンテンツの高さぶんしか描画しないインラインレンダラ。root Box に `useWindowSize()` の rows を `height` 指定すると Ink 7 がフルスクリーンフレームとして扱う（末尾改行なし・インクリメンタル消去。ただしフレームが端末高さを**超える**と全画面クリアにフォールバックしてちらつくので、root に `overflow="hidden"` を付けて超過を防ぐ）。端末が極端に低い（`MIN_FULLSCREEN_ROWS` 未満）ときは height 固定をやめてインライン描画へフォールバックする — クリップで入力欄・フッタが消えて操作不能になるより、端末スクロールに任せる方が安全。
- **`<Static>` は全画面レイアウトと両立しない**: Static はスクロールバック側に書き出すため、フレームが画面いっぱいだとビューポート外に消える。メッセージログは末尾ビューポート（flexGrow + `justifyContent="flex-end"` + `overflowY="hidden"`）+ `logWindow(lines, rows, anchor)`（`core/scroll.ts`）で再描画コストに上限を掛ける方式にした。スクロールの単位は**物理行**: エントリは `logLines(messages, width, prefixFor)` で CJK 幅（string-width）を考慮して折り返した `DisplayLine[]` に展開してから window する（複数行メッセージ 1 件でビューポートが埋まったり、スクロール量が実際の行数とズレるのを防ぐ）。`anchor` は `'bottom'`（末尾追従）か絶対 end index（上スクロール中は固定＝新着で view がぶれない）。PgUp/PgDn（半画面）と ↑/↓（1行）で `scrollUp`/`scrollDown`。alt screen でスクロールバックを無効化しているため、過去ログはこのアプリ内スクロールでのみ辿れる。
- **Yoga は溢れた子を「クリップ」せず「縮小」する**: `overflowY="hidden"` + `justifyContent="flex-end"` の箱に可視高さより多くの行を入れると、上端でクリップされるのではなく子が縮小され、**行が虫食いで欠落する**（`L1, L3, L5…` のように 1 行おきに消える）。詳細ログが「上へスクロールできない／読めない」原因はこれだった。対策は (1) 行の入れ物に `flexShrink={0}` を付けて縮小を禁じる（溢れは flex-end で上端クリップになる）、(2) `logWindow` に渡す行数を `useBoxHeight` で**実測した可視高さ**に合わせる（見積り `logViewportRows` は初回描画までのフォールバック。見積りは必ず実測以下に倒す）。加えてアンカーは 1 画面ぶんで下限を打ち、最上部でも 1 ページ分が埋まるようにする。
- **空文字の `<Text>` は高さ 0**（実測 / ink 7）: Ink の `measureText()` は `text.length === 0` のとき `{width: 0, height: 0}` を返す（`node_modules/ink/build/measure-text.js`）。そのため `<Text>{''}</Text>` は**行として一切場所を取らない**（`squashTextNodes` の結果が空なら描画もスキップされる）。ログの空行（Markdown の段落間、コードブロック内の空行）がこれに当たり、スクロール計算（`core/scroll.ts` は空行も 1 物理行として数える）が確保した高さより実際の描画が短くなって、**末尾寄せのビューポート上端に空行の本数ぶんの隙間が残る**（「表示できる行があるのに上が空いている」）。同時に段落の区切りも消えて行が詰まって見える。対策は行の描画側（`ui/session-detail.tsx` の `LogLine`）で空行を半角スペース 1 つに置き換え、必ず 1 行ぶんの高さを確保すること。`PromptInput` は各行を非空のプレフィックス `<Text>` と同じ `<Box>` に入れているため元から影響を受けない。
- **複数行入力**: 純粋モデルは `core/text-buffer.ts`（value + cursor、insert/backspace/move*/`visibleLineRange`）。キー→操作の対応は `ui/input.ts`（`editText`／`resolveEnter`）。Shift/Meta+Enter か末尾バックスラッシュ+Enter で改行、それ以外は送信（バックスラッシュは Shift+Enter を送れない端末向けの堅牢なフォールバック）。一覧ビューは矢印を行選択に温存するためカーソル移動なし（末尾編集＋改行のみ）、詳細ビューは矢印でフルにカーソル移動。`PromptInput` は `INPUT_MAX_ROWS` まで伸び、超過分は `visibleLineRange` でカーソル付近を内部スクロール（空/1行時は従来どおり1行高）。幅を超えた行は**ソフト折り返し**する（`core/composer-layout.ts` の `composerLayout`。空白があれば単語境界、無ければ表示幅で強制改行。CJK は 2 セル）。折り返し幅は Box の computed layout を実測して得る（`useComposerWidth` = 実測幅 − `❯ ` の 2 セル。ダイアログ内は端末幅と一致しないため引き算では求まらない）。以降「行」は表示行の意味になり、`visibleLineRange` / `caretIndexAtClick` / `rowSelection` / ↑↓（`moveRowUp`・`moveRowDown`）はすべて同じ幅の同じ幾何を通す。
- **SGR マウス ?1002 は「セルが変わったときだけ」移動を報告する**（実測）: ボタンを押したまま静止していると drag レポートが来ない。そのため「可視域の外へドラッグしたらスクロールを続ける」自動スクロールは、レポート駆動だけでは端で止まってしまう — `setInterval`（`LOG_EDGE_SCROLL_MS` = 50ms で 1 行）で回す必要がある。タイマーは向きが変わったときだけ張り替え、最新のステップ関数は ref 経由で渡す（ログの追記や再描画ごとに張り替えると 1 tick も進まないことがある）。スクロール位置（アンカー）も ref に持つ — 1 tick は「次のアンカー」から選択の終点を組み、「動かなかったか」でタイマーを止める判定もするため、`setState` の関数形（次の描画まで値が見えない）では書けない（値の**同期的な読み**が必要）。ログの範囲選択そのものは行 index + 桁（`core/log-selection.ts` の `LogPoint`）で持つので、スクロールしても選択位置の意味が変わらない。
- **`useInput`**: グローバルキーハンドラ。フォーカス管理は `useFocus` もあるが、MVP はビュー単位の単純な状態分岐で足りる。
- **`useApp().exit()`**: 終了。終了前に SessionManager.dispose()（全 abort）を呼ぶ。
- 再描画スロットリング: コアからの onChange を UI 側で ~100ms デバウンス。`useSyncExternalStore` の getSnapshot が返す参照が変わらなければ再描画されない点を利用する。
- **alt screen（代替スクリーンバッファ）**: 全画面レイアウトでも通常バッファのままだとシェルの過去出力がスクロールバックに残り、上へスクロールできてしまう。起動時に `\x1b[?1049h` で alt screen に入り、終了時に `\x1b[?1049l` で抜ける（`utils/alt-screen.ts`）。alt screen にはスクロールバックが存在しないため vim / htop と同様にスクロールがロックされ、終了すると元の画面が復元される。enter するのは「TTY かつ起動時の rows が `MIN_FULLSCREEN_ROWS` 以上」のときだけ（インライン描画フォールバック時はスクロールバックに頼るため通常バッファのまま）。終了時の残存 worktree 案内は leave 後に書き、通常バッファに残す。クラッシュ時の取り残し防止に `process.on('exit')` で leave を保険登録する。

## 端末モードの取り残しとクラッシュ診断（2026-08-03）

- **強制終了では `process.on('exit')` が走らない**。V8 のヒープ枯渇（`FATAL ERROR: Reached heap
  limit … JavaScript heap out of memory`）は `abort()` で即死し、`SIGKILL` / `SIGSEGV` も同様に
  JS を一切実行しない。よって `toggleEscape` の exit フックは**捕捉できる死に方にしか効かない**。
  取り残されるのはマウスレポート（?1002/?1006）で、症状は「ターミナルに戻ったあと、スクロールすると
  `[<64;12;5M` のような文字列が大量に入力される」（端末が SGR マウスレポートを送り続けている）。
- 復旧手段は 2 つ用意した。(1) **起動時に無効化してから** alt screen へ入る
  （`setupTerminal()` 冒頭の `disableMouseReports()`。次回起動で勝手に治る）、
  (2) 保守用フラグ `codiva --reset-terminal`（`resetTerminalModes()` = ?1000/?1002/?1003/?1006/?1015
  → ?2004l → ?25h → ?1049l を 1 回の write で送る）。off を送るのは冪等なので、有効でないモードへ
  送っても無害。
- **`process.report`（Node 診断レポート）は fatal error でも書かれる**。C++ 層が abort の**前に**
  書くため、JS ハンドラでは絶対に拾えない OOM / ネイティブクラッシュの唯一の記録になる。
  実行時に `process.report.directory` を設定して `reportOnFatalError = true` にするだけで有効
  （`reportOnSignal` / `reportOnUncaughtException` は自前のハンドラと二重になるので off）。
  出力は `report.<日時>.<pid>.<tid>.<seq>.json` で、`header.trigger`（OOM なら `OOMError`）・
  `javascriptHeap`（heapTotal / heapUsed / 各 space の使用量）・`nativeStack`・`resourceUsage`・
  **環境変数**まで含む（実測: Node 24 で `--max-old-space-size=24` を枯渇させて確認）。
  環境変数は `ANTHROPIC_API_KEY` を含み得るので、`process.report.excludeEnv`（Node 23.3+）が
  あるときは必ず立てる（古い Node には無いので `'excludeEnv' in report` で判定する）。
- **alt screen の中に stderr を出しても残らない**。leave すると画面ごと復元されるため、例外の
  スタックはユーザーの目に触れない（「突然ターミナルに戻った」に見えていた原因）。クラッシュ
  ハンドラは**先に端末を戻してから**書く。
- Ink 7 は children を ErrorBoundary で包み `onError` で `exit(error)` するので、**描画中の
  throw は `waitUntilExit()` の reject** として出てくる（= `main()` の reject → クラッシュ経路）。
  この場合 `index.tsx` の shutdown 列（ポーリング停止・`persist.flushAsync()`・teardown）は
  丸ごとスキップされるため、クラッシュハンドラ側にも同期 flush と端末復元を持たせている。

## ログ内 URL のクリック: 端末のリンク機能はマウスレポート中に使えない（調査 2026-08-04）

詳細ログの URL を「Cmd+クリックで開く」を端末任せにできるか調べた結論と、その根拠。

### SGR マウスレポートに Cmd/Super のビットは無い

xterm の仕様が定義する修飾ビットは **shift=4 / meta(alt)=8 / ctrl=16** だけ。Super/Cmd は無い。

- **Ghostty** (`src/input/mouse_encode.zig`): `shift→4` / `alt→8` / `ctrl→16` のみ。Cmd は**一切
  エンコードされない**ので、Cmd+クリックは素のクリックと**バイト列が同一**。
- **iTerm2** (`sources/VT100/VT100Output.m`): **Cmd → bit 8（meta）** に割り当て、Option は
  エンコードしない（Option がマウスレポートのバイパスキーだから）。
  → **bit 8 の意味が端末ごとに違う**（Ghostty では Option、iTerm2 では Cmd）ので、
  bit 8 で「Cmd」を判定することはできない。

### マウスレポート有効時のリンククリックは端末で流派が 2 つに割れる

| 流派 | 端末 | 素の Cmd/Ctrl+クリック | 必要な操作 | アプリにもクリックが届くか |
|---|---|---|---|---|
| マウスレポート優先 | **Ghostty** / kitty / WezTerm | **効かない**（ホバー下線も出ない） | **Shift+Cmd+クリック**（Shift がバイパス） | 届かない（端末が飲む） |
| ハイパーリンク優先 | iTerm2 / VTE(gnome-terminal) / Windows Terminal / VS Code | 効く | Cmd / Ctrl+クリック | iTerm2・VS Code は**届くこともある** |

Ghostty の該当箇所（`src/Surface.zig` の `cursorPosCallback`）は、リンクのホバー判定を
「マウスレポートが off、**または** shift が押されていて shift をアプリへ送らない設定のとき」に
限っている。`mouseRefreshLinks` が `mouse.over_link` を立てる唯一の経路で、
`mouseButtonCallback` はそれを見てリンクを開くので、**捕捉中は素の Cmd+クリックでは
ホバーもクリックも成立しない**。裸 URL の自動検出（`link-url`）も同じ経路なので同様。

→ **主端末（Ghostty）が最悪ケース**で、設定でも直せない（`mouse-reporting = false` にするか
Shift を足すしかない）。一方 **素の左クリックはどの端末でもアプリに SGR レポートとして届く**。
そこで codiva は**自分でクリックを取って開く**方式にした（`logLinkAt` → `utils/open-url.ts`）。
OSC 8 は「対応端末では端末側の Cmd+クリックも使える」上乗せとして併せて出す。

### OSC 8 は Ink 7 の計測・再構築を安全に通る（実測）

`\x1b]8;;URL\x1b\\text\x1b]8;;\x1b\\` を実際に測った結果（このリポジトリの依存で確認）:

| パッケージ | 版 | 結果 |
|---|---|---|
| `string-width` | 8.2.2 | `stringWidth(OSC8('click'))` = **5**（= 表示テキストぶんだけ） |
| `@alcalzone/ansi-tokenize` | 0.3.0 | セル数 **5**、再構築して OSC 8 が**保持される** |
| `ansi-regex` / `wrap-ansi` / `slice-ansi` / `cli-truncate` | 6.2.2 / 10.0.0 / 9.0.0 / 6.1.1 | OSC 8 対応済み |

必要な最低版は `ansi-regex ≥6.1.0` / `wrap-ansi ≥10` / `slice-ansi ≥8` / `ansi-tokenize ≥0.3.0`
（2024-09 以前のエコシステムは ST 終端の OSC 8 を扱えず壊れていた）。

**ただし codiva 自身の折り返しは通らない。** `core/scroll.ts` の `wrapDisplayLines` は
`Intl.Segmenter` でグラフェム単位に分けて 1 つずつ measure するので、OSC 8 を混ぜた文字列を
渡すと**エスケープのバイトを可視幅として数える**（幅 20 で測ったら可視 21 セルの文字列が 4 行に
割れ、URI が行の途中で断ち切られた）。よって **OSC 8 は `LogEntry.text` / `RichSpan.text` に
入れず、描画時（`ui/log-line.tsx`）にだけ包む**。パラメータ形（`id=`）は `wrap-ansi@10` が
壊す（`ANSI_ESCAPE_LINK` が `]8;;` 決め打ち）ので使わない。

### tmux / その他の注意

- tmux は 3.4+ が OSC 8 を**自前で解釈して再送**する（パススルーではない）。ただし
  `Hls` を送る相手を自動判定するのは tmux / iTerm2 / foot / WezTerm / ghostty だけで、
  kitty・VTE・Windows Terminal は `set -ga terminal-features "*:hyperlinks"` が必要。
  URI は **1024 バイト**で打ち切られる（`core/url.ts` の `MAX_URL_CHARS` がこれに合わせてある）。
- tmux ≤3.3a は OSC 8 を**黙って捨てる**（可視ゴミにはならない）。`screen` は非対応。
- 仕様準拠の端末は未知の OSC を無視するだけなので、**出しても表示は壊れない**
  （可視ゴミが出るのは VTE ≤0.48 / Windows Terminal ≤0.9 など相当古い版）。
- `supports-hyperlinks` パッケージは **tmux 内で false を返す**（`TERM_PROGRAM` を tmux が
  上書きし `TERM` も `screen-*` になる）。通知の `detectNotifyProtocol` と同じ罠なので、
  能力判定に使わない（codiva は判定せず常に出し、非対応端末の無視に任せている）。

## ヒープ枯渇の実測（2026-08-04）

報告された落ち方（node 22 / 既定のヒープ上限）:

```
FATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed - JavaScript heap out of memory
 8: … v8::internal::MinorGCJob::Task::RunInternal()
zsh: abort      codiva
```

- **`Ineffective mark-compacts` は「回収が確保に追いつかない」**の意味で、`Reached heap limit` と
  違って「巨大な 1 個」ではなく**確保レートが高い**ときに出る（ネイティブスタックの最上位が
  `MinorGCJob` = 新世代 GC のジョブなのがその印）。だから犯人は「捨てているのに作り続けている」
  コード = **毎更新でログ全体を作り直していた `logLines`** だった。
- **実測**（2,000 文字級の Markdown エントリ 500 件、幅 100 セル、「1 件追記 → 再描画」を 500 回
  = 実際の追記ごと再描画と同じ形）:

  | | 所要 | 生成した `DisplayLine` |
  |---|---|---|
  | メモ化なし（従来） | **23.3 秒** | 約 75 万個（+ `spans` 配列） |
  | エントリ単位メモ化 | **0.10 秒** | 3,000 個（最終フレームぶんだけ） |

  226 倍。ログが伸びるほど差が開く（従来は追記 n 件目のコストが O(n)）。
- 併せて保持側にも上限を掛けた（`core/log-buffer.ts`）。`SessionState.messages` は上限なしで、
  かつ追記が `[...messages, entry]` = **全体コピー**だったため、長いセッションでは保持量と
  確保量が同時に増えていた。
- **メモ化は「一過性のゴミ」を「永続的な保持」に変換する**ので、キャッシュ側にも予算が必要
  （実測。`--expose-gc` + `gc()` 後の `heapUsed` 差分）:

  | | 保持量 |
  |---|---|
  | 行数上限なし・2000 件 × 1,500 文字を 1 セッション描画 | **91 MB**（30,000 行） |
  | 同条件の最悪ケース（2000 件 × 20,000 文字） | **~1.25 GB**（40 万行） |
  | `MAX_CACHED_ROWS` = 8,000（LRU）+ `MAX_LOG_CHARS` = 400,000。上限まで詰めた 6 セッションを描画 | **22 MB** |

  1 行は「素のテキスト」と「スパン（同じ文字を styled で持つ）」の両方を抱えるので、
  展開後は元テキストの数倍になる。**件数の上限だけでは足りない**（1 件は 1 文字でも 20,000 文字でも
  よいので、件数 × 1 件上限 = 4000 万文字）。
- **LRU は「描画中の行」を追い出してはいけない**。予算より大きいログを描くとき、素直に古い順で
  捨てると自分がこのフレームで使う行を捨てて毎フレーム全再展開になる（= 元の症状に戻る）。
  `logLines` はパス番号で「今回使った行」を守り、予算は soft budget として扱う。実測: 上限いっぱい
  （2000 件・12,000 行 = 予算の 1.5 倍）で「1 件追記 → 再描画」を 300 回回して **0.40 ms/フレーム**。
- **1 セッション = `claude` サブプロセス 1 本（最大 ~1GiB）**という別枠のメモリもあるので、
  「codiva 本体のヒープ」と「サブプロセスの合計」を混同しないこと。前者はクラッシュログの
  `memory` 行（rss / heapUsed / heapTotal）、後者は `ps` で見る。

## ヒープ枯渇の実測 2（2026-08-06）— React の Performance Tracks

上の対策を入れた 0.3.8 で**また OOM で 3 回落ちた**（`~/.codiva/logs/report.*.json`）。前回と違い
今回は**保持漏れ**で、しかも**描画内容と無関係**だった。

- 診断レポートの読み方: `old_space` 4.15〜4.22GB / `large_object_space` は 54〜57MB だけ
  ⇒ 「巨大な 1 個」ではなく**小さいオブジェクトが数百万個生存**。`resourceUsage.userCpuSeconds`
  が 1571 / 1628 / 1986 秒（= GC スレッドがほぼ回りっぱなし）。`crash-*.log` は無い（OOM は
  `abort()` 即死なので JS が走らない = 設計どおり）。
- 既報だった（[ink#869](https://github.com/vadimdemedes/ink/issues/869) /
  [facebook/react#35761](https://github.com/facebook/react/issues/35761)。どちらもクローズ済みで、
  結論・対策も同じ `NODE_ENV=production`）。以下は診断レポートから独立に辿り直した記録。
- 犯人はヒープスナップショットで一発だった。上位が `PerformanceMeasure` × 60,003
  （= 20,000 描画 × **3**）と `Components ⚛` / `Changed Props` / `Scheduler ⚛` /
  `primary-light` といった文字列 = **React 19.2 の Performance Tracks**。
- ゲートは `react-reconciler.development.js` の `supportsUserTiming`
  （`console.timeStamp` && `performance.measure`）で、**モジュール評価時の `var` 初期化**。
  Node には両方あるので必ず有効になり、後から `console.timeStamp` を消しても間に合わない。
- **Node の user timing は自動で捨てられない**（ブラウザの devtools が消費する前提の API）。
  長時間動く TUI では単純なリークになる。

| 条件（空 Box を 8,000 回再描画・`--expose-gc` + 強制 GC 後の heapUsed 差分） | 永久保持 | perf エントリ | 所要 |
|---|---|---|---|
| dev ビルド（従来） | **2,230 B/フレーム** | 24,003 件 | 414ms |
| `NODE_ENV=production` | 117 B/フレーム | 0 件 | **166ms** |
| dev + 500 フレームごとに `clearMeasures()` | 174 B/フレーム | 1 件 | 406ms |

- 描画は約 10/秒（ストア購読の ~100ms スロットル。実測でも 9〜10/秒）⇒ **約 86MB/時**。
  既定のヒープ上限 ~4GB に半日〜1 日で到達する。**production ビルドは描画自体も 2.5 倍速い**
  （報告された 26〜33 分の CPU 時間の相当部分がこれ）。
- `NODE_ENV` を react より先に立てるには**エントリを分けるしかない**。ESM の static import は
  巻き上げられて本文より先に評価されるので、`tsup` の `banner` では間に合わない。
  シバンに `#!/usr/bin/env -S NODE_ENV=production node` を書く手は macOS では動くが、
  **mise 経由の起動は `node <path>` 直叩きでシバンを通らない**（実際のクラッシュレポートの
  `commandLine` がこれ）ので当てにならない。

#### 副作用: `NODE_ENV` は子プロセスに継承される（issue #103）

`process.env.NODE_ENV = 'production'` は codiva 自身のプロセスに対する設定だが、そこから
spawn した子（`claude` / `codex` → **エージェントのシェル**）にもそのまま渡る。npm は
`NODE_ENV=production` を `--omit=dev` と解釈するので、セッション内の `npm ci` が
devDependencies を落とす。実測（codiva 0.4.3 / npm 11.x / Node 24）:

```console
$ npm ci                     # セッション内（NODE_ENV=production を継承）
added 103 packages           # @types/* も vitest も eslint も入らない
$ NODE_ENV=development npm ci --include=dev
added 235 packages
```

最小再現（`devDependencies` に `is-odd` だけを置いた package.json）:

```console
$ NODE_ENV=production npm install --silent; test -d node_modules/is-odd && echo YES || echo NO
NO
$ env -u NODE_ENV npm install --silent; test -d node_modules/is-odd && echo YES || echo NO
YES
```

出るのは「依存が無い」ではなく `error TS7016: Could not find a declaration file for module …`
のような型エラーなので、原因が npm だと辿り着きにくい。対策は「codiva 自身は production の
まま、**子へ渡す env からだけ落とす**」（`core/child-env.ts` / `utils/child-env.ts`。設計は
docs/ARCHITECTURE.md「子プロセスへ渡す環境変数」）。

### Ink 7.1.1 の上限なしキャッシュ（上流の問題）

同じ調査で見つかった、もう 1 つの解放されない保持:

- `ink/build/measure-text.js` … `const cache = new Map()`（キー = テキスト全文）
- `ink/build/wrap-text.js` … `const cache = {}`（キー = `text + maxWidth + wrapType`）

どちらも evict が無く、供給経路は yoga の measure func（`dom.js` の `measureTextNode`）なので
**レイアウト計算のたび**に最大 3 エントリ積まれる（`renderThrottleMs` は stdout 書き込みだけを
間引くので効かない）。実測（`--expose-gc` + 強制 GC 後の差分、unmount 後も残る）:

| 描いたもの（毎フレーム内容が変わる） | 永久保持 |
|---|---|
| 約 100 文字の行 1 本 | 約 1.7KB |
| 4,000 文字の `<Text wrap="truncate-end">` 1 本 | **約 17.8KB** |
| 内容が固定の行（キャッシュに当たる） | 約 0.5KB |

codiva 側で効く対策は「**毎フレーム変わる長い文字列を渡さない**」だけ。当初はストリーミング
中の本文を 1 行に切って（`streamTail(text, width)`）渡すことで対処した（実測: 4,000 文字の
最悪ケースで 6,786 → 3,129 B/フレーム）。

本文をログの行として下へ伸ばすようにしてからは、**折り返してから 1 行ずつ渡す**
（`core/scroll.ts` の `streamLines`）ことで同じ性質を保っている。末尾に足すだけなら
確定した行の文字列は変わらない = キャッシュに当たるので、毎デルタで新しく積まれるのは
書きかけの最終行 1 本だけで、1 行プレビューだった頃と同じコストになる。**この性質は
2 つの前提に依存する**ので、どちらも崩さないこと:

1. **途中テキストを Markdown 整形しない**。未完の `**` や ``` があると整形結果が
   デルタごとに変わり、全行の折り返しがズレて毎フレーム全行が別のキーになる。
2. **頭を落とすときは行頭で落とす**（`clipStreamText`）。行の途中で切ると残った行の
   折り返しが全部ズレる。上限（8k）と落とし先（4k）を別の値にしてあるのは、同じ値だと
   上限到達後は 1 文字届くたびに切り直すことになるため。

上限そのものは ink 側の修正が必要（[ink#986](https://github.com/vadimdemedes/ink/issues/986) で報告済み。
こちらは未報告のバグだった）。

## デスクトップ通知の実装メモ

- **macOS の `osascript display notification` は「Script Editor」名義になる**（実測 / macOS 15）。通知センターは通知を**アプリバンドル単位**で管理し、`osascript` は自前のバンドルを持たないため AppleScript の代表バンドル `com.apple.ScriptEditor2` に紐づく。通知クリックは「送信元アプリのアクティベート」なので、codiva の完了通知を押すと**スクリプトエディタが開く**（同じ症状の報告: [opencode#23446](https://github.com/anomalyco/opencode/issues/23446)）。`-sender` 相当の指定は `osascript` には無く、`tell application id "…" to display notification` で端末アプリ名義にする手は TCC（自動化）許可プロンプトが必要になる。
- **対策は端末自身に通知を出させる OSC シーケンス**（`utils/notify.ts` の `buildNotifySequence`）。端末エミュレータが投函するので通知は端末アプリ名義になり、クリックでその端末が前面に来る＝復帰動線として正しく機能する。OSC 52（クリップボード）と同じく SSH / コンテナ越しでも動く。方言が 3 つあるので端末ごとに使い分ける:

  | 方言 | 形 | 対応端末 |
  |---|---|---|
  | OSC 777 | `ESC ] 777 ; notify ; <title> ; <body> BEL` | Ghostty / WezTerm / foot |
  | OSC 9 | `ESC ] 9 ; <body> BEL`（**本文 1 つだけ**。タイトルは端末名） | iTerm2 |
  | OSC 99 | `ESC ] 99 ; i=<id>:d=0:p=title:e=1 ; <base64> ST` + `d=1:p=body` | kitty |

- 判定は環境変数（`detectNotifyProtocol`）。**OSC は投げっぱなしで解釈されたか分からない**（無視されれば無音で消える＝動いていた OS 通知まで失う）ため、**対応が確実な端末だけ**を列挙し、それ以外は従来の OS コマンド（`osascript` / `notify-send`）へフォールバックする。非 TTY のときもエスケープは書かない（ゴミが残るだけ）。意図的に外したもの:
  - **Windows Terminal**: 通知用 OSC 777 は [microsoft/terminal#20012](https://github.com/microsoft/terminal/pull/20012) で実装されたが `allowOSC777` 設定が既定 false。OSC 9 の方は ConEmu 方言の数値サブコマンド（`9;4` プログレス等）専用で `9;<text>` の通知ではない。
  - **urxvt**: OSC 777 は「第1フィールドの名前の perl 拡張へ丸投げ」する汎用口で、`notify` 拡張は同梱されていない（`perl-ext-common` での追加読み込みが必要）。
- **tmux は `TERM_PROGRAM` を `tmux` で上書きする**（tmux 3.2 で `TERM_PROGRAM`/`TERM_PROGRAM_VERSION` を export するようになった）。`TERM` も screen-* に化けるため、`TERM_PROGRAM`/`TERM` だけ見ると **tmux 内では必ず判定漏れして Script Editor 名義に戻る**。端末が自前で撒く変数（`GHOSTTY_BIN_DIR` / `GHOSTTY_RESOURCES_DIR` / `WEZTERM_PANE` / `WEZTERM_EXECUTABLE` / `KITTY_WINDOW_ID` / `ITERM_SESSION_ID`）は tmux サーバ起動時の環境として残るので、これらも判定に使う。iTerm2 の `LC_TERMINAL=iTerm2` は **ssh が既定で転送する**（`SendEnv LC_*`）ので、リモートの codiva からでも手元の iTerm2 に通知が出る。tmux 内では OSC を DCS パススルーで包む（`utils/terminal-mode.ts` の `wrapForTmux`。`allow-passthrough on` が必要）。
- 文字列は制御文字を空白へ潰し 120 文字で切る。ESC / BEL がシーケンスの終端子なので、セッションタイトル（LLM がリポジトリ内容から作る＝非信頼入力）にそれらが混ざるとシーケンスが途中で切れて壊れる。C0 / DEL だけでなく **C1（U+0080–U+009F）も落とす**: UTF-8 のまま U+009C を ST、U+009B を CSI として解釈する端末があるため。OSC 777 の title 内 `;` はフィールド境界と誤読されるので `,` へ置換（body は最終フィールドなので不要）、OSC 9 は本文が `9;4;70` のような数値サブコマンドに化けないよう `;` を全部置換する。OSC 99 は payload を base64（`e=1`）にして `;` / 非 ASCII をそのまま運び、id は `<pid>-<連番>`（同じ id は上書き・連結されるため、1 端末で codiva を 2 つ動かしても衝突しないように pid を混ぜる）。

## git worktree の実装メモ

```bash
# 作成（HEAD から新ブランチを切る）
git worktree add .codiva/worktrees/<slug> -b codiva/<slug>

# 一覧（porcelain がパースしやすい）
git worktree list --porcelain

# 削除（未コミット変更があると失敗する。UI で確認後 --force）
git worktree remove .codiva/worktrees/<slug> [--force]
git branch -D codiva/<slug>

# diff 概要（ベースブランチとの比較）
git -C .codiva/worktrees/<slug> diff <base>...HEAD --stat
git -C .codiva/worktrees/<slug> status --porcelain   # 未コミット分

# マージ（メイン worktree 側で実行）
git merge --no-ff codiva/<slug>
```

- コミットが1つもないリポジトリでは worktree を作れない → 起動時チェックで弾く（F-1）。
- 同名ブランチ/worktree の衝突: slug に連番を付与。
- **`.codiva/` を git から隠すのは `.codiva/.gitignore`（中身は `*` の 1 行）**。`*` は同じディレクトリの `.gitignore` 自身にも一致するので、この 1 ファイルだけでディレクトリ全体が ignore される（cargo の `target/.gitignore` と同じ手）。無いときだけ書くので冪等。
  - **`.git/info/exclude` への追記に戻さない**。`.git` はディレクトリとは限らない — linked worktree（`git worktree add` で作った作業ツリー）と submodule では `gitdir: <path>` を書いた**ただのファイル**なので、`<repo>/.git/info/exclude` への `appendFile` が **ENOTDIR** で失敗する（実測）。codiva 自身のリポジトリを codiva の worktree の中から開いた場合がまさにこれで、握り潰していなかったため worktree 作成ごと失敗していた。
  - **副作用**: `.gitignore` の出所がそのディレクトリの中にあると、`git ls-files --others --ignored --exclude-standard --directory` は `.codiva/` を 1 件に畳まず中身まで列挙する（実測: `.codiva/` / `.codiva/.gitignore` / `.codiva/state.json` / `.codiva/worktrees/` の 4 件）。ignore 済みファイルの引き継ぎフィルタが完全一致（`entry === '.codiva'`）だと `.codiva/worktrees/` が引き継ぎ対象に化け、新しい worktree の中に worktree 群自身へのリンクが張られる → 以後の `git worktree remove` が `Too many levels of symbolic links` で失敗した。**先頭セグメントで判定する**（`isInternalEntry()`）。
- git 実行は必ず `execFile`（シェル経由禁止。slug はサニタイズ済みだが多層防御）。
- **worktree がリポジトリ配下にあることの副作用（issue #81 の実測）**: `.codiva/worktrees/<slug>` は
  プロジェクトルートの下なので、**ルートから再帰的にファイル監視する開発サーバ**（Next.js /
  Turbopack の `next dev --turbopack`。macOS では FSEvents）の監視対象に入る。ここに
  `<worktree>/.next -> <root>/.next` のようなリンクがあると、開発サーバが**自分で書き込んでいる
  ディレクトリ**を worktree の数だけ別経路として再検知する。報告例は worktree 6 個で
  CPU / メモリ / FD を食い潰し **OS ごとフリーズ**（`node_modules` も同様に多重経路になる）。
  → 対策として、ビルド生成物・キャッシュは引き継ぎ対象から外した（`DEFAULT_IGNORED_EXCLUDES`。
  `node_modules` は依存なので引き継ぎを維持 —— Next.js / Vite 等の監視は `node_modules` を
  既定で除外する）。監視そのものを軽くしたい場合は、利用者側で `.codiva` を
  開発サーバの監視除外に足すのが確実（**codiva は対象リポジトリの `.gitignore` を書き換えない**ので、
  git 用の除外は `.codiva/.gitignore` = 自分の持ち物の中までに留める）。worktree の置き場所をリポジトリ外へ移す案は
  取らない（`.codiva/worktrees/<slug>` 前提のパス・復元・`takenSlugs()` を崩さないため）。

## テスト戦略

- `core/` は SDK 非依存でテストする: `Session` に `queryFn` を DI し、テストでは「SDKMessage の配列を順に yield し、canUseTool を任意タイミングで発火させる」フェイクを注入。
- **テスト配置**: 単体テストは実装の隣に co-located `*.spec.ts`（`src/core/slug.spec.ts` 等）。App 全体を通す機能/統合テストは `tests/*.test.tsx`。vitest の include は `src/**/*.spec.{ts,tsx}` と `tests/**/*.test.{ts,tsx}` の両方。coverage は `**/*.spec.*` と `**/__fixtures__/**` を除外。
- **フィクスチャは Phase 1 スパイクで収集した実メッセージ JSONL を使う**（`src/core/__fixtures__/`）。手書きの想定メッセージでテストを書かない。
  - **`__fixtures__/` に昇格する前に必ずサニタイズする**。`system/init` は環境情報の塊（`cwd` の絶対パス・`memory_paths`・接続中 MCP サーバ名・`skills`/`slash_commands`/`agents` 等）を含むので、テストが使う `session_id` 等だけ残して環境フィンガープリントを削り、`/Users/<name>` 等の個人パスも置換する（reducer が読むのは init の `session_id` のみ）。生ログ置き場 `scripts/fixtures/` は `.gitignore` 済み。
- `status-reducer` は純関数なのでテーブルドリブンでテスト。
- `WorktreeManager` は一時ディレクトリに実リポジトリを作って統合テスト（`git init` → コミット → add/remove/merge）。
- UI は `ink-testing-library`。カバレッジ 80% の対象は core/ と utils/（`.spec` は対象外）。

## スパイクで検証すべき項目（Phase 1 チェックリスト）

1. TodoWrite と TaskCreate/TaskUpdate のどちらが流れてくるか。tool_result から taskId をどう取るか
2. AskUserQuestion の input スキーマと、回答を updatedInput でどう返すか
3. streaming input mode での result メッセージの届き方（ターン毎に届くか、completed 判定に使えるか）
4. ターン実行中に追加メッセージを push した場合の挙動（キューされるか、割り込むか）
5. interrupt() の効果と、interrupt 後にセッションが継続可能か
6. acceptEdits で実際に canUseTool に落ちてくるツールは何か（Bash が来ることの確認）
7. 検証結果と実メッセージのサンプルを本ファイル末尾に「スパイク結果」節として追記する

## スパイク結果（Phase 1 実測 / SDK v0.3.214, claude-fable-5, 2026-07-18）

`scripts/spike.ts` を basic / followup / interrupt の3シナリオで実行（のちに subagent シナリオを追加）。実メッセージは `src/core/__fixtures__/session-{basic,followup,interrupt,subagent}.jsonl` に保存済み（reducer / sdk-parse テストの正データ）。以下は実測結論。**想定と違った点を太字にした。**

### 観測されたメッセージ型

`system/init`, `assistant`, `user`（tool_result を含む）, `result/success`, `result/error_during_execution`, `system/thinking_tokens`, `rate_limit_event`。
observed した tool_use: `TaskCreate`, `TaskUpdate`, `AskUserQuestion`, `Write`, `Bash`, `ToolSearch`。

### 1. TODO進捗 → **`TaskCreate` / `TaskUpdate` が使われる（`TodoWrite` は出ない）**

- `TaskCreate` input: `{ subject, description?, activeForm? }`。ID は input に無く、システムが**連番の文字列**（`"1"`, `"2"`, …）を採番して返す。
  - 文字列 tool_result: `"Task #1 created successfully: <subject>"`
  - **構造化結果**: user メッセージの `tool_use_result` に `{ task: { id, subject } }`（`TaskCreateOutput`）。ID はここから確実に取れる。
- `TaskUpdate` input: `{ taskId, status, subject?, description?, activeForm?, ... }`。`status ∈ 'pending'|'in_progress'|'completed'|'deleted'`。tool_result 構造化: `{ success, taskId, updatedFields }`。
- **reducer 実装方針**: `assistant` の tool_use を走査し、`TaskCreate` で `{id: 連番, subject, status:'pending'}` を push、`TaskUpdate` で `taskId` 一致タスクの status を更新。ID は「N番目の TaskCreate → id=String(N)」で採番すれば実測と一致（`tool_use_result.task.id` で照合すればより堅牢）。進捗 = `completed数 / 全数`。
- `system/task_*`（task_started 等）メッセージは**トップレベルでは出ない**（あれは Task ツール=サブエージェント用）。無視してよい。

### 2. AskUserQuestion → canUseTool 経由、**`answers` を updatedInput に入れて回答**

- input: `{ questions: [{ question, header, options: [{label, description, preview?}], multiSelect }] }`（1〜4問、各2〜4択）。
- **回答方法（重要・実測）**: `canUseTool` で `{ behavior: 'allow', updatedInput: { ...input, answers } }` を返す。`answers` は `{ [questionText]: 選択ラベル }`（multiSelect はカンマ区切り文字列）。自由入力は `response?: string`。
  - 回答した場合の tool_result: `"Your questions have been answered: \"...\"=\"...\"."`
  - **回答せず allow だけ返すと** tool_result は `"The user did not answer the questions."` になり質問が無視される。必ず `answers` を入れること。
- 出力型 `AskUserQuestionOutput`: `{ questions, answers: {[k]:string}, response?, annotations?, afkTimeoutMs? }`。
- **codiva 実装方針**: `toolName === 'AskUserQuestion'` を検知 → `awaiting_input` 状態で質問/選択肢を UI 表示 → ユーザー選択を `answers` に載せて allow。回答が返るまで Promise を保留。

### 3. result はターン毎 / session_id は安定

- streaming input mode で `result/success` は**ユーザーターンごとに1回**届く（followup で2回確認）。セッション終了ではない。
- followup では2ターン目に **`system/init` が再度届いた**が、**session_id は全メッセージで同一**。→ init はターン毎に来ても、session_id で1セッションとして束ねる。
- `result` の主なフィールド: `subtype`, `is_error`, `session_id`, `num_turns`, `total_cost_usd`, `usage`, `modelUsage`, `result`(string, success時), `stop_reason`, `permission_denials`, `duration_ms`。
- **completed 判定**: `result/success` 受信 = 「ターン完了・入力待ち」。codiva は暫定的にこれを `completed`（追加入力があれば running に戻る）として表示する。

### 4. 追加メッセージ push

- 前ターンの `result` 後に `input.push()` すると次ターンが開始する（followup で確認）。キューは順次処理。
- ターン**実行中**の push はキューされ、現ターン完了後に処理される（実測上は割り込まない）。即時割り込みが必要なら `interrupt()` を併用。

### 5. interrupt()

- `q.interrupt()` を呼ぶと現ターンが打ち切られ、`result/**error_during_execution**` が届く（`success` ではない）。
- streaming input が開いていればセッション自体は生存し追加 push で継続可能。codiva の「中断して再指示」に使える。
- 打ち切られた result の中身（実測 = `__fixtures__/session-interrupt.jsonl`）:
  `is_error: true` / **`terminal_reason: 'aborted_streaming'`** / `errors: ['[ede_diagnostic] result_type=user …']`
  / `result` フィールドは無し。直前に `[Request interrupted by user]` を本文に持つ `user` メッセージが 1 通入る。
- **`is_error` なので素直に扱うと `failed` になる**が、ユーザーが自分で止めたのだから失敗ではない。
  codiva は `terminal_reason` の**構造**で判定して `interrupted`（resumable）に落とす（`errors[]` は CLI の
  内部診断なので表示しない）。詳細は [ARCHITECTURE.md](./ARCHITECTURE.md)「ユーザーによる中断」。

### 6. acceptEdits でも **`Write` は canUseTool に来る**

- `permissionMode: 'acceptEdits'` でも実測で **`Write` が canUseTool に落ちてきた**（`AskUserQuestion` も当然来る）。「編集系は自動許可」を鵜呑みにできない。
- **codiva 実装方針**: 自律実行のため、codiva の `canUseTool` は Write/Edit/Bash 等のルーチンツールを**自動 allow** し、`AskUserQuestion`（＝ユーザーへの質問）と、将来的に設定する「要確認ツール集合」のみ UI に上げる。`allowedTools` で明示許可する手もあるが、canUseTool 集中管理の方が状態導出と一元化できる。

### reducer が握るべき状態（実測ベースの結論）

- `sdkSessionId`: 最初の `system/init.session_id`（以降変わらない）。
- `todos`: TaskCreate/TaskUpdate から構築（上記1）。`progress = {done, total}`。
- `status`: `system/init`→running、`AskUserQuestion`(canUseTool)→awaiting_input、その他 canUseTool→awaiting_permission、`result/success`→completed、`result/error_*`→failed（ただし `terminal_reason` が `aborted_streaming`＝ユーザーの中断 / 一時的な `api_error` なら `interrupted`、認証切れ・レート制限はそれぞれの状態へ）。
- ログ: `assistant` の text ブロック、tool_use の1行要約、`result.result`。

## プラン / 使用状況の取得（実測 / SDK v0.3.214, Claude Team, 2026-07-30）

Claude Code のステータスラインと同じ「プラン種別 + リミットまでの使用状況」を出すために、
`accountInfo()` と実験的な usage 要求を probe（何も送らない streaming-input セッション）から
読んだ実測結果。**推論は走らないのでトークン消費はゼロ**（実測 1〜2 秒）。

### `Query.accountInfo()` — プラン名の唯一の出所

```jsonc
{ "email": "…", "organization": "THE PHAGE",
  "subscriptionType": "Claude Team", "apiProvider": "firstParty" }
```

- `subscriptionType` は **表示用の文字列**（`'Claude Team'`。usage 側は `'team'` と小文字なので
  `core/account.ts` の `normalizePlanName` で綴りを揃える）。SDK 由来の表示文字列なので翻訳しない。
- `apiProvider` が `'firstParty'` のときだけ claude.ai のサブスク制限が効く（Bedrock / Vertex /
  API キーには無い）。
- **idle な probe でも即答する**（init ハンドシェイクだけで完結。`supportedModels()` と同じ）。

### `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET()` — 枠は来ないことがある

```jsonc
{ "session": { "total_cost_usd": 0, "model_usage": {} },
  "subscription_type": "team",
  "rate_limits_available": true,
  "rate_limits": null,            // ← available=true でも null
  "behaviors": { "day": { … }, "week": { … } } }
```

- **`rate_limits_available: true` でも `rate_limits: null` があり得る**（Team アカウントで3回連続再現）。
  「available」を根拠に枠を描いてはいけない。`core/usage.ts` は null を「枠なし」として扱い、
  `rate_limit_event` 側の情報だけで表示する。
- 枠が来る場合の形は SDK 型宣言のとおり `{ utilization: number|null, resets_at: ISO文字列|null }`。
  **`resets_at` は ISO 8601 文字列**で、`rate_limit_event` の `resetsAt`（Unix 秒）とは単位が違う。
- `behaviors` はローカルの transcript スキャン由来の統計（`/usage` ダイアログと同じ）。codiva は使わない。
- **ターンを回した直後のセッションでは `ProcessTransport is not ready for writing` で失敗した**ので、
  実セッションに相乗りせず専用 probe で読む（`utils/usage-probe.ts`）。

### `rate_limit_event`（実セッション、1ターン実行時の実測）

```jsonc
{ "type": "rate_limit_event",
  "rate_limit_info": { "status": "allowed", "resetsAt": 1785414600, "rateLimitType": "five_hour",
                       "overageStatus": "allowed", "overageResetsAt": 1785542400, "isUsingOverage": false } }
```

- **`system/init` の直後**（assistant 出力より前）に届く = ターン開始ごとに最新化される。
- **`five_hour` には `utilization` が付かないことがある**（このアカウントでは付かなかった。
  `overage` 枠には `utilization: 3.49` が付いた）。つまり「% 使用」は常に取れるとは限らないので、
  UI は `utilization` が無い枠にゲージを描かず残り時間だけ出す（0% と誤読させない）。
- **idle なセッション（何も送っていない probe）には届かない**。だからポーリングと併用する。

## 学習データ利用（grove）の検知（実測 2026-07-30 / Claude Code 2.1.220）

claude.ai の「Help improve our AI models」（モデル学習へのデータ提供。設定画面は
<https://claude.ai/settings/data-privacy-controls>）の ON/OFF を codiva から判定するための実測。
Anthropic 内部の呼び名は **grove**。

### 出所は 2 つ（どちらも `grove_enabled` を運ぶ）

| 出所 | 形 | 備考 |
|---|---|---|
| `~/.claude.json` の `groveConfigCache[<accountUuid>]` | `{ grove_enabled: boolean \| null, timestamp: number }` | Claude Code が取得時に書くキャッシュ。**未取得のアカウントには存在しない**（実測: 本開発機では未生成だった）。`accountUuid` は同ファイルの `oauthAccount.accountUuid` |
| `GET https://api.anthropic.com/api/claude_code_grove` | `{ grove_enabled, domain_excluded, notice_is_grace_period, notice_reminder_frequency }` | Claude Code の `/privacy-settings` が使う非公開エンドポイント。更新は `PATCH /api/oauth/account/settings`（codiva は**読み取りのみ**） |

- `grove_enabled` は `true` / `false` のほか **`null`** がありうる（ポリシーで選択肢が無いアカウント）。
  `null` は「不明」として扱い、警告を出さない。

### 認証と User-Agent（重要）

- 認証は Claude Code の OAuth アクセストークン（`Authorization: Bearer <token>`）。置き場所は
  macOS が **Keychain の generic password `Claude Code-credentials`**（`security find-generic-password
  -s 'Claude Code-credentials' -w` で JSON が取れる。中身は `{ claudeAiOauth: { accessToken, … } }`）、
  それ以外は `~/.claude/.credentials.json`。
- **User-Agent が `claude-cli` で始まらないと 403 `permission_error`**（実測）。

  | User-Agent | 結果 |
  |---|---|
  | `claude-cli/2.1.220 (external, cli)` | 200 |
  | `claude-cli` のみ / `claude-cli/0.0.0 (external, cli)` | 200 |
  | `codiva/0.2.9` / `curl/8.0` / 未指定 | 403 |

  `anthropic-beta` ヘッダは不要（有無で結果は変わらない）。
- 非公開 API なので**いつ壊れてもよい前提**で実装する: 失敗・403・タイムアウトはすべて
  `'unknown'` に丸め、警告を出さない（誤警告を出さない側に倒す）。実装は `utils/privacy.ts`、
  判定は純粋な `core/privacy.ts`。

### 未検証: `domain_excluded`

- 本開発機のアカウントでは `null` だった。Claude Code の設定ダイアログは `domainExcluded` が真のとき
  トグル操作（tab）を無効化する実装になっており、「ドメイン側で対象外」を意味すると読める。
- 意味が確定するまで codiva は **`domain_excluded === true` を `'unknown'` に倒す**（対象外なのに
  「学習に使われます」と警告するのを避ける）。非 null の実データが採れたらここに追記して判定を見直す。

### キャッシュの信頼は非対称にする（実装上の教訓）

- claude.ai の Web 側で設定を変えても `~/.claude.json` の `groveConfigCache` は書き換わらない。
  キャッシュの `'on'` を信用すると、ユーザーが警告に従って OFF にしたあとも最大 7 日間
  警告が出続ける。**`'off'` はキャッシュを採用、`'on'` は必ず API で確認**（確認できなければ据え置き）。

## `gh` による PR ステータス取得（実測 2026-07-31 / gh 2.96.0）

一覧の `#<n>` バッジが「出るときと出ないときがある」原因の調査結果。

### `gh pr view --json mergeable` は GraphQL クォータを食う

- `gh pr view <branch> --json number,url,state,mergeable,isDraft` は REST ではなく **GraphQL API**
  を叩く。GraphQL のレート制限は **5000 ポイント/時**で、REST（`core`, 5000/h）とは別枠。
- 枯れると exit code 1・**stderr** に次を出す（stdout は空）:

  ```
  GraphQL: API rate limit already exceeded for user ID <id>.
  ```

  残量は `gh api rate_limit --jq .resources.graphql` で確認できる（`{"limit":5000,"used":5001,"remaining":0,...}`）。
- このクォータは**同じアカウントの全ツールで共有**で、codiva のポーリングだけでなく
  **セッション内の Claude が実行する `gh`**（PR 作成・レビュー・CI 確認…）も同じ枠を消費する。
  並列セッションを回していると現実に枯れる。

### 失敗と「PR が無い」は文言で区別できる

| 状況 | exit | 文言（stderr） |
|---|---|---|
| PR が無い | 1 | `no pull requests found for branch "<branch>"` |
| レート制限 | 1 | `GraphQL: API rate limit already exceeded …` |
| 未認証 | 4 | `To get started with GitHub CLI, please run: gh auth login` |
| `gh` 未導入 | — | spawn 時 `ENOENT` |

→ `utils/pr.ts` は例外をこの文言で分類し、`found` / `absent` / `unavailable(reason)` を返す。
`unavailable` を `absent` に丸めると、レート制限や一時的な通信断のたびに `setPr(undefined)` が走って
**表示中の `#<n>` が消え、次のポーリングで復活する**（＝「GitHub ステータスが時々出ない」の正体）。

### ポーリングのコストを下げる

- `statusCheckRollup` は PR メタ情報と**同じ 1 回の `pr view`** で取れる。auto-ready 用に別途
  `--json statusCheckRollup` を投げていたのをやめ、1 セッション 1 サイクル = `gh` 1 回にした
  （HEAD ブランチで見つからなかったときだけ記録ブランチへフォールバックの 2 回目）。
- `rate_limit` / `auth` / `cli` を検知したら 5 分ポーリングを止める（`PR_LOOKUP_BACKOFF_MS`）。
  20 秒間隔で叩き続けても回復しないうえ、ユーザーの他ツールの枠まで削る。
- `merged` になった PR と `archived` セッションは以後問い合わせない。サイクルの多重実行も禁止
  （`gh` が 20 秒より遅いと重なる）。

### ポーリングのコストを「セッション数 × 頻度」から切り離す

素朴な実装（全セッション × 20 秒）だと 10 セッションで 1800 リクエスト/時。GraphQL の 5000/時を
Claude セッション自身の `gh` と分け合うので、これだけで枯れる。3 段で切り離した。

1. **PR の識別と状態を分けて、識別はキャッシュし切る**（`PrRef` / `PrStatus`）。番号・URL は
   ブランチに対して不変なので `state.json` に載せ、再起動直後から `#<n>` を出す（状態のグリフは
   最初のポーリングで付く）。状態だけ取れないときも番号は消さない。
2. **セッションごとの陳腐化で叩くかを決める**（`core/pr-refresh.ts`）。20 秒 tick はスケジューラで、
   実際のリクエストはチェック実行中（20 秒）/ マージ可否計算中（60 秒）/ 落ち着いた PR（180 秒）を
   超えたものだけ。`merged` PR と `archived` セッションは永久に対象外。落ち着いた一覧なら
   9 tick に 1 回しか叩かない。
3. **同時に 3 件以上あるときは `gh pr list` 1 回に畳む**（`utils/pr.ts` の `lookupPrs`）。
   `--json headRefName,…` で全 PR を取り、各セッションの HEAD ブランチ（ローカルの
   `git rev-parse`、API 不要）で突き合わせる。10 セッションでもリクエストは 1 回。
   1〜2 件のときは `pr view` の方が安い（list は全件のチェック rollup を運ぶ）ので閾値を置く。
   `--limit` は件数 × 3（30〜100）。list は新しい順なので、セッションの PR（＝最近作ったもの）は
   必ず先頭側に入る。ページが埋まっていた（＝切り詰められた）ときだけ、既知の PR が
   見つからなかったセッションを `pr view` で確認する（「消えた」と誤判定しないため）。

### `gh pr list --json` の実測（gh 2.96.0, 2026-07-31）

`pr list` は **JSON 配列**で、各要素は `pr view` と同じフィールド + `headRefName`。

```json
[{"headRefName":"fix/pr-status-visibility","number":78,"url":"https://github.com/o/r/pull/78",
  "state":"OPEN","mergeable":"MERGEABLE","isDraft":false,
  "statusCheckRollup":[{"__typename":"CheckRun","name":"check","status":"COMPLETED",
                        "conclusion":"SUCCESS","startedAt":"…","completedAt":"…",
                        "workflowName":"CI","detailsUrl":"…"}]}]
```

- rollup の要素は `__typename: 'CheckRun'` のとき **`state` を持たない**（`status` + `conclusion`）。
  レガシーな commit status は `StatusContext` で `state` を持つ。`toChecksState` が両方を読むのは
  このため（片方しか見ないと「チェック無し」に見える）。
- **新しい順**に返る（#78 → #77 の順で観測）。セッションの PR は最近作ったものなので、
  `--limit` で切り詰められても取りこぼさない。
- `state: 'MERGED'` のとき `mergeable` は `UNKNOWN` に落ちる（#77 で観測）。`state` を優先する
  `toMergeStatus` の根拠。

実 API で `lookupPrs` を通した結果（1 回の `pr list` + セッションごとのローカル `git rev-parse`）:

| ケース | 入力 | 結果 |
|---|---|---|
| HEAD にある PR | cwd=この worktree, branch=`codiva/github` | `found` #78 mergeable / passing |
| PR 無し | cwd=main チェックアウト, branch=存在しないブランチ | **`absent`**（`unavailable` ではない） |
| マージ済み | branch=`codiva/task-11` | `found` #77 **merged**（以後ポーリングしない） |

## Codex CLI（`codex exec --json`）の実測（codex-cli 0.144.5, 2026-08-10）

codiva の 2 つ目の provider。**`@openai/codex-sdk` を npm 依存に足さず、ユーザーがインストールした
`codex` を起動する**（`gh` / `git` と同じ扱い。SDK を入れると Codex を使わないユーザーにも
プラットフォーム別バイナリが降る）。実装は `core/codex-*.ts` + `utils/codex.ts`、設計の理由は
[ARCHITECTURE.md](./ARCHITECTURE.md)「エージェント抽象」6 節。

### codiva が組み立てる起動コマンド

`utils/codex.ts` の `codexArgs()`。**シェルは使わず引数配列**（`git` / `gh` と同じ規約）。

```
codex exec --json --skip-git-repo-check
           --sandbox <read-only|workspace-write|danger-full-access>
           -c approval_policy="never"
           [-c sandbox_workspace_write.network_access=<bool>]   # workspace-write のときだけ
           [--model <slug>] [-c model_reasoning_effort="<effort>"]
           [resume <thread_id>]
           -- <prompt>
```

- **`--json` と `--experimental-json` は同じフラグ**（clap の alias。`--help` に出るのは `--json`）。
- **指示文の前に `--` を必ず置く**。ユーザーの入力は任意の文字列なので、`-` で始まると
  clap がオプションとして解釈して起動そのものが落ちる（実測: `codex exec --json "--fix the thing"`
  → `error: unexpected argument '--fix the thing' found`）。`--` 以降は必ず値として扱われ、
  `resume <id> -- <prompt>` の形でも同じに効く（実測で確認済み）。
- `resume` はサブコマンド（`codex exec [OPTIONS] resume <id> <prompt>`）だが、オプションは global
  なので前に置ける。プロンプトは**必ず最後の位置引数**。
- **stdin は `'ignore'` で開く**。プロンプトを引数で渡していても、パイプされた stdin があると
  codex は追加入力として読もうとして `Reading additional input from stdin...` と出したままブロックする。
- **stdout = JSONL、stderr = ログ**（`2026-…Z ERROR codex_login::auth::manager: …` のような tracing 行）。
  失敗の診断は stderr の末尾（codiva は 4000 文字まで保持）。
- 終了コードは実質 **0 か 1 だけ**（正常終了 / 失敗）。細かい理由はコードから区別できないので、
  分類は文言（`turn.failed` の message か stderr）で行う。

### JSONL のイベント union

出所は Codex の `codex-rs/exec/src/exec_events.rs`。codiva の型は `core/codex-events.ts`。

| `type` | 運ぶもの | codiva での扱い |
|---|---|---|
| `thread.started` | `thread_id` | resume の鍵。**resume した回も同じ id が再度届く**（`session_started` は no-op） |
| `turn.started` | なし | `assistant_message`（running へ戻す区切り） |
| `item.started` | `item` | tool_use 相当（コマンド・パッチ・MCP・web 検索・TODO） |
| `item.updated` | `item` | **実測では `todo_list` にしか来ない** |
| `item.completed` | `item` | assistant テキスト / tool_result 相当 |
| `turn.completed` | `usage?` | **ターン完了の唯一の信号**。トークン数のみで **USD は無い** |
| `turn.failed` | `error.message` | **ターン失敗の唯一の信号** |
| `error` | `message` | **終了ではない**（下記）。system 行 1 行にとどめる |

`item` の `type` と状態:

| `item.type` | フィールド | `status` の enum |
|---|---|---|
| `agent_message` | `text` | （なし） |
| `reasoning` | `text`（推論の要約） | （なし） |
| `command_execution` | `command` / `aggregated_output` / `exit_code`（実行中は**明示的に `null`**） | `in_progress` / `completed` / `failed` / `declined` |
| `file_change` | `changes[] = {path, kind: add\|delete\|update}` | `in_progress` / `completed` / `failed` |
| `mcp_tool_call` | `server` / `tool` | `in_progress` / `completed` / `failed` |
| `web_search` | `query` | （なし） |
| `todo_list` | `items[] = {text, completed}`（**真偽値だけ**。`in_progress` が無い） | （なし） |
| `error` | `message` | （なし） |

- `item.id` は CLI が振る通し番号（`item_0`, `item_1` …）で、モデル側の id ではない。
  started ↔ completed の突き合わせに使う。
- コマンド実行は **started → completed の 2 段**で、途中経過（`item.updated`）は来ない。
  進行中の出力は覗けず、`aggregated_output` は completed でまとめて届く。
  そのため `item.updated` を読む価値があるのは `todo_list`（チェックが 1 つずつ埋まる）だけ。
- `todo_list` は `item.completed` でも**直前の `item.updated` と同じリスト**を繰り返す
  （codiva はログ行を増やさない）。
- `CodexUsage.cache_write_input_tokens` は実測で省略されることがある（CLI 側に `serde(default)`）。

### `{"type":"error"}` は終了ではない（再試行の実況）

接続が切れると、次のような行が **stdout の JSONL として**流れ続ける（`__fixtures__/codex-failure.jsonl`）:

```json
{"type":"error","message":"Reconnecting... 1/5 (stream disconnected before completion: …)"}
…
{"type":"error","message":"Reconnecting... 5/5 (stream disconnected before completion: …)"}
{"type":"error","message":"stream disconnected before completion: …"}
{"type":"turn.failed","error":{"message":"stream disconnected before completion: …"}}
```

- 5 回まで自動で粘り、**成功すればそのままターンが続く**。`error` を素直に失敗扱いにすると
  自力で回復するセッションが赤くなる。ターンの終わりを決めてよいのは `turn.failed`（と、
  終端イベント無しの非ゼロ終了）だけ。
- 諦めたときは同じ文言が `error` と `turn.failed` の 2 回届く。codiva は `error` を
  `coalesceKey: 'Reconnecting'` の system 行に畳んで 1 行にまとめ、分類は `turn.failed` で行う。
- 認証切れも同じ形（`error` → `turn.failed` が同文言）で来る（`__fixtures__/codex-auth-error.jsonl`）:
  `Your access token could not be refreshed because your refresh token was already used.
  Please log out and sign in again.` → `classifyCodexError` が `auth` に分類する。

### 承認要求は JSON モードでは上げられない

`codex exec` の JSON モードは、コマンド実行 / パッチ適用 / MCP のいずれの承認要求も
**CLI 内部で自動 reject** し、JSONL には何も出さない（`codex-rs/exec/src/lib.rs` の
`handle_server_request`）。したがって codiva 側に許可要求を UI へ上げる経路は原理的に無く、
`CODEX_CAPABILITIES.permissions = false`。安全弁はサンドボックス（`--sandbox` = 設定
`codexSandbox`）だけになる。`workspace-write` の既定はネットワーク遮断なので、
`-c sandbox_workspace_write.network_access=true`（設定 `codexNetworkAccess`、既定 true）を
明示しないと `npm install` / `gh` が失敗して大半の作業が完了しない。

### プロセスの扱いで踏んだところ（`utils/codex.ts`）

1 ターン = 1 プロセスなので、`spawnCodex` の後始末がそのままセッションの寿命に効く。

- **`codex` は Rust バイナリで、Rust は起動時に `SIGPIPE` を無視する。** stdout を読むのを
  やめてもパイプが壊れて死んでくれない（`EPIPE` の書き込みエラーになるだけ）ので、
  **捨てた run は明示的に `kill()` する**。しないと `codex exec` が worktree を触ったまま
  残る（セッションは `failed` 表示なのに裏で作業が続く）。
- **`SIGTERM` だけに賭けない。** 無視されると stdout が閉じず `for await` が返らないので、
  ターンが二度と進まない。`KILL_ESCALATE_MS` 後に `SIGKILL` へ上げる（タイマーは
  `unref()` して TUI の終了を妨げない）。
- **`'close'` は全 stdio が閉じてから**なので、`'exit'` もフォールバックにする。
  どちらか早い方で終了コードを確定させないと、stderr を掴んだままの子がいるだけで
  ターンが永久に止まる。
- **`child.stderr` に `'error'` リスナを付ける。** listener の無い `'error'` は
  EventEmitter が throw し、TUI ではプロセス死になる（stdout は for-await 中の
  非同期イテレータが面倒を見るので、素の emitter はここだけ）。
- **1 行の長さに上限を置く。** `command_execution` は `aggregated_output` を丸ごと 1 行で
  運ぶので、長いビルドの出力が数十 MB の 1 行になる。溜め切ってから `JSON.parse` すると
  同じものが 2 部ヒープに載るため、`MAX_LINE_CHARS` を超えた行は捨てて次の改行から復帰する
  （枠切りは純粋な `createJsonlSplitter`（`core/codex-events.ts`）に切り出してテストしてある）。
- **stderr のバッファは必ず上限で切る。** 1 チャンクは 64KB になりうるので
  「短ければ足す」だけだとその 1 回で大きく超え、それが `turn_stopped.detail` →
  `state.error` に載る（ログ行と違って `state.error` はクリップされない）。

### `codex debug models` — モデル一覧のローカル取得

- ローカルのモデルカタログを JSON で吐くだけで**推論は走らない**（トークンもコストもゼロ）。
  Claude 側の `Query.supportedModels()` と同じ「モデル名を直書きしない」ための出所。
- 出力は **`base_instructions`（モデルごとのシステムプロンプト全文）を含むため実測 ~280KB**。
  `execFile` の既定 `maxBuffer` では足りないので明示的に広げる（`utils/codex.ts` は 8MB）。
- 読むのは `models[].slug` / `display_name` / `description` / `visibility` だけ。
  **`visibility !== 'list'`（`hide` 等）は内部用**なので選択肢に出さない。
- Codex の slug は `gpt-5.6-sol` のような**実 ID**で、Claude の `sonnet` / `opus` に相当する
  エイリアスが無い。したがって取得に失敗したときのフォールバックは**「デフォルト」1 行だけ**
  （`DEFAULT_ONLY_MODEL_OPTIONS`）。ここに推測でモデル名を並べると必ず陳腐化する。

### フィクスチャの採取: モック Responses API を立てて実バイナリを走らせる

Codex の JSONL には上流に採取済みのフィクスチャが無く、実アカウントで走らせると
（a）課金・レート制限を食う（b）モデルの気分で出るイベントが変わり `command_execution` の
失敗や `turn.failed` を**狙って**出せない。そこで **`codex` バイナリはそのまま、モデル側だけを
差し替える**方法で採取した。`src/core/__fixtures__/codex-*.jsonl` はこれで採った実出力。

1. ローカルに **Responses API 互換のモックサーバ**を立てる（`POST /v1/responses` に SSE で
   決め打ちの応答を返すだけの小さな HTTP サーバ）。モデルの出力を固定できるので、
   シェル実行・パッチ適用・TODO 更新・コマンド失敗・ストリーム切断を**狙って**再現できる
   （切断は応答の途中でソケットを閉じるだけでよい）。
2. `codex` をそのプロバイダに向ける。`-c` は `~/.codex/config.toml` の値を上書きするので、
   設定ファイルを汚さずに 1 回の実行だけ差し替えられる:

   ```bash
   codex exec --json --skip-git-repo-check --sandbox workspace-write \
     -c model_provider="mockprov" \
     -c 'model_providers.mockprov={name="mock",base_url="http://127.0.0.1:<port>/v1",wire_api="responses",requires_openai_auth=false}' \
     -c approval_policy='"never"' \
     "<prompt>"
   ```

   `-c <key>=<value>` の value は **TOML として**解釈される（パースできなければ生文字列）。
   だから文字列は `-c approval_policy='"never"'` のようにクォートを 2 重にする。
3. stdout をそのまま `.jsonl` として保存し、絶対パス等をサニタイズしてから
   `src/core/__fixtures__/` へ昇格させる（Claude 側の spike と同じ運用。
   [testing.md](../.claude/rules/testing.md)）。

> この手法は「CLI の出力形式に依存したパーサを、CLI 本体を差し替えずにテストしたい」場面で
> そのまま再利用できる。上流にフィクスチャが無い provider を足すときの既定手段にする。
