# コーディング規約

## 型安全

- **`any` 禁止**（Biome `noExplicitAny: error`）。インラインの `as unknown` / `as any` / `as never` を散らさない。
- 外部データ（SDK メッセージ等）の変換は、専用の `toXxx()` 変換関数か `isXxx()` ガード関数の中に閉じ込める。JSON→ドメインは `XxxJson` 型 + `toXxx()` の形にする。
- テストで已むを得ず使う `as unknown as T` は許容だが最小限に。

## エクスポート

- **`export` は定義に直付け**（`export function` / `export class` / `export const`）。末尾の `export { ... }` / `export type { ... }` ブロックは書かない。
- **名前付きエクスポートのみ。default export 禁止**（Biome `noDefaultExport: error`。設定ファイルは lint 対象外なので例外）。
- 集約は各フォルダの `index.ts`（`export * from './x'`）でのみ行う。
- 型の import は `import type`（Biome `useImportType: error`）。

## 構造

- **純粋ロジックと I/O を分離**（[architecture.md](./architecture.md)）。I/O は薄いラッパにし、変換・判定は純関数へ。
- ロジックには必ずテストを書く（vitest）。純関数はテーブルドリブンで。
  - **単体テストは実装の隣に co-located `*.spec.ts`**（例: `slug.ts` ↔ `slug.spec.ts`）。フィクスチャは `__fixtures__/`。
  - **App 全体を通す機能/統合テストは `tests/*.test.ts`**（特定モジュールに属さないため）。
- 1ファイルが 500 行を超えたら分割を検討。
- コメントは「なぜ」を書く。自明な「何を」は書かない。

## git 実行

- git は必ず `execFile`（引数配列）で呼ぶ。**シェル文字列連結は禁止**（`utils/git.ts` の `git()` を使う）。
