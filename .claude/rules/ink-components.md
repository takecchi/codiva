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
- **共有 presentational**: 角丸ダイアログ枠は `<DialogBox>`、y/n 確認行は `<ConfirmPrompt>`、
  選択肢の 1 件（ラベル + 説明）は `<ChoiceRow>`。両 view で使う。
  色は必ず `theme.ts`（`theme`/`statusColor`/`logColor`）経由で引き、`.tsx` に生 ANSI 名（`color="red"` 等）を書かない。
- **ラベルと説明を横に並べない**。同じ行（row の Box）に 2 つの `<Text>` を置くと Yoga が
  **両方を縮める**ため、長いラベルも長い説明も途中で切れて読めなくなる（質問ダイアログで実際に
  起きた不具合）。折返し幅は端末桁から自前で出し（`dialogContentWidth(columns)`）、行への分解は
  純粋な `choiceLines()`（`core/choice-lines.ts`）に委譲して、`<ChoiceRow>` で 1 行 1 `<Text>` として
  描く（ログの `logLines` と同じ考え方）。継続行は prefix の表示幅ぶん字下げしてラベルの桁に揃える。
  溢れたときに縮む役は内部スクロールを持つ領域（ログ・一覧）なので、ダイアログ側の枠には
  `flexShrink={0}` を付ける。

## 入力ハンドリング

- **1画面につき `useInput` は1つ**（view コンポーネントに置く）。`PromptInput` 等は presentational にして、キー処理は view 側の単一ハンドラに集約する（複数 `useInput` の競合を避ける）。
- モーダルな状態（`pendingPermission` あり）では、そのダイアログにキーを委譲し、背後の view はキーを処理しない。
  例外として**モーダル自身は `useInput` を持つ**（`permission-dialog` / `model-select` / `repo-prompt-editor`）。
  成立条件は「背後の view がモーダル表示中に全キーを飲む」こと（`pending` / `modelSelect` / `promptEdit` の
  ガードが view の `useInput` の先頭にある）。モーダルを増やすときはこのガードを必ず追加する。
- **フォーカスモデル**: 一覧画面は `composer`（入力欄・起動時の既定）と `list` の2ゾーン。
  Tab で切替。composer 中は矢印がキャレット移動（`editText` の arrows+vertical）、list 中は
  ↑↓が行選択・Enter/→ が「claude で開く」・m/d がマージ/破棄。list 中に印字キーを打つと
  composer に戻ってそのまま挿入される。選択中セッションの許可/質問ダイアログは
  **list フォーカス時のみ**アクティブ（composer のタイピングを乗っ取らない）。
- **フォーカスに依存しない操作は chord にする**。中断セッションの復帰（`Ctrl+R` = 選択中を再開、
  `Ctrl+A` = 一括再開）は一覧・詳細のどちらでも、フォーカスゾーン／操作パネルの状態に関係なく効く。
  印字キー（`r`）だけにすると既定フォーカス（composer / 入力欄）から「Tab → r」の2手になり、
  復帰が「ワンプッシュ」にならない。逆に印字キーをフォーカス横断で奪うとタイピングが壊れるので、
  **横断させたいものは必ず ctrl 付き**にする（`editText` は ctrl chord を無視するので競合しない）。
  案内はフッタヒント（フォーカスで切り替わる）ではなく**独立した行**に出す。
- **バッファ編集は ref 経由で逐次適用する**。端末は連打・ペースト・エスケープ列を
  1チャンクにまとめて届けることがあり、useInput ハンドラが同一 tick に複数回呼ばれる。
  `setState(edit(state, ...))` だと全イベントが同じ stale な state から計算されて潰れる
  （←×5 が1回分になる等）。`bufferRef.current` を更新してから `setState(ref.current)` する。
- **挿入テキストはサニタイズする**（`ui/input.ts` の editText 内）。複数文字チャンクは
  キー名が付かない生テキストとして届くため、タブ・CR 等の制御文字が混ざり得る。
  改行は LF に正規化、タブ→スペース、他の C0/DEL は捨てる。
