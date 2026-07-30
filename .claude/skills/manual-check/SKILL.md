---
name: manual-check
description: codiva を実際に起動して手動確認するときの手順。使い捨ての対象リポジトリの作り方、正しい起動コマンド（npm run dev は使えない理由）、TTY と認証の前提、確認すべき観点、後片付け。「動作確認したい」「実際に動かして見たい」「起動して試して」と言われたときに使う。
---

# 手動で動作確認する

## まず前提を確認（できないなら早めに伝える）

- codiva は **TTY が必要**な全画面 TUI で、セッション実行には **Claude の認証**
  （`claude` CLI ログイン済み / `ANTHROPIC_API_KEY`）が必要。
- **非対話のエージェントセッションからは実質操作できない。** その場合は
  1. 配線を `tests/*.test.tsx`（`ink-testing-library` + `renderFullscreen`）で検証し、
  2. 体感確認は手順を添えてユーザーに依頼する。
  過去の Phase も同じ運用（`docs/TASKS.md` の実績メモ参照）。無理に起動して固まらせない。

## 使い捨ての対象リポジトリを作る

**codiva 自身のリポジトリを対象にしない**（worktree とブランチが自分の作業ツリーに増える）。

```bash
mkdir -p /tmp/codiva-sample && cd /tmp/codiva-sample
git init -b main
printf '# sample\n' > README.md
git add . && git commit -m "init"     # コミット 0 だと preflight で弾かれる
```

## 起動する

```bash
# codiva 側でビルド（dist/index.js に単一ファイル出力）
cd <codiva>
npm run build

# 対象リポジトリのルートで起動
cd /tmp/codiva-sample
node <codiva>/dist/index.js
```

- **`npm run dev` は cwd が codiva 自身になる**ので手動確認には使わない（開発中の即時起動用）。
- 英語 UI の確認は `CODIVA_LANG=en node <codiva>/dist/index.js`。
- 低い端末でのインライン描画フォールバックは、ウィンドウを `MIN_FULLSCREEN_ROWS` 未満に
  縮めて確認する。

> 注意: `/model` などの設定変更は**ユーザーの実ファイル `~/.codiva/config.json` に書き込む**。
> 事前にバックアップするか、変更したら戻す。

## 見るべき観点

- 起動: バナー・入力欄・フッタ（`⏵⏵ auto mode on`）が端末の縦幅いっぱいに出る / スクロールバックが
  上に残らない（alt screen）。
- 投入: 指示 → 即座に次の入力ができる（ノンブロッキング）→ 一覧の進捗が更新される。
- フォーカス: Tab で composer ⇄ list、list で ↑↓ / Enter（詳細）/ m・d（マージ・破棄）/ r（再開）/ p（PR）。
- 詳細: ログのスクロール（PgUp/PgDn・↑↓・ホイール）で**行が虫食いにならない**、追加指示が送れる。
- 日本語入力: IME の変換中文字列が入力欄のキャレット位置に見える（Ghostty で特に確認）。
- コンポーザ上のドラッグ → 離した時点でクリップボードにコピー（1回だけ）。
- 終了: `/exit`（一覧）で終了し、残存 worktree の案内が通常バッファに出る。**worktree は消えない**。

## 後片付け

```bash
cd /tmp/codiva-sample
git worktree list                   # codiva/<slug> が残っていないか
rm -rf /tmp/codiva-sample           # 使い捨てなのでまとめて削除
```

`--keep` で残した spike の一時リポジトリ（`/tmp/codiva-spike-*`）も残っていれば消す。
