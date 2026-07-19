# リリース手順

codiva の npm 配信は **npm Trusted Publishing（OIDC）** を使い、GitHub Actions から
**トークンレス**で行う。長期の `NPM_TOKEN` を GitHub Secrets に置く必要がない（漏洩リスクなし）。

- 初回だけ、手元から手動で publish する（パッケージが npm 上に存在しないと Trusted Publisher を設定できないため）。
- 2 回目以降は、**GitHub 上で Release を publish するだけ**で自動配信される。

配線は [`.github/workflows/release.yml`](../.github/workflows/release.yml)。

---

## 全体フロー（2 回目以降）

```
GitHub で Release を作成（タグ v1.2.3 を指定して publish）
        │
        ▼
release.yml が発火
        │  1. main を checkout
        │  2. タグ v1.2.3 → package.json を 1.2.3 に更新
        │  3. npm run build
        │  4. npm publish（OIDC で認証・provenance 付与、トークン不要）
        │  5. "chore: release v1.2.3" を main に push
        ▼
npm に codiva@1.2.3 が公開される
```

---

## 前提

- GitHub リポジトリ: `takecchi/codiva`（公開推奨。provenance 署名は公開リポジトリでのみ付与される）
- npm アカウントにログイン済みであること（初回のみ手元で必要）
- パッケージ名 `codiva` が npm 上で空いていること（`npm view codiva` で確認。既に存在する場合は名前を変更する）

---

## 手順 1: 初回だけ手動で publish（あなたが 1 回やる作業）

Trusted Publisher は「既に存在するパッケージ」に対して設定する。そのため最初の 1 回だけ手元から publish する。

```bash
# 1. npm にログイン（未ログインなら）
npm whoami          # ログイン済みか確認
npm login           # 未ログインなら実行

# 2. 最初のバージョンを決める（現在 0.0.0 なので 0.1.0 などに）
npm version 0.1.0 --no-git-tag-version

# 3. ビルド
npm run build

# 4. 公開（unscoped パッケージなので既定で public）
npm publish

# 5. 確認
npm view codiva
```

> 初回は OIDC が使えない（パッケージ未作成のため）ので、あなたのログイン権限で publish する。
> provenance は CI（OIDC）でのみ付与されるため、初回は付かない。2 回目以降の CI 配信から付く。

このコミット（`0.1.0` への更新）は main に入れておく:

```bash
git add package.json package-lock.json
git commit -m "chore: release v0.1.0"
git push origin main
```

---

## 手順 2: npm 側で Trusted Publisher を設定（初回 publish 後・1 回だけ）

1. <https://www.npmjs.com/package/codiva> を開く（初回 publish 後に表示される）。
2. **Settings** タブ →  **Trusted Publisher**（Publishing access）セクション。
3. **GitHub Actions** を選択し、次を入力:

   | 項目 | 値 |
   |------|-----|
   | Organization or user | `takecchi` |
   | Repository | `codiva` |
   | Workflow filename | `release.yml`（ファイル名のみ。パスやディレクトリは含めない） |
   | Environment name | 空欄（未使用） |

4. 保存する。

これで `.github/workflows/release.yml` から実行された `npm publish` が OIDC で認証されるようになる。

> （任意・推奨）同ページの publish 設定で「Require two-factor authentication and disallow tokens」等を有効にすると、
> Trusted Publishing 経由以外の publish を禁止でき、より安全。

---

## 手順 3: GitHub 側の設定（初回・1 回だけ）

### 3-1. Actions のワークフロー権限

`release.yml` は `permissions:` ブロックで `contents: write` / `id-token: write` を宣言済みなので、
基本はそのまま動く。念のため以下を確認しておくと安全:

- **Settings → Actions → General → Workflow permissions**
  - 「Read and write permissions」を選択（または最低限、ワークフローの `permissions:` ブロックを尊重する設定であること）。
- **Settings → Actions → General → Fork pull request workflows** などは既定のままで可。

### 3-2. main ブランチ保護との整合（保護している場合のみ）

`release.yml` の最後で **バージョン更新コミットを main に push** する。main を
ブランチ保護 / ルールセットで「直接 push 禁止」「PR 必須」にしていると、この push が失敗する。

いずれかで対応する:

- **推奨**: Settings → Rules → Rulesets（または Branch protection）で、
  main への push 制限に **`github-actions[bot]` の bypass** を追加する。
- もしくは main の直接 push を許可する（保護を緩める）。
- どうしても保護を維持したい場合は、`release.yml` の「Commit version bump back to main」ステップを
  「PR を作成する」方式に変える（要相談）。

> push が失敗しても **npm への publish 自体は成功している**（publish はその前のステップ）。
> 失敗するのは「main のバージョン更新の push」だけなので、その場合は手動で追従すればよい。

---

## 手順 4: 2 回目以降のリリース（通常運用）

1. main を最新化しておく（リリースは main の HEAD から切られる前提）。
2. GitHub の **Releases → Draft a new release**。
3. **Choose a tag** で新しいタグ（例 `v1.2.3`）を入力し「Create new tag on publish」。
4. リリースノートを書いて **Publish release**。
5. `release.yml` が自動で: バージョン同期 → build → `npm publish`（トークンレス）→ main へバージョン更新コミット。
6. Actions のログと <https://www.npmjs.com/package/codiva> で公開を確認。

タグは `v1.2.3` / `1.2.3` のどちらでも可（先頭の `v` は自動で除去される）。

---

## 補足・トラブルシュート

- **タグとコミットの関係**: Release タグはリリースを切った時点の main コミットを指す。
  バージョン更新コミット（`chore: release vX.Y.Z`）はその直後に main に載る（タグより 1 コミット新しくなる）。これは通常運用で問題ない。
- **provenance が失敗する / リポジトリが private**: provenance 署名は公開リポジトリ前提。
  private のままだと publish が provenance で失敗しうる。公開するか、必要なら publish から provenance を外す（要相談）。
- **`npm ERR! 404` / 権限エラー（初回）**: `npm login` 済みか、パッケージ名が空いているかを確認。
- **`Unable to authenticate`（CI）**: Trusted Publisher の Repository / Workflow filename が
  実ファイル（`release.yml`）と完全一致しているか、`id-token: write` があるかを確認。
- **npm のバージョン**: Trusted Publishing は npm >= 11.5.1 が必要。ワークフローで `npm install -g npm@latest` 済み。