- **マウス**: SGR マウスレポート（`utils/mouse.ts` で ?1002/?1006、全画面時のみ有効）。
  ?1002 はボタン押下中のドラッグ移動も報告する（`parseSgrMouse` は `kind:'drag'` を返す）。
  解析は純粋な `parseSgrMouse`（`core/mouse.ts`）で行い、**view の useInput の先頭で**
  キー入力より先に処理する（レポート断片をバッファへ混入させない）。クリック位置→
  キャレットは `caretIndexForColumn`（表示幅の逆変換）+ `indexAtRowCol`。座標は
  出力原点前提なので、インライン描画フォールバック時はマウスを有効化しない。
  設定 `"mouse": false` で無効化（有効中は端末の通常ドラッグ選択が奪われるが、入力欄は
  アプリ側の範囲選択でカバーする。端末ネイティブ選択は Shift+ドラッグで可）。
- **入力欄の範囲選択コピー**: コンポーザ上のドラッグ（press=アンカー→drag=終点→release）で
  範囲選択し、離した時点で **1 回だけ** クリップボードへコピー（`utils/clipboard.ts` の
  OSC 52。SSH 越しでも動く）。選択の純粋ロジックは `core/text-selection.ts`
  （`normalizeSelection`/`selectionText`/`lineSelection`）、状態管理は共有フック
  `useDragSelection`（`ui/hooks.ts`、コピー関数は DI）。ハイライト描画は `PromptInput`
  の `selection` prop（選択中は block caret を出さない）。コピー関数は合成ルート
  （`index.tsx`→`App`→両 view の `onCopy`）で注入する（ui は utils を直接 import しない）。
  ドラッグごとに送らない（再描画毎コピーは他 TUI で既知のバグ）。
