---
name: sdk-spike
description: Claude Agent SDK の実メッセージを採取してテストフィクスチャに昇格させる手順。npm run spike の使い方、シナリオ、サニタイズ（環境情報の除去）、src/core/__fixtures__ への配置、spec の書き方、TECH_NOTES への実測結果追記まで。「SDK のメッセージ形式を確認したい」「フィクスチャを追加したい」「reducer が実データで落ちる」ときに使う。
---

# SDK の実挙動を採取してフィクスチャにする

**SDK メッセージの形を想定で書かない。** 迷ったら必ず実データを採る。これはこのリポジトリの
最重要ルール（[.claude/rules/sdk-integration.md](../../rules/sdk-integration.md)）。

## 前提

- 実 `claude` サブプロセスが動くので **Claude の認証が必要**（`~/.claude` を継承、または
  `ANTHROPIC_API_KEY`）。トークンを消費する。
- 非対話のエージェントセッションでは実行できない場合がある。**そのときはユーザーに実行を依頼し、
  出てきた JSONL を受け取ってから実装する**（推測で先に進めない）。

## 1. 採取する

```bash
npm run spike -- basic       # todo + AskUserQuestion + ファイル作成
npm run spike -- followup    # 1回目の result 後に2通目を push
npm run spike -- interrupt   # 途中で q.interrupt()
npm run spike -- subagent    # Task ツールでサブエージェントに委譲（完了ゲートの検証用）
npm run spike -- basic --keep  # 一時リポジトリを消さずに残す
```

- `--` を忘れると引数が渡らず `basic` になる（npm の仕様）。
- 一時ディレクトリに `git init` + 初期コミット + worktree を作って実行し、終了時に削除する。
- 生ログは `scripts/fixtures/<scenario>-<timestamp>.jsonl`（**gitignore 済み**）。
  `{_spike: 'canUseTool', …}` / `{_spike: 'error', …}` のマーカー行が混ざる。
- 終了時に `===== SPIKE SUMMARY =====`（型ごとの件数・observed tool_use・チェックリスト）が出る。

新しい挙動を観察したいときは `scripts/spike.ts` の `PROMPTS` にシナリオを追加する
（`Scenario` 型・usage コメント・不明シナリオのエラーメッセージも一緒に更新する）。

## 2. サニタイズしてから昇格する

`scripts/fixtures/` の生ログを `src/core/__fixtures__/<name>.jsonl` へコピーする前に、
**必ず環境情報を削る**:

- `system/init` は環境フィンガープリントの塊（`cwd` の絶対パス・`memory_paths`・接続中の
  MCP サーバ名・`skills` / `slash_commands` / `agents` 一覧など）。**テストが読むのは実質
  `session_id` だけ**なので、それ以外は削るか汎用値へ置換する。
- `/Users/<name>` などの個人パス、リポジトリ固有のパスを置換する。
- `_spike` マーカー行は残さない（`SDKMessage` ではない）。
- 代表ケースだけ残して行数を絞る（テストが読める大きさに保つ）。

## 3. spec で使う

読み込みイディオム（`src/core/sdk-parse.spec.ts` に倣う）:

```ts
function loadFixture(name: string): SDKMessage[] {
  const path = fileURLToPath(new URL(`./__fixtures__/${name}`, import.meta.url));
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as SDKMessage);
}
```

- パースの検証は `applySdkMessage` を順に畳み込み、**最終状態と主要な中間状態**を assert する。
- 現行フィクスチャ: `session-basic` / `session-followup` / `session-interrupt` /
  `session-subagent` / `transcript-restore`。既にあるものを使えるなら増やさない。

## 4. 実測結果を残す

`docs/TECH_NOTES.md` の「スパイク結果」節に、**想定と違った点**を中心に追記する
（SDK バージョン・モデル・日付を明記）。次の実装者が同じ検証を繰り返さないための資産。
挙動が状態機械に影響するなら `docs/ARCHITECTURE.md` も更新する。

## チェックリスト

- [ ] `npm run spike -- <scenario>` で実データを採取（認証が必要）
- [ ] サニタイズ（init の環境情報・個人パス・`_spike` 行）
- [ ] `src/core/__fixtures__/` に配置し、spec から `loadFixture` で読む
- [ ] `docs/TECH_NOTES.md`「スパイク結果」に実測を追記（バージョン・日付付き）
- [ ] `npm test`
