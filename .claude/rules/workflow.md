# 作業の進め方

このリポジトリでの標準手順。**着手前に読む。**

## コマンド

```bash
npm run dev        # tsx で TUI 起動（cwd = codiva 自身になるので動作確認には使わない。下記参照）
npm test           # vitest run --coverage
npm run lint       # biome check .（--write は lint:fix）
npm run typecheck  # tsc --noEmit
npm run build      # tsup → dist/index.js（shebang 付き単一ファイル）
npm run spike -- <basic|followup|interrupt|subagent> [--keep]   # 実 SDK のメッセージ採取
```

CI（`.github/workflows/ci.yml`）は push / PR で `lint → typecheck → test → build` を回す。
**ローカルでも同じ4つを通してから PR を出す。**

## ドキュメントの役割分担

| 置き場所 | 役割 | 更新タイミング |
|---|---|---|
| `CLAUDE.md` | 常時ロードされる索引と地図 | 構成・コマンド・ルールが増えたとき |
| `.claude/rules/*.md` | **不変条件**（守るべき決まり） | 決まりを追加・変更したとき |
| `.claude/skills/*/SKILL.md` | **手順**（複数ファイルにまたがる定型作業） | 定型作業の手順が変わったとき |
| `docs/ARCHITECTURE.md` | レイヤ構成・状態機械・クラス責務・設計判断の理由 | 設計を変えたとき（先に直す） |
| `docs/TECH_NOTES.md` | SDK / Ink / git worktree の技術リファレンスと実測結果 | 実測で分かったことを追記 |
| `docs/PRD.md` | 要件・受け入れシナリオ（歴史的資料寄り） | 要件が変わったとき |
| `docs/TASKS.md` / `docs/REFACTORING.md` | Phase 単位の作業計画と DoD | 進捗に合わせてチェックボックス更新 |
| `docs/RELEASE.md` | npm 配信手順（Trusted Publishing） | 配信フローが変わったとき |
| `README.md` | **利用者向け**の説明（設定・使い方） | ユーザー可視の挙動・設定が変わったとき |

- **ドキュメントと実装が乖離したら、docs/ を先に直してから実装する。**
- Phase 作業（TASKS.md / REFACTORING.md）は Phase 順に進め、**DoD を満たしてから次へ**。
  チェックボックスと実績メモを同じ PR で更新する。

## 実装の流れ

1. **調査**: 既存の似た実装を探す（`core/` の純関数 → `utils/` のラッパ → `ui/` の配線の順に読む）。
   定型作業なら該当 skill を使う（`add-slash-command` / `add-session-status` / `add-config-option` /
   `sdk-spike` / `manual-check`）。
2. **設計確認**: レイヤ違反にならないか（[architecture.md](./architecture.md)）。
   状態が絡むなら [session-domain.md](./session-domain.md)、SDK が絡むなら
   [sdk-integration.md](./sdk-integration.md)。
3. **テスト先行**: コアロジックは TDD。テーブルドリブンで spec を書いてから実装
   （[testing.md](./testing.md)）。
4. **UI 配線**: 文言は必ず ja/en 両方をカタログへ（[i18n.md](./i18n.md)）。キー処理は
   1画面 1 `useInput`（[ink-components.md](./ink-components.md)）。
5. **4点チェック**: lint / typecheck / test / build。
6. **ドキュメント更新**: 下のチェックリスト。
7. **コミット**: conventional commits（`feat:` / `fix:` / `refactor:` / `test:` / `chore:` / `docs:` /
   `perf:` / `ci:`）。日本語の要約で書く（既存履歴に合わせる）。

## 変更時に一緒に更新するもの（漏れやすい順）

- [ ] `core/i18n.ts` の **ja と en 両方**（片方だけ足すと型エラー / `i18n.spec.ts` で落ちる）
- [ ] 対応する co-located `*.spec.ts` と、必要なら `tests/*.test.tsx`
- [ ] `docs/ARCHITECTURE.md`（責務・状態機械を変えたとき）
- [ ] `README.md`（ユーザー可視の設定・キー操作・コマンドを変えたとき）
- [ ] `docs/TASKS.md` のチェックボックス / 実績メモ

## 動作確認

- **`npm run dev` は codiva 自身のリポジトリを対象にしてしまう**ので手動確認には使わない。
  `/tmp` などに `git init` + 初期コミットした使い捨てリポジトリを作り、そこで
  `npm run build` 済みの `node <codiva>/dist/index.js` を起動する（skill `manual-check`）。
- 実セッションには TTY と Claude の認証（`claude` CLI ログイン済み、または `ANTHROPIC_API_KEY`）が必要。
  非対話のエージェントセッションでは実行できないので、**配線は統合テストで検証し、体感確認は
  ユーザーに依頼する**（過去 Phase も同じ運用。TASKS.md の実績メモ参照）。

## やらないこと（non-goals）

- モノレポ化 / パッケージマネージャ変更（**npm 固定**）/ ビルド構成変更（**tsup + bundler resolution 固定**）
- `nodenext` + `.js` 拡張子付き import へ戻すこと、pnpm へ戻すこと
- ESLint / Prettier の導入（**Biome 固定**）
- `<Static>` の再導入、Ink 以外の UI フレームワークへの移行
- マージ競合の自動解消、破壊的操作の無確認実行
