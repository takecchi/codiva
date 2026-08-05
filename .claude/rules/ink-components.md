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
  例外は**中断（`Ctrl+C`）だけ**で、詳細ビューは `pending` ガードより前にこれを処理する（ダイアログの
  `n` は「そのツール1回を断る」だけなので、作業自体をやめる出口が他に無い）。`editText` は ctrl chord を
  無視するので、ダイアログ側の入力とは競合しない。
  例外として**モーダル自身は `useInput` を持つ**（`permission-dialog` / `model-select` / `repo-prompt-editor`）。
  成立条件は「背後の view がモーダル表示中に全キーを飲む」こと（`pending` / `modelSelect` / `promptEdit` の
  ガードが view の `useInput` の先頭にある）。モーダルを増やすときはこのガードを必ず追加する。
  - **モーダルは自分の `useInput` の先頭で `parseSgrMouse` を弾く**。背後の view の先取り解釈は
    自分のハンドラを守るだけで、兄弟の `useInput` には同じ生入力が届く。マウスレポートは
    名前付きキーを持たない**印字可能なテキスト**なので、弾かないと `editText` を通る
    ダイアログ（質問の自由記述・`/prompt` エディタ）にクリックしただけで `[<0;10;5M` が入る。
- **フォーカスモデル**: 一覧画面は `composer`（入力欄・起動時の既定）と `list` の2ゾーン。
  Tab で切替。composer 中は矢印がキャレット移動（`editText` の arrows+vertical）、list 中は
  ↑↓が行選択・Enter/→ が「claude で開く」・m/d がマージ/破棄。list 中に印字キーを打つと
  composer に戻ってそのまま挿入される。選択中セッションの許可/質問ダイアログは
  **list フォーカス時のみ**アクティブ（composer のタイピングを乗っ取らない）。
- **フォーカスに依存しない操作は chord にする**。中断セッションの復帰（`Ctrl+R` = 選択中を再開、
  `Ctrl+A` = 一括再開）と実行中ターンの中断（詳細ビューの `Ctrl+C`）は、フォーカスゾーン／操作
  パネルの状態に関係なく効く。
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
  設定 `"mouse": false` で無効化（有効中は端末の通常ドラッグ選択が奪われるが、入力欄・ヘッダ・
  詳細ビューのログはアプリ側の範囲選択でカバーする。端末ネイティブ選択は Shift+ドラッグで可）。
  **捕捉は起動から終了まで有効のままにする**（画面ごとに enable/disable を切替えない — 切替えの
  境界で端末が送り残したレポート断片が生テキストとして入力欄へ流れ込む）。
