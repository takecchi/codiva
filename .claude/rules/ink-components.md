# Ink コンポーネント規約

一般的な React コンポーネント設計原則を Ink TUI 向けに翻案。DOM/ルータ/CSS の話は対象外。

## 状態とロジック

- コンポーネントは**表示に徹する**。状態の導出は `core`（`status-reducer` 等の純関数）に委譲し、UI では計算しない。
- データ購読はそれを必要とするコンポーネント内で行う（`useSessions()` 等）。共有が必要なときだけ親に持ち上げる。「全 hook を親に集めて props で配る」ことはしない。
- 純粋な描画と副作用（`manager.send()` 等）を混ぜない。

## 入力ハンドリング

- **1画面につき `useInput` は1つ**（view コンポーネントに置く）。`PromptInput` 等は presentational にして、キー処理は view 側の単一ハンドラに集約する（複数 `useInput` の競合を避ける）。
- モーダルな状態（`pendingPermission` あり）では、そのダイアログにキーを委譲し、背後の view はキーを処理しない。

## 全画面レイアウト

- アプリは端末の縦幅いっぱい（web の 100dvh 相当）に描画する。Ink はコンテンツの高さぶんしか
  描画しないため、`App` の root `<Box>` に `useWindowSize()` の `rows` を `height` 指定する
  （リサイズ追従込み）。root には `overflow="hidden"` を付け、フレームが端末高さを超えて
  Ink が全画面クリアにフォールバックする（ちらつく）のを防ぐ。
- ただし端末が `MIN_FULLSCREEN_ROWS`（`core/layout.ts`）未満に低い場合は height 固定を
  やめてインライン描画へフォールバックする（クリップで入力欄・フッタが消えるのを防ぐ）。
  判定は `isFullscreenViewport(rows)`。
- 各 view は `flexGrow={1}` の縦 flex にし、入力欄+フッタは flexGrow スペーサで最下部に固定する。
- 全画面で描くときは起動時に **alt screen**（`\x1b[?1049h`、`utils/alt-screen.ts`）へ入る。
  通常バッファのままだとスクロールバックが残り上へスクロールできてしまうため。
  インライン描画フォールバック時（TTY でない / 起動時 rows が閾値未満）は enter しない。
  配線は `src/index.tsx`（合成ルート）で行い、終了メッセージは leave 後に書く。
- **`<Static>` は使わない**。Static はスクロールバック側に書き出すため、全画面レイアウトでは
  ビューポート外に消えて見えなくなる。追記ログは「末尾ビューポート」
  （`flexGrow={1}` + `overflowY="hidden"` + `justifyContent="flex-end"`）で最新行を下端に表示し、
  `logWindow(messages, rows, anchor)`（`core/scroll.ts`）で描画ノード数に上限を掛ける。
- **ログスクロールは純関数に委譲**。`anchor`（`'bottom'`=末尾追従／絶対 end index=上スクロール中は固定）
  を UI 状態に持ち、PgUp/PgDn で `scrollUp`/`scrollDown`（`core/scroll.ts`）。alt screen で端末スクロールバックを
  無効化しているため、過去ログはこのアプリ内スクロールでのみ辿れる。追加指示の送信時は `'bottom'` へ戻す。
- **複数行入力も純粋モデルへ委譲**。テキストバッファは `core/text-buffer.ts`（value+cursor）、キー→操作の
  対応だけ `ui/input.ts`（`editText`/`resolveEnter`）に置く。Shift/Meta+Enter か末尾バックスラッシュ+Enter で
  改行、他は送信。一覧は矢印を行選択に温存（カーソル移動なし）、詳細は矢印でカーソル移動。`PromptInput` は
  `INPUT_MAX_ROWS` まで縦に伸び、超過は `visibleLineRange` でカーソル付近を内部スクロール。

## IME（日本語入力）対応

- IME の未確定文字列（変換中のプレビュー）は**端末が実カーソル位置に描画する**。
  Ink はカーソルを隠したまま描画するため、何もしないと変換中の文字がどこにも
  見えず「日本語が打てない」ように見える（Ghostty 等で顕著）。
- 対策: フォーカス中の `PromptInput` は Ink の `useCursor` で実端末カーソルを
  キャレットのセルに置く。座標は出力原点からの絶対位置が必要だが、
  `useBoxMetrics` は**親相対**なので `useAbsolutePosition`（`ui/hooks.ts`、
  yoga ツリーを遡って合算）を使う。
- キャレット列は表示幅で数える（`promptCaretColumn`、CJK/絵文字は2セル）。
  `.length` で数えるとカーソルと preedit の位置が日本語でズレる。
- フォーカスが外れたら（モーダル表示・アンマウント時）`setCursorPosition(undefined)`
  で必ず隠す。`useCursor` を同時に呼ぶコンポーネントは**1画面に1つ**まで。

## 描画パフォーマンス

- ストア購読（`useSessions`）は ~100ms スロットル。`useSyncExternalStore` の getSnapshot が同一参照を返せば再描画されない性質を使う。
- 経過時間など時間依存表示は `useClock()` で定期再描画する。

## 対象外

- Storybook（Ink には非適用）。UI テストは `ink-testing-library` + vitest で行う。
- Web 向けデザインスキル（Tailwind/Radix/フォント選定等）は端末 UI に不要。
