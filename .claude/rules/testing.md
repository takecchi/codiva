# テスト規約

vitest でのテスト配置・書き方の決まり。**テストを追加/変更するときに読む。**

## 配置

| 種類 | 置き場所 | 例 |
|---|---|---|
| 単体（純関数・クラス） | 実装の隣に co-located `*.spec.ts` | `src/core/slug.ts` ↔ `src/core/slug.spec.ts` |
| UI コンポーネント単体 | 実装の隣に `*.spec.tsx` | `src/ui/prompt-input.spec.tsx` |
| App 全体を通す機能/統合 | `tests/*.test.tsx` | `tests/app.test.tsx` |
| SDK 実データ | `src/core/__fixtures__/*.jsonl` | `session-subagent.jsonl` |

`vitest.config.ts` の include は `src/**/*.spec.{ts,tsx}` と `tests/**/*.test.{ts,tsx}`。
どちらの命名も**間違えると実行されない**ので注意（`*.test.ts` を src に置かない）。

## カバレッジ

- 対象は `src/core/**` と `src/utils/**` のみ（`*.spec.*` と `__fixtures__/` は除外）。
- 閾値: statements / functions / lines **80%**、branches **75%**（残りは untyped SDK データ向けの
  `?? default` 防御分岐で、テストを強制する価値が低いため意図的に低い）。**下げない。**
- `src/ui/**` はカバレッジ対象外だが、キー操作の配線は `tests/*.test.tsx` で担保する。

## 書き方

- **純関数はテーブルドリブン**（`it.each` / 配列 + ループ）。分岐ごとに関数を呼び分けるテストを
  量産しない。
- **フェイクは `tests/helpers.ts` に集約**。すでにあるものをコピペで再定義しない:
  `flush(ms)` / `settle(lastFrame)` / `fakeWorktrees` / `noopSession(input)` / `makeManager()` /
  `FakeStdin` / `renderFullscreen(element, rows, columns)` / `stripAnsi(frame)`。
- **フレームから座標を割り出して触るテストは `settle(lastFrame)` で待つ**（固定 `flush()` にしない）。
  マウスの当たり判定はアプリが実測した幾何で行われるので、まだ描き変わる余地があるうちに
  クリックを合成すると別の行に当たる。`settle` は**描画が止まるまで**待つので、遅い CI では
  自然に長く待つ（固定 150ms の賭けで 1 度だけ落ちた: 詳細ログのドラッグ選択が空コピーになる）。
  静止の窓はストア購読のまとめ窓（~100ms）より長くとってある。逆に**タイマーで動き続ける
  ことを確かめるテスト**（端の自動スクロール）はここで待ってはいけない（止まるまで待ってしまう）。
- SDK なしで core を駆動する: `Session` に `queryFn` を DI し、フェイクが
  「`SDKMessage` を順に yield し、`canUseTool` を任意タイミングで発火する」形にする。
  **ネットワークにも実 `claude` にも依存させない。**
- 時刻は `now: () => number` を注入して決定的にする（`makeManager()` は `now: () => 0`）。
- 実 git が必要なもの（`utils/git.spec.ts` / `utils/worktree-manager.spec.ts`）は
  `mkdtemp` + `git init` で使い捨てリポジトリを作る。**このリポジトリ自体を対象にしない。**
- UI は `ink-testing-library`（全画面レイアウトの検証は `renderFullscreen`）。
  「1画面 1 `useInput`」前提でキーを流すので、キー処理の分岐は view のハンドラを通して検証する。

## フィクスチャ

- `src/core/__fixtures__/` に置くのは **spike で採取した実メッセージ**。手書きの想定メッセージで
  reducer/parse をテストしない。読み込みイディオム:

  ```ts
  const path = fileURLToPath(new URL(`./__fixtures__/${name}`, import.meta.url));
  readFileSync(path, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as SDKMessage);
  ```

- **昇格前に必ずサニタイズ**する。`system/init` は環境情報の塊（絶対パス・`memory_paths`・
  MCP サーバ名・`skills`/`slash_commands`/`agents` 等）なので、テストが読むフィールド
  （実質 `session_id` のみ）だけ残し、個人パスは置換する。生ログ置き場 `scripts/fixtures/` は
  gitignore 済みで、そのまま commit しない。

## 自動で守られている番人（壊さない）

- `core/i18n.spec.ts` … ja / en のキー集合一致を実行時に検証（新グループを足しても効く）。
- `STATUS_META: Record<SessionStatus, …>` … 状態追加時の漏れを型で検出。
- `Messages` 型 … 文言キーの欠落を型で検出。
- CI（`.github/workflows/ci.yml`）… `lint → typecheck → test → build` の4段。ローカルでも同じ
  4コマンドを通してから PR にする。