- **入力欄の範囲選択コピー**: コンポーザ上のドラッグ（press=アンカー→drag=終点→release）で
  範囲選択し、離した時点で **1 回だけ** クリップボードへコピー（`utils/clipboard.ts` の
  OSC 52。SSH 越しでも動く）。選択の純粋ロジックは `core/text-selection.ts`
  （`normalizeSelection`/`selectionText`/`lineSelection`）、状態管理は共有フック
  `useDragSelection`（`ui/hooks.ts`、コピー関数は DI）。ハイライト描画は `PromptInput`
  の `selection` prop（選択中は block caret を出さない）。press→drag→release の機械そのものは
  内部の `useRangeSelection`（位置の型と正規化だけ差し替える）で、ログ用の `useLogDragSelection`
  と共用する。コピー関数は合成ルート
  （`index.tsx`→`App`→両 view の `onCopy`）で注入する（ui は utils を直接 import しない）。
  ドラッグごとに送らない（再描画毎コピーは他 TUI で既知のバグ）。
  - **`PromptInput` を持つモーダルにも同じ選択を載せる**（`/prompt` の `RepoPromptEditor`）。
    エディタは `.codiva/prompt.md` のビューアも兼ねるので、読んだ内容を持ち出せないと入力欄と
    体験が食い違う。当たり判定は自分で実測した Box（`useAbsolutePosition` + `useComposerWidth`）
    から `caretIndexAtClick` で逆算する（端末幅からは求まらない）。
  - **選択中はキャレットを動かさない**。`PromptInput` の表示ウィンドウ（`visibleLineRange`）は
    **キャレット行から決まる**ので、press / drag でキャレットを動かすと `INPUT_MAX_ROWS` を
    超える内容では画面がその場でスクロールし、描かれている行と当たり判定が食い違って
    「触っていない行」がコピーされる。キャレットを置くのは**ドラッグにならずに離したとき
    （= 単なるクリック）だけ**にする（press/drag/release の各 index は ref に持って比較する）。
  - **描いた行数を実測高さで検算する**。縦に潰れて行が抜けている（実測高さ < 描いた行数）間は
    当たり判定そのものをやめる（ヘッダの `headerHeight < lines.length` と同じ方針）。前段として
    `DialogBox` に `flexShrink={0}` があり、潰れる役は内部スクロールを持つ領域（一覧・ログ）に寄せる。
  - **モーダルを開いている間は背後の view がマウスレポートも飲む**。`parseSgrMouse` で弾くのは
    自分のハンドラを守るだけで、同じ生入力は兄弟の `useInput` にも届く。飲まないと、モーダル上の
    1 回のドラッグでヘッダや一覧の選択まで動く（`session-list.tsx` の `update || modelSelect ||
    promptEdit` ガード）。
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
- **入力履歴は表示行の端でだけ ↑↓ を奪う**。一覧のコンポーザは `↑`（最上段の表示行）/ `↓`（最下段）で
  送信済みの指示を呼び戻す（shell と同じ慣習）。判定・保持は純粋な `core/input-history.ts`
  （`recallPrev` / `recallNext` / `recordInput`）+ 共有フック `useInputHistory`、端かどうかは
  `atFirstComposerRow` / `atLastComposerRow`（折り返し後の**表示行**で数える）。行の途中で履歴に
  化けさせないのが要点で、呼び出せないとき（履歴なし・最古・辿っていないのに ↓）は undefined を
  返して**従来のキャレット移動へ落とす**。履歴は一覧が再マウントされても消えないよう `ListViewState`
  に載せて親（`app.tsx` の ref）へ預ける。**詳細ビューには入れない** — あちらの ↑↓ はログのスクロール
  （マウス無効環境ではホイールの受け口も兼ねる）なので、奪うとログがスクロールできなくなる。
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
- **`Ctrl+C` は実行中のターンの中断**（`manager.interrupt(id)`。Claude Code と同じ操作）。Ink は
  `exitOnCtrlC: false` なのでアプリ終了ではなくこのハンドラへ届く。破棄ではないので案内文（`detail.cancelHint`）
  は「あとで再開できる」ことを伝え、中断後は同じ行が `resume.oneKeyHint` に入れ替わる。対象判定
  （連打の吸収）は core 側（`SessionManager.interrupt`）に置く — ここの `status` はスロットルされた
  購読値なので「もう中断済み」を同期的に知らない（`resume` と同じ）。
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
- スクロール操作は **PgUp/PgDn（半画面）** と **↑/↓（1行 = `ARROW_SCROLL_LINES`）** と
  ホイール（`WHEEL_SCROLL_LINES`）。**マウスレポートは useInput の先頭で `parseSgrMouse` に
  先取り解釈させる**（一覧と同じ。これをしないとエスケープ列が生テキストとしてコンポーザへ入る）。
  複数行を編集中のみ ↑/↓ はキャレット移動を優先する。マウス無効環境（設定 `"mouse": false` /
  非 TTY）では alt screen の端末がホイールを ↑/↓ に変換して送ってくる（alternate scroll mode）ので、
  ↑/↓ はその受け口も兼ねる。
