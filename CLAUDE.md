# codiva

対象Gitリポジトリで起動し、指示ごとに独立した git worktree 上で Claude Code セッション（Claude Agent SDK）を並列実行する TUI アプリ。TypeScript (ESM, strict) + Ink 7 + npm。

## ドキュメント（実装前に必読）

| ファイル | 内容 |
|---------|------|
| `docs/PRD.md` | 要件・受け入れシナリオ |
| `docs/ARCHITECTURE.md` | レイヤ構成・状態機械・クラス責務・設計判断 |
| `docs/TECH_NOTES.md` | Agent SDK / Ink / git worktree の技術リファレンスとスパイク検証項目 |
| `docs/TASKS.md` | **作業はこのファイルの Phase 順に進める**。DoD を満たしてから次の Phase へ |

## コマンド

```bash
npm run dev        # tsx で TUI 起動（開発）
npm test           # vitest（coverage 付き、core/ と utils/ は 80% 必須）
npm run lint       # biome check
npm run typecheck  # tsc --noEmit（型チェックのみ）
npm run build      # tsup で dist/index.js に単一ファイルバンドル
npm run spike      # scripts/spike.ts（Phase 1 の SDK 挙動検証）
```

## コーディング規約（.claude/rules/）

以下は自動で読み込まれる。詳細は各ファイル参照。

@.claude/rules/architecture.md
@.claude/rules/coding-rules.md
@.claude/rules/ink-components.md
@.claude/rules/i18n.md

## ビルド/モジュール構成（重要）

- `moduleResolution: "bundler"` / `module: "ESNext"`。**import は拡張子なし**（`@/core`、`./app`）。`.js` は付けない。
- ビルドは **tsup**（esbuild、単一ファイルバンドル）。型チェックは `tsc --noEmit`。
- パッケージマネージャは **npm**。lint/format は **Biome**（ESLint/Prettier は使わない）。
- バンドラ前提の構成（npm + tsup + bundler resolution + kebab-case + `@/` エイリアス + バレル）で統一。**nodenext + `.js` 拡張子や pnpm には戻さない**。

## 進め方のルール

- **Phase 1 のスパイクを飛ばさない**。SDK メッセージの形を想定で書かず、収集した実データ（tests/fixtures/）でテストする。
- コアロジックは TDD（テスト先行）。
- ドキュメントと実装が乖離したら、docs/ を先に直してから進める。
- TASKS.md のチェックボックスを進捗に合わせて更新する。
- コミットは conventional commits（`feat:` / `fix:` / `refactor:` / `test:` / `chore:` / `docs:`）。

## 動作確認の前提

- 手動確認にはサンプル対象リポジトリが必要。`/tmp` 等に `git init` + 初期コミットした使い捨てリポジトリを作って使う（このリポジトリ自体を対象にしない）。
- セッション実行には Claude の認証が必要（`claude` CLI ログイン済み）。
