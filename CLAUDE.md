# codiva

対象Gitリポジトリで起動し、指示ごとに独立した git worktree 上で Claude Code セッション（Claude Agent SDK）を並列実行する TUI アプリ。TypeScript (ESM, strict) + Ink 7 + npm。

## コマンド

```bash
npm run dev        # tsx で TUI 起動（cwd が codiva 自身になる。手動確認には使わない → skill manual-check）
npm test           # vitest（coverage 付き、core/ と utils/ は 80% 必須）
npm run lint       # biome check（--write は lint:fix）
npm run typecheck  # tsc --noEmit（型チェックのみ）
npm run build      # tsup → dist/index.js（起動シム）+ dist/main-<hash>.js（本体）
npm run spike -- <basic|followup|interrupt|subagent>   # 実 SDK のメッセージ採取
```

CI（`.github/workflows/ci.yml`）は `lint → typecheck → test → build`。同じ4つを通してから PR。

## 規約（.claude/rules/）

**常時ロード**（下の @ で自動読込。全作業で守る）:

@.claude/rules/architecture.md
@.claude/rules/coding-rules.md
@.claude/rules/ink-components.md
@.claude/rules/i18n.md

**該当作業のときに読む**（コンテキスト節約のため自動読込しない）:

| ファイル | 読むタイミング |
|---------|--------------|
| `.claude/rules/workflow.md` | 着手前（手順・ドキュメントの役割分担・non-goals） |
| `.claude/rules/session-domain.md` | セッションの状態・遷移・永続化に触るとき |
| `.claude/rules/sdk-integration.md` | エージェント抽象・Agent SDK（agent-ports / claude-* / session / model catalog）に触るとき |
| `.claude/rules/git-and-io.md` | worktree・マージ・PR・ファイル入出力に触るとき |
| `.claude/rules/testing.md` | テストを書くとき |

## 定型作業は skill を使う（.claude/skills/）

| skill | 用途 |
|-------|------|
| `add-slash-command` | スラッシュコマンド（`/model` 等）の追加・変更 |
| `add-session-status` | `SessionStatus` の追加（9ファイル波及の順序） |
| `add-config-option` | `~/.codiva/config.json` の設定項目の追加 |
| `sdk-spike` | SDK 実メッセージの採取 → フィクスチャ昇格 |
| `manual-check` | 使い捨てリポジトリでの手動動作確認 |

## 設計ドキュメント（docs/）

| ファイル | 内容 |
|---------|------|
| `docs/ARCHITECTURE.md` | レイヤ構成・状態機械・クラス責務・**設計判断の理由** |
| `docs/TECH_NOTES.md` | Agent SDK / Ink / git worktree の技術リファレンスと**実測結果** |
| `docs/PRD.md` | 要件・受け入れシナリオ（歴史的資料寄り） |
| `docs/TASKS.md` / `docs/REFACTORING.md` | Phase 単位の作業計画と DoD（**Phase 順に進める**） |
| `docs/RELEASE.md` | npm 配信（Trusted Publishing）の手順 |

## コードの地図（やりたいこと → 触る場所）

