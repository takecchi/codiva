---
name: add-slash-command
description: codiva のスラッシュコマンド（/model, /diff, /clear など）を追加・変更・削除するときの手順。COMMANDS レジストリ、CommandAction、i18n（ja/en）、各ビューのハンドラ配線、コマンドパレット、テストまでの漏れない順序を示す。「コマンドを追加」「/xxx を作りたい」「パレットに出したい」ときに使う。
---

# スラッシュコマンドを追加する

コマンドは **レジストリ（純粋）+ ビューごとのハンドラ（副作用）** の2層。判定・照合は
`core/commands.ts` に閉じ、実行は UI が `CommandAction` を解釈する。

## 1. レジストリに1エントリ足す — `src/core/commands.ts`

```ts
export type CommandAction = 'help' | 'exit' | 'model' | 'diff' | 'prompt' | 'clear' | '<新規>';

export const COMMANDS: readonly CommandSpec[] = [
  // 配列の順序 = パレット/ヘルプの表示順
  { name: '<name>', action: '<新規>', describe: (m) => m.command.<key> },
  // 別名が必要なら aliases: ['...']
];
```

- `name` は小文字（`parseCommand` が lowercase する）。
- **別名（`aliases`）はパレットの前方一致にだけ効き、スラッシュ無しの昇格には効かない**
  （`toCommandInput` は正式名のみ昇格。`?` や `changes` を打っても指示として送れる余地を残す設計）。
- `describe` は必ずカタログ関数で書く（文言直書き禁止）。

## 2. 文言を ja / en 両方に足す — `src/core/i18n.ts`

`Messages['command']` にキーを追加し、`ja` と `en` の両カタログへ実装を書く。
片方だけだと型エラー、または `core/i18n.spec.ts`（キー集合一致の番人）で落ちる。

ビューによって意味が変わるコマンドは、ビュー固有の説明キーも用意する
（例: `command.exit` = codiva を終了 / `command.exitDetail` = 一覧へ戻る）。

## 3. ハンドラを配線する — `src/ui/session-list.tsx` / `src/ui/session-detail.tsx`

各ビューは `useCommandRunner(handlers, setActionError, m.command.unknown)` に
**自分が実装するアクションだけ**を渡す。

```ts
const commands = useCommandRunner(
  { exit: onQuit, help: () => setShowHelp(true), model: …, prompt: …, clear: … }, // 一覧
  setActionError,
  m.command.unknown,
);
```

- **重要**: ハンドラを持たないビューでは、スラッシュ無しの入力を昇格させない（`clear` を
  詳細ビューで打っても無言に消えず、通常の指示として送られる）。この挙動は
  `useCommandRunner` が担保しているので、`run` / `preview` を自前判定に置き換えない
  （パレットの予告と実際の動作を必ず一致させる）。
- ビュー固有の説明差し替えは `CommandPalette` の `describeOverrides`（キー = コマンド名）に渡す。
  詳細ビューの例: `useMemo(() => ({ exit: m.command.exitDetail }), [...])`。
- 副作用の実体は core/manager 側のメソッドを呼ぶだけにする（UI にロジックを書かない）。

## 4. テスト

- `src/core/commands.spec.ts` … テーブルドリブンで追加（`parseCommand` / `findCommand` /
  `matchCommands` / `toCommandInput` / `runCommand`）。別名の非昇格も明示的にケース化する。
- `tests/commands.test.tsx` … UI 配線（パレット表示・前方一致・実行結果・未知コマンドのエラー）。
- 既存の `tests/app.test.tsx` に該当シナリオがあるなら合わせて更新。

## 5. ドキュメント

- ユーザー可視なので `README.ja.md`（原本）と `README.md`（英語版）のコマンド説明を**両方**更新する。
- キー操作やフッタヒントが変わるなら `docs/ARCHITECTURE.md` の UI 節も直す。

## チェックリスト

- [ ] `COMMANDS` に1エントリ、`CommandAction` に1値
- [ ] `Messages['command']` の ja / en 両方
- [ ] 実装するビューの `useCommandRunner` ハンドラ（＋必要なら `describeOverrides`）
- [ ] `commands.spec.ts` + `tests/commands.test.tsx`
- [ ] README（`README.ja.md` + `README.md` の両方。＋必要なら docs/）
- [ ] `npm run lint` / `npm run typecheck` / `npm test`