- **詳細ビューでもマウス捕捉は解除しない**（かつては `mouse.disable()` でネイティブ選択に
  任せていたが、それでは「画面外まで続くログ」を選べない）。ログの範囲選択はアプリ側で持つ:
  - **選択の位置は「文書の表示行 index + 行内の桁」**（`core/log-selection.ts` の `LogPoint`）。
    コンポーザ/ヘッダのような平坦な caret index にしないのは、(1) 行 index はスクロールしても
    意味が変わらないので**可視域の外まで選択を伸ばせる**、(2) 数千行を 1 本の文字列へ連結して
    数え直すと描画が O(n^2) になる、の 2 点。末尾への追記でも既存行の index はズレない。
  - **当たり判定は描画に使った実測値と同じウィンドウから組む**（`LogViewport` = 実測の
    top/left/height + 実際に描いた `logWindow` の `hiddenAbove`/行数 + プレビュー行の有無）。
    ビューポートは**末尾寄せ**なので、行数が高さに足りないぶんの隙間は上に空く（`contentTop`）。
    実測前・インライン描画時は `logView` を undefined にして**当たり判定自体をやめる**
    （黙って別の行を選ぶより選べないほうがよい。ヘッダと同じ方針）。
  - **可視域の外へドラッグしたら自動スクロール**（`logEdgeAt` → `edgeStep`）。1 tick = 1 行で、
    終点は**スクロール後の**端の行（`logEdgePoint`）に置く。SGR ?1002 は**セルが変わったときだけ**
    移動を報告するので、端で静止していても続けるには**タイマー**（`LOG_EDGE_SCROLL_MS`）が必要。
    タイマーは向きが変わったときだけ張り替え、最新のステップ関数は ref で渡す（ログの追記ごとに
    作り直すと 1 tick も進まない）。press / release / キー入力で必ず止める。
  - **スクロール位置（アンカー）は ref にも持つ**。理由は「同期的に読めること」: 自動スクロールの
    1 tick は次のアンカーから選択の終点（`logEdgePoint`）を組み、さらに「動かなかったか」で
    タイマーを止める判定をするので、`setAnchor(fn)` の関数形（次の描画まで値が見えない）では書けない。
    ref なら 1 チャンクにまとまって届いた複数レポートも順に積める（`bufferRef` と同じ形）。
  - **端末幅が変わったら選択を捨てる**。再折り返しで行 index の指す文字が変わるため（ヘッダの
    スナップショット比較と同じ趣旨。ログは追記では崩れないので幅だけ見る）。
  - ハイライトは行ごとに `logRowSelection` で `[from, to)` を出し、**選択境界でスパンを切り直して**
    描く（純粋な `selectionSlices`。ヘッダの `rowPieces` と共用）。反転する片では dim を落とす。
    1 行ぶんの描画は `ui/log-line.tsx`（`LogLine` / kind ごとの prefix と dim）に分けてある。
  - **press の当たり判定**: 行の上ならその文字（行末より右は**行末に丸める** — ログ領域には他の
    当たり判定が無いので、短い行の右からドラッグを始める操作を受ける）。**行より上の余白**
    （ログが可視域に満たないときの末尾寄せの隙間・上パディング）は**先頭行の行頭**をアンカーに
    する（「画面のいちばん上から下へ」のドラッグを捨てない）。行より下（プレビュー行・操作パネル側）は
    当たりにしない。ヘッダの `'reject'` と違い横方向で拒否しないのは、ここが全面ログだから。
  - **行数はアンカーの関数**（プレビュー行は末尾追従中だけ描く）。自動スクロールの終点は
    **スクロール後のアンカー**で数え直す（`capFor(next)`）— `logCap` のままだと末尾追従を
    外れた瞬間に 1 行増えるぶん、上端の 1 行が選択から漏れる。
- **折り返し・幅・クリック位置の逆算は必ず同じ単位（グラフェム）で数える**。共有の
  分割器は `core/graphemes.ts` の `GRAPHEMES` で、`wrapDisplayLines` / `wrapRichLine` /
  `caretIndexForColumn` / `charIndexAtColumn` が全部これを通る。コードポイント単位で
  数えると `stringWidth` と食い違う: `⚠️`（U+26A0 + U+FE0F）は 1 グラフェム = 2 セルだが、
  コードポイントごとに測ると 1 + 0 = 1 セルになる。この 1 セルのズレで**クリックした文字と
  当たった文字が違う**（実際に URL の手前の空白でブラウザが開き、URL の最後の文字は
  反応しなかった）。加えてグラフェムの途中に caret が入り、`slice` した選択が壊れた
  絵文字を含む。**「幅を別に測って比べる」もしない** — 判定と逆算を別々の測り方で
  やると同じズレが再発するので、1 回の走査で両方出す（`charIndexAtColumn`）。