| やりたいこと | 主なファイル |
|---|---|
| セッションの状態・遷移 | `core/types.ts`（union）/ `core/status-meta.ts`（性質の表）/ `core/status-reducer.ts`（純粋 reducer） |
| 別のエージェント（Codex / Grok）に対応させる | `core/agent-ports.ts`（`AgentAdapter` / `AgentCapabilities` / `PermissionDecision` = DI 境界）/ `core/agent-events.ts`（`AgentEvent` の語彙 + 全 provider 共通の畳み込み `applyAgentEvent`）/ `core/claude-adapter.ts`・`core/claude-parse.ts`・`core/claude-errors.ts`（Claude 実装の 3 点セット）/ `core/codex-adapter.ts`・`core/codex-parse.ts`・`core/codex-errors.ts` + `core/codex-events.ts`（JSONL の型）・`core/codex-models.ts`・`utils/codex.ts`（`codex exec` の起動 = 唯一の I/O）/ アダプタの登録は `bootstrap/build-manager.ts` の `buildAgents` |
| SDK メッセージの解釈 | `core/claude-parse.ts` **のみ**（`parseClaudeMessage`: SDKMessage → `AgentEvent[]`）+ `core/__fixtures__/*.jsonl`。Codex は `core/codex-parse.ts`（`parseCodexEvent`: `codex exec --json` の JSONL → `AgentEvent[]`）+ `core/__fixtures__/codex-*.jsonl` |
| エージェントの切替（`/agent`）| `core/session-manager.ts`（一覧=既定: `getDefaultAgentId` / `setDefaultAgent`・詳細=切替: `listAgents` / `getSessionAgent` / `setSessionAgent`）/ `ui/agent-select.tsx`（`mode:'default'`=一覧 / `'session'`=詳細）/ `core/status-reducer.ts` の `agent_switched` |
| エージェントの導入・ログイン検出 | `core/agent-ports.ts` の `AgentAdapter.checkAvailability` / `AgentAvailability` / `core/agent-availability.ts`（`resolveDefaultAgentId` / `noAgentInstalled`・純粋）/ `utils/claude.ts` の `detectClaudeAvailability`・`utils/codex.ts` の `detectCodexAvailability`（実 I/O）/ `SessionManager.checkAgents`（集約・キャッシュ）/ `ui/hooks.ts` の `useAgentAvailability` |
| セッションへ渡す systemPrompt | `core/system-prompt.ts`（worktree の共有 symlink 注意書き + `.codiva/prompt.md` の合成） |
| セッションのライフサイクル | `core/session.ts`（1 エージェントストリーム。`setAgent()` で途中切替）/ `core/session-manager.ts`（ファサード）/ `session-store.ts` / `session-actions.ts` / `pr-coordinator.ts` / `run-mode.ts` / `session-ports.ts`（DI seam） |
| worktree・マージ・破棄 | `utils/worktree-manager.ts`（I/O）/ `core/worktree.ts`（型・純関数）/ `core/session-actions.ts` |
| PR 自動化 | `core/pr-coordinator.ts` / `utils/pr.ts`（`gh` はここだけ） |
| 1 セッション複数 PR（`#12 +2`） | `core/pr-detect.ts`（検知・表示ヘルパ・純粋）/ `core/agent-events.ts`（`gh pr create` の tool_use ↔ tool_result 対応。検知は provider 共通）/ `core/claude-parse.ts`（Claude のツール名判定）/ `ui/pr-cell.tsx`（`PrCell` / `PrSummary`） |
| 詰まった PR の立て直し | `core/pr-recovery.ts`（判定・指示文・純粋）/ `SessionManager.recover()` / `utils/worktree-manager.ts` の `syncBase`（ベース取り込み）/ `ui/hooks.ts` の `useRecovery` |
| 一覧画面 | `ui/session-list.tsx`（composer / list の2フォーカス） |
| 詳細画面 | `ui/session-detail.tsx`（ログ + 追加指示 + 操作パネル） |
| 表示幅・グラフェム | `core/graphemes.ts`（共有の分割器。折り返し・幅・クリック逆算で**同じ単位**を使う） |
| 入力欄・キー処理 | `ui/composer.tsx`（**全入力欄の共通実装**。`useComposer` + `<Composer>`）/ `core/text-buffer.ts`（純粋モデル）/ `core/composer-layout.ts`（折り返し・表示行の幾何）/ `core/input-history.ts`（↑↓ の入力履歴）/ `ui/input.ts`（キー→操作）/ `ui/prompt-input.tsx`（描画のみ） |
| ログ描画・スクロール | `core/scroll.ts`（`logLines` は**エントリ単位でメモ化**）/ `core/markdown.ts` / `core/ansi.ts` / `ui/log-line.tsx`（1 行の描画） |
| ログの上限・メモリ | `core/log-buffer.ts`（件数/文字数の上限・`pushLogEntry` が唯一の追記経路） |
| マウス・範囲選択 | `core/mouse.ts` / `core/list-hit.ts` / `core/text-selection.ts` / `core/log-selection.ts`（詳細ログの選択・端の自動スクロール） / `utils/mouse.ts` / `utils/clipboard.ts` |
| ログ内 URL のクリック | `core/url.ts`（検出・範囲・OSC 8・純粋）/ `core/log-selection.ts` の `logLinkAt`（当たり判定）/ `utils/open-url.ts`（ブラウザ起動） |
| 文言・言語 | `core/i18n.ts`（カタログ）/ `ui/i18n-context.tsx`（`useMessages`） |
| 色・記号 | `ui/theme.ts`（`.tsx` に生 ANSI 名を書かない） |
| スラッシュコマンド | `core/commands.ts`（レジストリ）/ `ui/command-palette.tsx` / `ui/hooks.ts` の `useCommandRunner` |
| 設定 | `core/config.ts`（検証）/ `utils/config.ts`（`~/.codiva/config.json`） |
| 永続・復元 | `core/persistence.ts` / `utils/state-store.ts`（`.codiva/state.json`）/ `core/transcript.ts` + `utils/transcript.ts`（CLI トランスクリプト） |
| 通知 | `core/notify.ts`（判定・純粋）/ `utils/notify.ts`（OS I/O） |
| 学習データ利用の警告 | `core/privacy.ts`（判定・純粋）/ `utils/privacy.ts`（キャッシュ+非公開 API）/ `ui/banner.tsx` |
| モデル選択 | `core/models.ts` / `utils/model-catalog.ts`（Claude）/ `core/codex-models.ts` + `utils/codex.ts` の `fetchCodexModelCatalog`（Codex）/ `ui/model-select.tsx` |
| 選択肢リストの表示（質問・モデル） | `core/choice-lines.ts`（折返し + クリック逆算 `choiceRowHeights`/`choiceIndexAtRow`・純粋）/ `ui/choice-row.tsx`（1件の描画） |
| アップデート通知・`/update` | `core/update.ts`（比較・判定・DI 境界）/ `utils/update.ts`（registry fetch・経路判定・`npm install`）/ `ui/update-dialog.tsx` |
| 起動・副作用の配線 | `src/index.tsx`（**起動シム**。NODE_ENV を立てて `./main` を動的 import するだけ。static import を足さない）/ `src/main.tsx`（直列の main）/ `src/bootstrap/*`（build-manager / restore-sessions / persist-controller / crash-handler / runtime / perf-timeline） |
| クラッシュ時の後始末・原因調査 | `core/crash.ts`（レポート整形・純粋）/ `utils/crash-log.ts`（`~/.codiva/logs/`・同期書き込み・診断レポート）/ `bootstrap/crash-handler.ts`（配線）/ `core/cli.ts` + `utils/terminal-mode.ts` の `resetTerminalModes`（`--reset-terminal`） |
| 共有 UI フック | `ui/hooks.ts`（`useSessions` / `useCommandRunner` / `useLifecycleAction` / `useTextBufferRef` / `useComposerSelection` …） |