- **ヘッダの範囲選択コピー**: 一覧のヘッダ（`Banner`）も同じ `useDragSelection` で選択・コピーできる
  （主用途は cwd の絶対パスの取り出し）。**選択領域ごとに 1 インスタンス**にする — caret index は
  その領域のテキスト（コンポーザは buffer、ヘッダは `bannerText(lines)`）が基準なので、共有すると
  index の意味が混ざる。press でどちらが drag を持つか決め、release は両方に渡す（アンカーの無い側は
  no-op）。ヘッダのドラッグは**フォーカスも選択行も動かさない**（パスを取るだけの操作でタイピング
  位置を奪わない）。当たり判定は「**行 index = 表示行**」前提の `bannerCaretAt`（`core/banner-lines.ts`）
  なので、行は `wrap="truncate-end"` で固定し、**選択可能なテキスト塊（`textRef` の Box）の中に margin を
  入れない**（折返しや margin が入ると以降の行が全部ズレる）。逆に、その塊の**外**に描く節
  （`UsageSection` = 使用状況ゲージ / `PrivacySection` = 学習データ利用の警告）は行 index を揺らさないので
  `marginTop` で空けてよい。位置の実測 ref は縦中央寄せの外側 Box ではなく
  **行だけを包む内側 Box** に付ける（外側だと centering のぶんズレる）。
  - **ヘッダの Box に `flexShrink={0}` を付けない**。低い端末ではヘッダも縮んで下段 UI（コマンド
    パレット等）に場所を譲る必要がある。かつ**内側の行 Box だけを縮ませない**のも禁止 —
    中央寄せが負のオフセットを返し、ヘッダのテキストが一覧の先頭行に重なって描かれる。
    縦に潰れたときに落ちるのは（中央寄せの負オフセットにより）**上端の行から**なので、
    「行 index = 表示行」は崩れる。実測高さ（`useBoxHeight`）が行数より小さい間は
    **ヘッダの当たり判定自体をやめる**（黙って別の行の文字を選ぶより選べないほうがよい）。
  - **例外として、マスコット（左のアスキーアート）の Box には `flexShrink={0}` を付ける**。
    こちらは行（row）の main axis = 横方向にだけ効くので縦の譲り合いを壊さない。付けないと
    幅の足りない端末で 6 行の絵が折り返して崩れる（右のテキスト欄は各行 `wrap="truncate-end"`
    なので、横の縮小はすべてそちらに寄せて末尾を切るのが正しい）。
  - **横幅に依存する要素は端末幅で段階的に縮退させる**（`core/layout.ts`）。使用状況ゲージは
    `bannerGaugeWidth(columns)` で 20 → 12 → 8 → 0 セル。固定幅にすると 80 桁の端末で
    ヘッダ全体が縮められ、マスコットが崩れる。
  - **重なったときは一覧のクリックを優先**する（`y >= rowsBox.top` ならヘッダの当たり判定を
    しない）。ヘッダは装飾なので、行選択や PR セルのクリックを黙って食う方が害が大きい。
  - **press は行末より右を当たりにしない（`'reject'`）、drag は行末へ丸める（`'clamp'`）**。
    何も無い余白のクリックを飲まないようにしつつ、パス全体を選ぶときに数セル行き過ぎる
    普通の操作は「行末まで選ぶ」で受ける。
  - **選択中はドラッグ開始時のヘッダ内容（行 + テキスト）を固定して持つ**。選択範囲はその
    テキストへの caret index なので、途中で文言が変わると（合計コスト・セッション数・モデル）
    ズレる。固定すればコピー結果は選択した瞬間の文字列になり、現在の表示と
    食い違ったらハイライトを捨てる。

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
- **入力欄は幅を超えたら折り返す（truncate しない）**。`wrap="truncate-end"` だけだと画面端まで打った
  時点でテキストとキャレットが `…` の裏に消え、何を打っているか読めない。折り返しの幾何は純粋な
  `core/composer-layout.ts`（`composerLayout` / `wrapComposerRows`）に集約し、**描画・マウス当たり判定・
  ↑↓ のキャレット移動は必ず同じ幅で同じ関数を通す**（食い違うとクリックが別の文字に当たる）。
  - 幅は**実測**する（`useComposerWidth`）。端末幅から引き算するとダイアログ内（枠+padding）で合わない。
    未実測の 1 フレームだけ折り返さない（= 従来の truncate）挙動に倒す。
  - 「行」は論理行ではなく**表示行**になる。`visibleLineRange` に渡す行数、クリックの
    `caretIndexAtClick`、選択ハイライトの `rowSelection`、詳細ビューの「複数行編集中か」判定
    （`composerRowCount`）はすべて表示行で数える。
  - ↑↓ は表示行で移動する（`editText` の `wrapWidth` → `moveRowUp`/`moveRowDown`）。論理行で動かすと
    長い 1 行の途中から一気に行頭へ飛び、見えている行と操作が食い違う。

## セッション詳細（codiva 内蔵ビュー）

- セッションの中身は codiva 内の **`SessionDetail`** で表示・操作する（一覧で Enter/→）。外部の
  `claude --resume` へは飛ばさず、稼働中の SDK セッションに直結する（`manager.send(id, text)` で追加指示）。
- ビュー切替は `App` の `View` state（`{mode:'list'}` | `{mode:'detail', id}`）。Enter/→ で `onOpen(id)`、
  Esc で `onBack`。詳細ビューは単一 `useInput` の state machine（panel = input | actions）で、
  タイピング（追加指示）と操作キー（m/d = マージ/破棄）の衝突を防ぐ。
- **スラッシュ無しでもコマンド名と完全一致すればコマンド**（`core/commands.ts` の `toCommandInput`）。
  正式名のみ（別名 `?`/`changes` は昇格させない = 1文字の `?` を送れる余地を残す）。判定と実行・
  パレット表示は `useCommandRunner` が返す `run`/`preview` を共有して**必ず同じ条件**にする
  （予告なく終了させない）。そのビューがハンドラを持たないコマンド名は昇格させず、通常の指示として
  流す（`clear` が詳細で無言に消えないため）。
