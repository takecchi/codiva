# codiva

対象Gitリポジトリで起動し、指示ごとに独立した git worktree 上で Claude Code セッション（Claude Agent SDK）を並列実行する TUI アプリ。TypeScript (ESM, strict) + Ink 7 + npm。

## コマンド

```bash
npm run dev        # tsx で TUI 起動（cwd が codiva 自身になる。手動確認には使わない → skill manual-check）
npm test           # vitest（coverage 付き、core/ と utils/ は 80% 必須）
npm run lint       # biome check（--write は lint:fix）
npm run typecheck  # tsc --noEmit（型チェックのみ）
npm run build      # tsup で dist/index.js に単一ファイルバンドル
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
| `.claude/rules/sdk-integration.md` | Agent SDK（session / sdk-parse / model catalog）に触るとき |
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
| SDK メッセージの解釈 | `core/sdk-parse.ts` **のみ** + `core/__fixtures__/*.jsonl` |
| セッションのライフサイクル | `core/session.ts`（1 query）/ `core/session-manager.ts`（ファサード）/ `session-store.ts` / `session-actions.ts` / `pr-coordinator.ts` / `run-mode.ts` / `session-ports.ts`（DI seam） |
| worktree・マージ・破棄 | `utils/worktree-manager.ts`（I/O）/ `core/worktree.ts`（型・純関数）/ `core/session-actions.ts` |
| PR 自動化 | `core/pr-coordinator.ts` / `utils/pr.ts`（`gh` はここだけ） |
| 一覧画面 | `ui/session-list.tsx`（composer / list の2フォーカス） |
| 詳細画面 | `ui/session-detail.tsx`（ログ + 追加指示 + 操作パネル） |
| 入力欄・キー処理 | `core/text-buffer.ts`（純粋モデル）/ `ui/input.ts`（キー→操作）/ `ui/prompt-input.tsx` |
| ログ描画・スクロール | `core/scroll.ts` / `core/markdown.ts` / `core/ansi.ts` |
| マウス・範囲選択 | `core/mouse.ts` / `core/list-hit.ts` / `core/text-selection.ts` / `utils/mouse.ts` / `utils/clipboard.ts` |
| 文言・言語 | `core/i18n.ts`（カタログ）/ `ui/i18n-context.tsx`（`useMessages`） |
| 色・記号 | `ui/theme.ts`（`.tsx` に生 ANSI 名を書かない） |
| スラッシュコマンド | `core/commands.ts`（レジストリ）/ `ui/command-palette.tsx` / `ui/hooks.ts` の `useCommandRunner` |
| 設定 | `core/config.ts`（検証）/ `utils/config.ts`（`~/.codiva/config.json`） |
| 永続・復元 | `core/persistence.ts` / `utils/state-store.ts`（`.codiva/state.json`）/ `core/transcript.ts` + `utils/transcript.ts`（CLI トランスクリプト） |
| 通知 | `core/notify.ts`（判定・純粋）/ `utils/notify.ts`（OS I/O） |
| 学習データ利用の警告 | `core/privacy.ts`（判定・純粋）/ `utils/privacy.ts`（キャッシュ+非公開 API）/ `ui/banner.tsx` |
| モデル選択 | `core/models.ts` / `utils/model-catalog.ts` / `ui/model-select.tsx` |
| アップデート通知・`/update` | `core/update.ts`（比較・判定・DI 境界）/ `utils/update.ts`（registry fetch・経路判定・`npm install`）/ `ui/update-dialog.tsx` |
| 起動・副作用の配線 | `src/index.tsx`（直列の main）/ `src/bootstrap/*`（build-manager / restore-sessions / persist-controller / runtime） |
| 共有 UI フック | `ui/hooks.ts`（`useSessions` / `useCommandRunner` / `useLifecycleAction` / `useTextBufferRef` / `useComposerSelection` …） |

> 落とし穴: `config.ts` / `notify.ts` / `mouse.ts` / `transcript.ts` / `repo-prompt.ts` / `privacy.ts` / `worktree*.ts` は
> **core と utils に同名で存在する**（純粋版と I/O 版）。import 元が `@/core` か `@/utils` かを必ず確認する。

## 絶対に崩さない不変条件

1. **依存は一方向**（`ui → core ← utils`）。`core/` は Ink / React / node の I/O を import しない。
2. **状態遷移は reducer 経由だけ**。`SessionStore` に status を手書きしない。状態の性質は `STATUS_META` が唯一の表。
3. **SDK の形を知るのは `core/sdk-parse.ts` だけ**。形は想定で書かず、spike の実データでテストする。
4. **UI 文字列はカタログのみ**（`core/i18n.ts` に ja / en 対で追加。例外は SDK 由来のモデル名）。
5. **1画面 1 `useInput`**（モーダルは委譲）。色・記号は `theme.ts` 経由。
6. **git は `utils/git.ts` の `git(cwd, args)`**（execFile + 引数配列。シェル禁止）。**マージ競合は自動解消しない。**
7. **`any` / default export 禁止**、import は**拡張子なし**（`@/core`）、ファイル名は kebab-case。
8. **worktree を勝手に消さない**。終了は `stop()`（quiet）で resumable なまま保存する。

## ビルド/モジュール構成（変えない）

- `moduleResolution: "bundler"` / `module: "ESNext"`。**import は拡張子なし**（`.js` は付けない）。
- ビルドは **tsup**（esbuild、単一ファイル）。型チェックは `tsc --noEmit`。
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