> 落とし穴: `config.ts` / `notify.ts` / `mouse.ts` / `transcript.ts` / `repo-prompt.ts` / `privacy.ts` / `worktree*.ts` は
> **core と utils に同名で存在する**（純粋版と I/O 版）。import 元が `@/core` か `@/utils` かを必ず確認する。

## 絶対に崩さない不変条件

1. **依存は一方向**（`ui → core ← utils`）。`core/` は Ink / React / node の I/O を import しない。
2. **状態遷移は 2 本の純関数だけ**（`reduce` = codiva 起点の `CodivaEvent` / `applyAgentEvent` =
   エージェント起点の `AgentEvent`）。`SessionStore` に status を手書きしない。状態の性質は `STATUS_META` が唯一の表。
3. **エージェント固有の知識はアダプタに閉じる**。`core/` の中立モジュールは
   `@anthropic-ai/claude-agent-sdk` を import しない — 触ってよいのは `claude-adapter.ts` /
   `claude-parse.ts` / `claude-errors.ts` だけ（Codex 側の対は `codex-adapter.ts` /
   `codex-parse.ts` / `codex-errors.ts` で、`codex` CLI の形の知識はそこにしか置かない）。
   provider のストリームは
   `AgentEvent`（`core/agent-events.ts`）へ写してから畳み込む（`applyAgentEvent` が唯一の畳み込み）。
   形は想定で書かず、spike の実データでテストする。
