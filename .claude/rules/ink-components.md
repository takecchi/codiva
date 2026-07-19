# Ink コンポーネント規約

一般的な React コンポーネント設計原則を Ink TUI 向けに翻案。DOM/ルータ/CSS の話は対象外。

## 状態とロジック

- コンポーネントは**表示に徹する**。状態の導出は `core`（`status-reducer` 等の純関数）に委譲し、UI では計算しない。
- データ購読はそれを必要とするコンポーネント内で行う（`useSessions()` 等）。共有が必要なときだけ親に持ち上げる。「全 hook を親に集めて props で配る」ことはしない。
- 純粋な描画と副作用（`manager.send()` 等）を混ぜない。
- **一覧/詳細で重複する状態ロジックは共有フックへ**（`ui/hooks.ts`）: コンポーザのバッファ管理は
  `useTextBufferRef()`、`/command` の解決・実行は `useCommandRunner(handlers, onError, unknownLabel)`、
  マージ/破棄の確認→実行フローは `useLifecycleAction(manager, id, onDone?)`。`useInput` 本体はフックに移さず
  view に置いたまま、これらから state とハンドラを受け取る（1画面1 useInput は維持）。
- **共有 presentational**: 角丸ダイアログ枠は `<DialogBox>`、y/n 確認行は `<ConfirmPrompt>`。両 view で使う。
  色は必ず `theme.ts`（`theme`/`statusColor`/`logColor`）経由で引き、`.tsx` に生 ANSI 名（`color="red"` 等）を書かない。

## 入力ハンドリング

- **1画面につき `useInput` は1つ**（view コンポーネントに置く）。`PromptInput` 等は presentational にして、キー処理は view 側の単一ハンドラに集約する（複数 `useInput` の競合を避ける）。
- モーダルな状態（`pendingPermission` あり）では、そのダイアログにキーを委譲し、背後の view はキーを処理しない。
- **フォーカスモデル**: 一覧画面は `composer`（入力欄・起動時の既定）と `list` の2ゾーン。
  Tab で切替。composer 中は矢印がキャレット移動（`editText` の arrows+vertical）、list 中は
  ↑↓が行選択・Enter/→ が「claude で開く」・m/d がマージ/破棄。list 中に印字キーを打つと
  composer に戻ってそのまま挿入される。選択中セッションの許可/質問ダイアログは
  **list フォーカス時のみ**アクティブ（composer のタイピングを乗っ取らない）。
- **バッファ編集は ref 経由で逐次適用する**。端末は連打・ペースト・エスケープ列を
  1チャンクにまとめて届けることがあり、useInput ハンドラが同一 tick に複数回呼ばれる。
  `setState(edit(state, ...))` だと全イベントが同じ stale な state から計算されて潰れる
  （←×5 が1回分になる等）。`bufferRef.current` を更新してから `setState(ref.current)` する。
- **挿入テキストはサニタイズする**（`ui/input.ts` の editText 内）。複数文字チャンクは
  キー名が付かない生テキストとして届くため、タブ・CR 等の制御文字が混ざり得る。
  改行は LF に正規化、タブ→スペース、他の C0/DEL は捨てる。
- **マウス**: SGR マウスレポート（`utils/mouse.ts` で ?1000/?1006、全画面時のみ有効）。
  解析は純粋な `parseSgrMouse`（`core/mouse.ts`）で行い、**view の useInput の先頭で**
  キー入力より先に処理する（レポート断片をバッファへ混入させない）。クリック位置→
  キャレットは `caretIndexForColumn`（表示幅の逆変換）+ `indexAtRowCol`。座標は
  出力原点前提なので、インライン描画フォールバック時はマウスを有効化しない。
  設定 `"mouse": false` で無効化（有効中は端末のテキスト選択が Shift+ドラッグになるため）。

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
  ビューポート外に消えて見えなくなる。
- **複数行入力は純粋モデルへ委譲**。テキストバッファは `core/text-buffer.ts`（value+cursor）、キー→操作の
  対応だけ `ui/input.ts`（`editText`/`resolveEnter`）に置く。Shift/Meta+Enter か末尾バックスラッシュ+Enter で
  改行、他は送信。`PromptInput` は `INPUT_MAX_ROWS` まで縦に伸び、超過は `visibleLineRange` で
  カーソル付近を内部スクロール。

## セッション詳細（codiva 内蔵ビュー）

- セッションの中身は codiva 内の **`SessionDetail`** で表示・操作する（一覧で Enter/→）。外部の
  `claude --resume` へは飛ばさず、稼働中の SDK セッションに直結する（`manager.send(id, text)` で追加指示）。
- ビュー切替は `App` の `View` state（`{mode:'list'}` | `{mode:'detail', id}`）。Enter/→ で `onOpen(id)`、
  Esc で `onBack`。詳細ビューは単一 `useInput` の state machine（panel = input | actions）で、
  タイピング（追加指示）と操作キー（m/d = マージ/破棄）の衝突を防ぐ。
- 詳細ビューは**ステータスヘッダを持たない**。コンテンツ（ログ）+ フッタ（コンポーザ）だけにし、
  ログ用の縦幅を最大化する（一覧はヘッダ=Banner + コンテンツ + フッタだが、詳細はヘッダ抜き）。
- ログは末尾ビューポート（`justifyContent="flex-end"` + `overflowY="hidden"`）に描き、`<Static>` は使わない
  （全画面では画面外へ消えるため）。スクロールの単位は**物理行**: エントリは `core/scroll.ts` の
  `logLines`（CJK 幅対応の折返し）で `DisplayLine[]` へ展開してから window する。PgUp/PgDn と
  マウスホイールのスクロールは純関数 `core/scroll.ts`
  （`logWindow`/`scrollUp`/`scrollDown`）に委譲し、移動量は可視ログ高さ（`logViewportRows`）／ホイールは
  `WHEEL_SCROLL_ROWS` から導く。**マウスホイールのレポート列は `parseSgrMouse` で useInput 先頭で先取り解釈**
  する（一覧と同じ）。これをしないとホイールのエスケープ列が生テキストとしてコンポーザへ入力されてしまう。
- 1 SDK セッション 1 ライター。詳細ビューを開いても codiva が唯一のライターであり続ける
  （外部 CLI との二重接続はしない）。マージ/破棄は一覧・詳細のどちらからでも可能。

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
