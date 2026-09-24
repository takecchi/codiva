# リリース手順

codiva の npm 配信は **npm Trusted Publishing（OIDC）** を使い、GitHub Actions から
**トークンレス**で行う。長期の `NPM_TOKEN` を GitHub Secrets に置く必要がない（漏洩リスクなし）。

- 初回だけ、手元から手動で publish する（パッケージが npm 上に存在しないと Trusted Publisher を設定できないため）。
- 2 回目以降は、**GitHub 上で Release を publish するだけ**で自動配信される。
- さらに `@anthropic-ai/claude-agent-sdk` の更新だけは、**検知から配信まで全自動**で回る（[自動リリース](#自動リリースclaude-agent-sdk-追従)）。

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

`release.yml` の publish ジョブには入口が 2 つある（配信経路は 1 本のまま）:

| 入口 | 誰が使うか | バージョンの出所 |
|---|---|---|
| `on: release: [published]` | 人間（通常のリリース） | タグ名 `v1.2.3` |
| `on: workflow_call` | `auto-release.yml`（自動リリース） | 呼び出し側が渡す `version` |

> **`release.yml` というファイル名を変えない。** npm の Trusted Publisher は OIDC の
> `job_workflow_ref`（= job を定義しているファイル）でこの名前を検証している。
> reusable workflow として呼ばれても job の定義元はこのファイルなので一致する。

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

## 自動リリース（claude-agent-sdk 追従）

`@anthropic-ai/claude-agent-sdk` は **Claude Code CLI 本体を同梱**していて、codiva は
`pathToClaudeCodeExecutable` を指定していない = **その同梱バイナリを起動する**（ユーザーが
入れた `claude` CLI は導入判定と `/login` にしか使っていない）。SDK の `0.3.<N>` は CLI の
`2.1.<N>` に対応するので、SDK の追従が遅れると codiva だけが古い Claude Code で動く。
実際、`/model` の一覧（`supportedModels()` の返り値をそのまま出している）が
ユーザーの `claude` より 1 世代古い説明文になる不具合が出た。

そのため **SDK の更新だけは検知から配信まで自動化**してある。

```
Dependabot（毎日 22:00 JST）
        │  SDK の更新を検知して単独 PR を作る
        ▼
dependabot-auto-merge.yml
        │  SDK の PR かつ non-major なら auto-merge を有効化
        │  （マージされるのは CI が緑になってから）
        ▼
main に SDK の bump が入る
        │
        ▼
auto-release.yml（毎日 09:30 JST / main への package.json push / 手動実行）
        │  1. npm に公開済みの codiva の SDK バージョンと main のそれを比べる
        │  2. 違えば patch を 1 つ上げて…
        │  3. release.yml を workflow_call で呼ぶ（= npm publish）
        │  4. publish 成功後に GitHub Release を作る
        ▼
npm に新しい codiva が公開される
```

### なぜ「マージを待ち受ける」形にしていないか

**GITHUB_TOKEN が起こしたイベントは workflow を発火しない**（GitHub の無限ループ防止）。
auto-merge を有効化するのは GITHUB_TOKEN なので、そのマージによる main への push も、
そこで作った Release も、次の workflow を起動しない。

そこで 2 つの設計にした:

- **リリースの発火は `workflow_call`**。`auto-release.yml` が同一 run 内で `release.yml` を
  直接呼ぶので、PAT を Secrets に置かなくてよい。
- **判定は冪等**。「main の SDK バージョン」と「**npm に公開済みの codiva** が持つ SDK
  バージョン」を比べるだけなので、途中で失敗しても次の定期実行が同じ結論に辿り着く
  （タグや commit を数えていない）。だから「マージの瞬間」を取りこぼしても問題ない。

### 前提（リポジトリ設定・1 回だけ）

1. **Settings → General → Pull Requests → Allow auto-merge** を有効にする。
   無効だと `gh pr merge --auto` が `Auto-merge is not allowed for this repository` で落ちる。
2. **main に必須ステータスチェックを設定する**（Settings → Rules → Rulesets などで CI を required に）。
   必須チェックが 1 つも無いと auto-merge は待つものが無く、CI を見ずに即マージされる。
3. **レビュー必須にしている場合**は、auto-merge は承認されるまで待ち続ける（自動では進まない）。
   SDK の PR だけ自動で流したいなら、その設定を見直すか `dependabot[bot]` を bypass に入れる。
4. Dependabot が有効であること（Settings → Code security → Dependabot version updates）。

### 手で止めたいとき

- 一時的に止める: `.github/dependabot.yml` の npm 側 `schedule.interval` を `monthly` に落とすか、
  `dependabot-auto-merge.yml` の条件を外す。
- 特定の PR だけ止める: その PR で `gh pr merge --disable-auto` を実行する。
- 自動リリースだけ止める: `auto-release.yml` の `schedule` と `push` を消し、
  `workflow_dispatch` だけ残す（判定ロジックは手動実行でそのまま使える）。

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
- **自動リリースのタグは publish の**後**に作る**: 手動リリース（タグが先）と順序が逆なので、
  `auto-release.yml` のタグはバージョン更新コミットを指す。意図的な差で、問題は無い。
- **`Unable to authenticate`（自動リリースだけ失敗する）**: npm の Trusted Publisher が
  reusable workflow 経由の `job_workflow_ref` を受けられていない可能性がある。
  切り分けは手動リリース（Release を publish）を 1 回試すこと — そちらが通るなら OIDC の
  claim の違いが原因なので、`auto-release.yml` の `publish` ジョブを
  「PAT で Release を publish して `release.yml` を発火させる」方式に差し替える
  （その場合 Secrets に `contents: write` を持つトークンが 1 つ必要になる）。
- **自動リリースが走らない**: `auto-release.yml` を `workflow_dispatch` で手動実行し、
  `decide` ジョブのログを見る。`SDK は公開済みリリースと同じ` なら Dependabot の PR が
  まだ main に入っていない（auto-merge の前提設定を確認）。
- **自動リリースが毎日走ってしまう**: `decide` が npm から SDK バージョンを読めていない
  （`::warning::` が出ていれば読めていない）。その場合はリリースせず黙るので害は無いが、
  `npm view <pkg>@<version> dependencies --json` が返る状態かを確認する。