4. **UI 文字列はカタログのみ**（`core/i18n.ts` に ja / en 対で追加。例外は SDK 由来のモデル名と
   エージェント名・CLI コマンド名 = 固有名詞。差し込みは `AgentLabel`）。
5. **1画面 1 `useInput`**（モーダルは委譲）。色・記号は `theme.ts` 経由。
6. **git は `utils/git.ts` の `git(cwd, args)`**（execFile + 引数配列。シェル禁止）。**マージ競合は自動解消しない。**
7. **`any` / default export 禁止**、import は**拡張子なし**（`@/core`）、ファイル名は kebab-case。
8. **worktree を勝手に消さない**。終了は `stop()`（quiet）で resumable なまま保存する。
9. **ログは上限付き**。追記は `core/log-buffer.ts` の `pushLogEntry` だけを通す（`[...messages, entry]`
   を新しく書かない）。無制限に伸びる配列 + 更新ごとの全ログ再パースで**実際にヒープ枯渇で落ちた**。
10. **描画ごとに永久保持されるものを増やさない**。`src/index.tsx`（起動シム）に static import を
   足さない（react が dev ビルドになり `performance.measure()` が毎レンダー積まれる）。
   毎フレーム変わる文字列は表示幅に切ってから `<Text>` へ渡す（Ink の上限なしキャッシュ）。
   どちらも**実際にヒープ枯渇で落ちた**（詳細は docs/ARCHITECTURE.md「React の dev ビルドと
   ヒープ枯渇」）。

## ビルド/モジュール構成（変えない）

- `moduleResolution: "bundler"` / `module: "ESNext"`。**import は拡張子なし**（`.js` は付けない）。
- ビルドは **tsup**（esbuild）。出力は `dist/index.js`（起動シム）+ `dist/main-<hash>.js`（本体）の
  2 ファイルで、`splitting: true` が必須（畳むと static import が巻き上げられ、`NODE_ENV` の代入より
  先に react-reconciler が評価されて dev ビルドになる = ヒープ枯渇の再発）。型チェックは `tsc --noEmit`。
- パッケージマネージャは **npm**。lint/format は **Biome**（ESLint/Prettier は使わない）。
- **nodenext + `.js` 拡張子や pnpm には戻さない。**

## 進め方のルール

- コアロジックは TDD（テスト先行）。純関数はテーブルドリブン。
- SDK メッセージの形を想定で書かず、`src/core/__fixtures__/` の実データでテストする。
- ドキュメントと実装が乖離したら、**docs/ を先に直してから**進める。
- `docs/TASKS.md` のチェックボックスを進捗に合わせて更新する。
- コミットは conventional commits（`feat:` / `fix:` / `refactor:` / `test:` / `chore:` / `docs:`）。
- 詳細は [.claude/rules/workflow.md](.claude/rules/workflow.md)。

## 動作確認の前提

- 手動確認は `/tmp` 等に作った使い捨てリポジトリで、**ビルド済みの `node <codiva>/dist/index.js`** を起動する
  （`npm run dev` は codiva 自身が対象になる）。手順は skill `manual-check`。
- 実セッションには TTY と Claude の認証（`claude` CLI ログイン済み）が必要。非対話セッションでは
  統合テストで配線を検証し、体感確認はユーザーに依頼する。
