# Ink コンポーネント規約

一般的な React コンポーネント設計原則を Ink TUI 向けに翻案。DOM/ルータ/CSS の話は対象外。

## 状態とロジック

- コンポーネントは**表示に徹する**。状態の導出は `core`（`status-reducer` 等の純関数）に委譲し、UI では計算しない。
- データ購読はそれを必要とするコンポーネント内で行う（`useSessions()` 等）。共有が必要なときだけ親に持ち上げる。「全 hook を親に集めて props で配る」ことはしない。
- 純粋な描画と副作用（`manager.send()` 等）を混ぜない。

## 入力ハンドリング

- **1画面につき `useInput` は1つ**（view コンポーネントに置く）。`PromptInput` 等は presentational にして、キー処理は view 側の単一ハンドラに集約する（複数 `useInput` の競合を避ける）。
- モーダルな状態（`pendingPermission` あり）では、そのダイアログにキーを委譲し、背後の view はキーを処理しない。

## 描画パフォーマンス

- 追記ログは `<Static>` を使う（全再描画を避ける）。
- ストア購読（`useSessions`）は ~100ms スロットル。`useSyncExternalStore` の getSnapshot が同一参照を返せば再描画されない性質を使う。
- 経過時間など時間依存表示は `useClock()` で定期再描画する。

## 対象外

- Storybook（Ink には非適用）。UI テストは `ink-testing-library` + vitest で行う。
- Web 向けデザインスキル（Tailwind/Radix/フォント選定等）は端末 UI に不要。
