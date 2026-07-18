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
//   close(): Promise<void>
```

- **streaming input mode**（prompt に AsyncIterable を渡す）でのみ、追加メッセージ投入・interrupt・setPermissionMode が使える。エラー result 後もストリームが生き続ける。codiva は必ずこのモードを使う。
- string prompt の単発モードはエラー時に throw して終わるため使わない。

### codiva が使う Options

```typescript
const options = {
  cwd: worktreePath,             // ツールの作業ディレクトリ = セッションの worktree
  permissionMode: 'acceptEdits', // 既定。設定 permissionMode で上書き可
  canUseTool,                    // 下記参照
  abortController,               // セッション強制終了用
  maxTurns: 200,                 // 暴走防止の上限（要調整）
  settingSources: ['project'],   // 対象リポジトリの CLAUDE.md / settings を読ませる
  // Phase 6 で公開済み（設定ファイル ~/.codiva/config.json 由来、SessionOptions 経由で注入）:
  model, effort, maxBudgetUsd,   // それぞれ存在時のみ付与
  resume: sdkSessionId,          // 復元時のみ付与。前回セッションの履歴をロードして継続
};
```

**Phase 6 実装メモ（Options 関連）**:
- `model` (`string`) / `effort` (`'low'|'medium'|'high'|'xhigh'|'max'`) / `permissionMode`
  (`'default'|'acceptEdits'|'bypassPermissions'|'plan'|'dontAsk'|'auto'`) / `maxBudgetUsd` (`number>0`) は
  `~/.codiva/config.json` から読み、`core/config.ts` の `toConfig()` で検証。`SessionOptions` に束ねて注入。
- `resume` は復元セッションの最初の追加指示で付与（遅延 resume）。`sdkSessionId` は `system/init.session_id`。
- 復元では会話ログを永続しない（resume が SDK 側で履歴を持つ）。詳細は ARCHITECTURE.md「Phase 6 機能」。

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

`includePartialMessages: true` にすると `{ type: 'stream_event', event }` で生のストリーミングデルタが届く。MVP では使わない（再描画コスト増）。詳細ビューのタイピング風表示を入れたくなったら検討。

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

## Ink 7 の実装メモ

- Ink 7 は React 19 前提。コンポーネントは通常の React。`render(<App/>)` で起動。
- **全画面（100dvh 相当）**: Ink はコンテンツの高さぶんしか描画しないインラインレンダラ。root Box に `useWindowSize()` の rows を `height` 指定すると Ink 7 がフルスクリーンフレームとして扱う（末尾改行なし・インクリメンタル消去。ただしフレームが端末高さを**超える**と全画面クリアにフォールバックしてちらつくので、root に `overflow="hidden"` を付けて超過を防ぐ）。端末が極端に低い（`MIN_FULLSCREEN_ROWS` 未満）ときは height 固定をやめてインライン描画へフォールバックする — クリップで入力欄・フッタが消えて操作不能になるより、端末スクロールに任せる方が安全。
- **`<Static>` は全画面レイアウトと両立しない**: Static はスクロールバック側に書き出すため、フレームが画面いっぱいだとビューポート外に消える。メッセージログは末尾ビューポート（flexGrow + `justifyContent="flex-end"` + `overflowY="hidden"`）+ `tailMessages(messages, rows)`（`core/layout.ts`）で再描画コストに上限を掛ける方式に変更した。
- **`useInput`**: グローバルキーハンドラ。フォーカス管理は `useFocus` もあるが、MVP はビュー単位の単純な状態分岐で足りる。
- **`useApp().exit()`**: 終了。終了前に SessionManager.dispose()（全 abort）を呼ぶ。
- 再描画スロットリング: コアからの onChange を UI 側で ~100ms デバウンス。`useSyncExternalStore` の getSnapshot が返す参照が変わらなければ再描画されない点を利用する。
- **alt screen（代替スクリーンバッファ）**: 全画面レイアウトでも通常バッファのままだとシェルの過去出力がスクロールバックに残り、上へスクロールできてしまう。起動時に `\x1b[?1049h` で alt screen に入り、終了時に `\x1b[?1049l` で抜ける（`utils/alt-screen.ts`）。alt screen にはスクロールバックが存在しないため vim / htop と同様にスクロールがロックされ、終了すると元の画面が復元される。enter するのは「TTY かつ起動時の rows が `MIN_FULLSCREEN_ROWS` 以上」のときだけ（インライン描画フォールバック時はスクロールバックに頼るため通常バッファのまま）。終了時の残存 worktree 案内は leave 後に書き、通常バッファに残す。クラッシュ時の取り残し防止に `process.on('exit')` で leave を保険登録する。

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
- `.git/info/exclude` への追記は `# codiva` マーカー行で冪等にする。
- git 実行は必ず `execFile`（シェル経由禁止。slug はサニタイズ済みだが多層防御）。

## テスト戦略

- `core/` は SDK 非依存でテストする: `Session` に `queryFn` を DI し、テストでは「SDKMessage の配列を順に yield し、canUseTool を任意タイミングで発火させる」フェイクを注入。
- **テスト配置**: 単体テストは実装の隣に co-located `*.spec.ts`（`src/core/slug.spec.ts` 等）。App 全体を通す機能/統合テストは `tests/*.test.ts`。vitest の include は `src/**/*.spec.{ts,tsx}` と `tests/**/*.test.{ts,tsx}` の両方。coverage は `**/*.spec.*` と `**/__fixtures__/**` を除外。
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

`scripts/spike.ts` を basic / followup / interrupt の3シナリオで実行。実メッセージは `tests/fixtures/session-{basic,followup,interrupt}.jsonl` に保存済み（reducer テストの正データ）。以下は実測結論。**想定と違った点を太字にした。**

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

### 6. acceptEdits でも **`Write` は canUseTool に来る**

- `permissionMode: 'acceptEdits'` でも実測で **`Write` が canUseTool に落ちてきた**（`AskUserQuestion` も当然来る）。「編集系は自動許可」を鵜呑みにできない。
- **codiva 実装方針**: 自律実行のため、codiva の `canUseTool` は Write/Edit/Bash 等のルーチンツールを**自動 allow** し、`AskUserQuestion`（＝ユーザーへの質問）と、将来的に設定する「要確認ツール集合」のみ UI に上げる。`allowedTools` で明示許可する手もあるが、canUseTool 集中管理の方が状態導出と一元化できる。

### reducer が握るべき状態（実測ベースの結論）

- `sdkSessionId`: 最初の `system/init.session_id`（以降変わらない）。
- `todos`: TaskCreate/TaskUpdate から構築（上記1）。`progress = {done, total}`。
- `status`: `system/init`→running、`AskUserQuestion`(canUseTool)→awaiting_input、その他 canUseTool→awaiting_permission、`result/success`→completed、`result/error_*`→failed。
- ログ: `assistant` の text ブロック、tool_use の1行要約、`result.result`。