- **ログ内の URL は codiva 自身がクリックを取って開く**（端末の Cmd+click に任せない）。
  理由は主端末の Ghostty が**マウスレポート中はリンク検出そのものを止める**こと
  （`Surface.zig` が `mouse_event != .none` でホバー判定を skip する）と、SGR マウス
  レポートに **Cmd/Super のビットが無い**こと（修飾は shift=4 / alt=8 / ctrl=16 だけ。
  しかも bit 8 は Ghostty では Option、iTerm2 では Cmd と**端末で意味が違う**）。
  結果、全端末で同じに動く経路は「素のクリック（press → 動かさず release）」だけになる。
  - **リンク範囲は行に持たせる**（`DisplayLine.links` = `core/url.ts` の `LinkRange[]`）。
    テキストから URL を引き直さないのは、(1) Markdown の `[label](url)` は**見えているのが
    label** なので復元できない（href は `RichSpan.link` で運ぶ）、(2) 折り返しで割れた
    半分は URL として解析できない、の 2 点。範囲なら**両方の行が URL 全体を指せる**ので
    どちらをクリックしても同じ先へ飛ぶ。検出は必ず**論理行**に対して行い、
    `linksInSlice` で各物理行の座標（prefix / 字下げのぶんずらす）へ移す。
  - **press では開かず、release で開く**。press した位置の URL を ref に保留し、
    `drag` が来たら取り消す。押した時点で開くと、URL の上からドラッグして範囲選択を
    始めるたびにブラウザが立ち上がる。
  - **副作用のある操作は左ボタンだけ**（`MouseEvent.button`）。右クリック（端末の
    コンテキストメニューを期待した操作）や中クリック（貼り付け）でブラウザを開かない。
    選択・フォーカス移動は無害なのでどのボタンでも受けてよい。
  - **モーダル表示中は詳細ビューもマウスレポートを飲む**（`modelSelect || pending` で
    早期 return。一覧と同じ）。飲まないと許可待ちのダイアログの上での 1 クリックで
    背後のログの選択が動き、URL の上ならブラウザまで開く。
  - **当たり判定は行末で丸めない**（`logLinkAt` は `column >= stringWidth(text)` を弾く）。
    選択のアンカー（`logCaretAt`）は短い行の右の余白からドラッグを始めたいので丸めてよいが、
    リンクを丸めると URL で終わる行の**右の余白をクリックしただけで開く**。
  - **OSC 8 は描画時にだけ混ぜる**（`ui/log-line.tsx` の `linkedText`）。`LogEntry.text` /
    `RichSpan.text` に入れると `wrapDisplayLines` / `wrapRichLine` が**エスケープを可視幅として
    数える**ので折り返しが壊れ、URI が行の途中で断ち切られる（実測: 幅 20 で 4 行に割れた）。
    パラメータ形（`id=`）は使わない（wrap-ansi 10 が壊す）。Ink 7 の計測・再構築
    （string-width / slice-ansi / ansi-tokenize ≥0.3）は OSC 8 を幅 0 として扱うので安全。
  - 選択境界とリンク境界は直交するので、**純粋な関数で 2 段に切る**
    （`linkPieces` → `selectionSlices`）。片方だけで切ると、選択がリンクの途中で
    終わったときにどちらかのスタイルが行全体へ漏れる。
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
- **毎フレーム変わる文字列は「実際に描く幅」に切ってから `<Text>` に渡す**。Ink は測った
  文字列を**プロセスグローバルな上限なしキャッシュ**へ永久に積む（`ink/build/measure-text.js`
  の `new Map()` と `wrap-text.js` の `{}`。キーはテキスト全文で evict が無い）。実測で
  約 100 文字の行 1 本 = 約 1.7KB、**4,000 文字の `<Text>` 1 描画 = 約 17.8KB** が解放されずに残り、
  ストリーミングプレビューをそのまま渡していたことで約 640MB/時 まで伸びていた。
  `wrap="truncate-end"` は**描画時に切るだけ**でキャッシュのキーは切る前の文字列なので、
  それだけでは効かない（`streamTail(text, width)` のように渡す文字列自体を短くする）。
  幅は**ログ行の折返しと同じ値**を使う（食い違うと 1 行に収まらずビューポートの予約行数とズレる）。
- **`src/index.tsx`（起動シム）に static import を書かない**。ESM の static import は巻き上げられて
  本文より先に評価されるため、1 本足すだけで `NODE_ENV=production` の代入が間に合わなくなり、
  react-reconciler が dev ビルドになる。dev ビルドは**レンダーごとに `performance.measure()` を
  3 本積み**、Node の user timing は自動で捨てられないので、描画内容に関係なく
  約 2,230 B/フレーム（≒86MB/時）でヒープが増え続ける（実測。これで 3 回 OOM した）。
  番人は `tests/entry-shim.test.ts`。保険の定期掃除は `bootstrap/perf-timeline.ts`。

## 対象外

- Storybook（Ink には非適用）。UI テストは `ink-testing-library` + vitest で行う。
- Web 向けデザインスキル（Tailwind/Radix/フォント選定等）は端末 UI に不要。