- **`/exit` は画面で意味が変わる**。一覧は終了（`onQuit`）、詳細は Esc と同じ「一覧へ戻る」（`onBack`）。
  詳細から誤ってアプリを落とさないため。同じコマンドの説明文も変わるので、パレットへは
  `CommandPalette` の `describeOverrides`（キー=コマンド名）でビュー固有の文言を渡す
  （詳細は `m.command.exitDetail`）。文字列は必ずカタログから引く（[i18n.md](./i18n.md)）。
- 詳細ビューは**ステータスヘッダを持たない**。コンテンツ（ログ）+ フッタ（コンポーザ）だけにし、
  ログ用の縦幅を最大化する（一覧はヘッダ=Banner + コンテンツ + フッタだが、詳細はヘッダ抜き）。
- ログは末尾ビューポート（`justifyContent="flex-end"` + `overflowY="hidden"`）に描き、`<Static>` は使わない
  （全画面では画面外へ消えるため）。スクロールの単位は**物理行**: エントリは `core/scroll.ts` の
  `logLines`（CJK 幅対応の折返し）で `DisplayLine[]` へ展開してから window する。スクロール計算は純関数
  `core/scroll.ts`（`logWindow`/`scrollUp`/`scrollDown`）に委譲する。
- **可視域より多くの行を描かない**。Ink/Yoga は溢れた子を「上端でクリップ」せず**縮小**するため、
  1行でも多く描くとログの途中の行が虫食いで消える（= 上へスクロールしても読めない）。対策は2段:
  1. 行の入れ物に `flexShrink={0}` を付けて縮小を禁じる（溢れは flex-end で上端クリップになる）。
  2. `logWindow` に渡す行数を**実測した可視高さ**（`useBoxHeight(logRef)`。見積り `logViewportRows` は
     初回描画までのフォールバック）に合わせる。
  併せて `logWindow`/`scrollUp` はアンカーを**1画面ぶんで下限を打つ**。これがないと最上部で
  数行だけが空画面の下端に張り付き、ログの先頭をページとして読めない。
- **逆に「数えた行数ぶんの高さを必ず確保する」**。Ink の `measureText('')` は**高さ 0** を返すため、
  空文字の `<Text>` は行として場所を取らない。ログの空行（Markdown の段落間・コードブロック内）が
  これに当たり、スクロール計算が 1 物理行として数えた行が消えるので、末尾寄せのビューポート
  **上端に空行の本数ぶんの隙間**が残る（「表示できる行があるのに上が空いている」）。行を描く
  コンポーネントは空行を半角スペース 1 つ等に置き換えて必ず 1 行ぶんの高さを持たせる
  （`LogLine` の `BLANK_ROW`）。行ごとに非空のプレフィックスを持つ `PromptInput` は影響を受けない。
- **ビューポートを共有する行の予約は「実際に描くときだけ」引く**。ストリーミングのプレビュー行は
  ログと同じ可視域を使うが、末尾追従中しか描かない。常に 1 行引くと描かない行を予約して上端に
  隙間ができ、逆に引き忘れると上端が 1 行クリップされる。`logWindow` に渡す行数（`logCap`）と
  `scrollUp`/`scrollDown` に渡す行数は**必ず同じ値**にする（食い違うと最上部でアンカーが 1 行手前で
  止まり、先頭行に到達できなくなる）。
- スクロール操作は **PgUp/PgDn（半画面）** と **↑/↓（1行 = `ARROW_SCROLL_LINES`）**。詳細ビューは
  ログのコピペのためマウス捕捉を解除している（`mouse.disable()`）ので、alt screen では端末が
  ホイールを ↑/↓ に変換して送ってくる（alternate scroll mode）＝ ↑/↓ がホイールの受け口になる。
  複数行を編集中のみ ↑/↓ はキャレット移動を優先する。捕捉が生きている隙間のために
  **マウスホイールのレポート列も `parseSgrMouse` で useInput 先頭で先取り解釈**する（一覧と同じ）。
  これをしないとホイールのエスケープ列が生テキストとしてコンポーザへ入力されてしまう。
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
