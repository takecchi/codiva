import { visibleLineRange } from './text-buffer';

/**
 * 全画面レイアウトに必要な最小の端末行数。固定部分（ヘッダ = マスコットの 6 行 +
 * 入力欄3行 + フッタ・余白・パディング）だけで約15行あり、これ未満で root の height を
 * 固定するとクリップで入力欄やフッタが消えて操作不能になる。
 *
 * ヘッダはこれより高くなりうる（使用状況の枠が増える・学習データ利用の警告が出る）が、
 * ヘッダ自身は縮んで下段 UI に場所を譲るので閾値はマスコットの高さで足りる。
 */
export const MIN_FULLSCREEN_ROWS = 16;

/**
 * 端末の行数で全画面レイアウト（root の height 固定 + 超過クリップ）を使うか判定する。
 * 閾値未満は従来どおりのインライン描画（コンテンツ高さぶん描画し、溢れは端末の
 * スクロールに任せる）へフォールバックする。
 */
export function isFullscreenViewport(rows: number): boolean {
  return rows >= MIN_FULLSCREEN_ROWS;
}

/**
 * 一覧の行に worktree（ブランチ）名の列を出すのに必要な最小の端末桁数。これ未満だと
 * caret/attention/title/badge/model/elapsed/PR の固定・準固定列だけで幅が埋まり、
 * ブランチ列を出すと title が過度に切り詰められる。狭い端末ではブランチ列ごと省く。
 */
export const MIN_BRANCH_COLUMN_COLUMNS = 80;

/**
 * 端末の桁数で一覧に worktree（ブランチ）名の列を表示するか判定する純関数。
 * 閾値未満ではブランチ列を省き、title に幅を譲る。
 */
export function showsBranchColumn(columns: number): boolean {
  return columns >= MIN_BRANCH_COLUMN_COLUMNS;
}

/**
 * 一覧のエージェント列の幅（セル）。表示名（`Claude` / `Codex` / `Grok`）は最長 6 セルで、
 * 右に 1 セルの間隔を足した固定幅列。
 */
export const AGENT_COLUMN_WIDTH = 6;

/** エージェント列が行から奪う幅（列 + 右の間隔）。ブランチ列の判定から差し引く。 */
export const AGENT_COLUMN_CELLS = AGENT_COLUMN_WIDTH + 1;

/**
 * エージェント列を出すのに必要な最小の端末桁数。ブランチ列（80 桁）より緩いのは、
 * こちらは**混在しているときだけ**出る列で、狭ければブランチ列を先に落として席を作れるから。
 */
export const MIN_AGENT_COLUMN_COLUMNS = 60;

/**
 * 一覧の行にエージェント名の列を出すか判定する純関数。`mixed` は
 * `usesMultipleAgents(sessions)`（`core/agent-display.ts`）。
 *
 * 全部同じ provider なら出さない: 既定のエージェントはヘッダに出ているので、
 * 同じ名前を全行に並べても情報が増えないのに title / branch から幅を奪う。
 */
export function showsAgentColumn(columns: number, mixed: boolean): boolean {
  return mixed && columns >= MIN_AGENT_COLUMN_COLUMNS;
}

/**
 * ヘッダ（`ui/banner.tsx`）の使用状況ゲージ以外に 1 行が使う幅の見積り（ja の最長ケース）:
 * マスコット 15 + 余白 2 + 一覧のパディング 2 + 行頭のインデント 2 + 見出し 16
 * （`現在のセッション`）+ 余白 2 + 使用率 4 + 余白 2 + 残り時間 21（`3日23時間後にリセット`）。
 */
const BANNER_USAGE_FIXED_CELLS = 68;

/** ヘッダの使用状況ゲージの幅の段階（広い順）。1 セル ≒ 5% / 8% / 12% で読める。 */
const BANNER_GAUGE_STEPS = [20, 12, 8] as const;

/**
 * 端末桁数からヘッダの使用状況ゲージの幅（セル）を決める純関数。`0` はゲージを出さない
 * （使用率と残り時間だけにする）。
 *
 * `showsBranchColumn` と同じ幅ベースの段階的縮退だが、こちらは**枠を落とさずゲージだけを
 * 縮める** — ヘッダは枠を並べて比べる場所なので、行数を減らすより 1 行を短くするほうが
 * 情報が残る。ゲージを縮めないと最長ケースで 87 桁必要になり、80 桁の端末でヘッダ全体が
 * 縮められてマスコットが折り返す（実際に起きた）。
 */
export function bannerGaugeWidth(columns: number): number {
  return BANNER_GAUGE_STEPS.find((width) => columns >= BANNER_USAGE_FIXED_CELLS + width) ?? 0;
}

/**
 * ダイアログ（`ui/dialog-box.tsx` と同じ枠を持つオーバーレイ）が本文に使えない横幅:
 * ビューの padding 1×2 + 枠線 1×2 + ダイアログの paddingX 1×2 = 6 セル。
 */
export const DIALOG_CHROME_COLUMNS = 6;

/**
 * 端末桁数からダイアログ本文に使える表示幅を求める純関数。選択肢のラベル・説明を
 * **折返して全文出す**ための折返し幅として使う（`core/choice-lines.ts`）。
 *
 * Yoga は溢れた子を縮めるため、幅を渡さずラベルと説明を 1 行に並べると両方が
 * 途中で切れる。折返し幅を端末から自前で出しておけば、枠の内側に収まる行だけを
 * 描くことになり切り捨てが起きない。下限を持たせているのは極端に狭い端末で
 * 1 セルずつ折り返して縦に爆発させないため（そこまで狭ければ多少の溢れは許容する）。
 */
export function dialogContentWidth(columns: number): number {
  return Math.max(10, columns - DIALOG_CHROME_COLUMNS);
}

/**
 * 詳細ビューでログ以外に消費される固定の縦幅の見積り: 上下パディング 2 +
 * 状態行 1（プレビュー / スクロール案内 / 空行。**常に 1 行**）+ 操作ヒント行 1
 * （Ctrl+C / 再開 / 空行。同じく常に 1 行）+ 入力欄 3（上下ボーダー付き）+ フッタ 1。
 *
 * どちらの 1 行も条件付きにしない（出し入れするとログの高さが変わり、見えている
 * ログ全体が跳ねる = スクロールがガクガクする。`core/scroll.ts` の `LogStatusRow`）。
 * おかげでこの見積りは実測と一致するが、PR サマリ等の任意表示が出るぶん**過大評価に
 * ならない**ことのほうが重要: 過大だとログ行を可視域より多く描いてしまい、Yoga が
 * 溢れた子を「クリップ」ではなく「縮小」するため行が虫食いで欠落する。実測できる
 * 場合は `ui/hooks.ts` の `useBoxHeight` を優先し、これは初回描画までのフォールバック。
 */
export const DETAIL_CHROME_ROWS = 8;

/**
 * 詳細ビューで実際にログが見える行数のおおよその見積り。端末全体の rows から
 * 固定 chrome を引く。ページスクロールの移動量（`scroll.ts` の `pageStep`）を
 * この可視高さから導くことで「一度に画面外の行を飛び越える」のを防ぐ。
 */
export function logViewportRows(rows: number): number {
  return Math.max(1, rows - DETAIL_CHROME_ROWS);
}

/**
 * 一覧ビューでセッション行以外に消費される固定の縦幅（バナー + 余白 + 入力欄 +
 * フッタ）のおおよその見積り。`logViewportRows` の一覧版 `listViewportRows` が
 * この値を使い、行リストが内部スクロールで収まる高さを端末 rows から導く。
 */
export const LIST_CHROME_ROWS = 15;

/**
 * ヘッダ（マスコット + 前後の余白）が使う縦幅。`/help` の一覧はヘッダを隠して
 * その場所を使うので、確保済み chrome から差し引くために切り出してある。
 */
export const BANNER_ROWS = 7;

/**
 * 一覧で実際にセッション行を描ける行数のおおよその見積り。端末全体の rows から
 * 固定 chrome を引く（実測できないときのフォールバック。通常は行ボックスの実測
 * 高さを優先する）。
 */
export function listViewportRows(rows: number): number {
  return Math.max(1, rows - LIST_CHROME_ROWS);
}

/**
 * コマンドパレット（`ui/command-palette.tsx`）が枠と見出しに使う縦幅: 枠線 2 + 見出し 1。
 * 溢れたときの「他 N 件」行は**コマンド行の枠内**に収める（listView のインジケータと
 * 同じ考え方で、出しても総行数が変わらないようにする）。
 */
export const PALETTE_CHROME_ROWS = 3;

/** パレットに必ず残すコマンド行数（極端に低い端末でも 0 行にしない）。 */
export const PALETTE_MIN_ROWS = 3;

/** 詳細ビューでパレットの下に残すログの行数（全部パレットに使わせない）。 */
const PALETTE_LOG_RESERVE = 3;

/**
 * パレットに描いてよいコマンド行数を端末高から求める純関数。溢れる分は呼び出し側が
 * 「他 N 件」の 1 行に畳む（`CommandPalette` の `maxRows`）。
 *
 * 畳まないと Yoga がパレットの枠自体を**縮める**（クリップではなく行が潰れて混ざる）。
 * 実際、コマンドが 14 個になった時点で 24 行の端末では `/help` の行が消え、フッタと
 * `/exit` が重なって描かれた。`flexShrink={0}` は「縮む役を他へ回す」だけなので、
 * 他が全部最小まで縮んだあとはパレット自身が潰れる = 行数を自分で抑える必要がある。
 *
 * `view` で確保済みの chrome が変わる:
 * - `'list'` … ヘッダ + 入力欄 + フッタ（`LIST_CHROME_ROWS`）
 * - `'help'` … `/help` の全一覧。**ヘッダを隠して場所を空ける**ので、その 7 行が戻る
 * - `'detail'`… 詳細ビュー（`DETAIL_CHROME_ROWS`）+ ログを数行残す
 */
export function paletteMaxRows(rows: number, view: 'list' | 'help' | 'detail'): number {
  const reserved =
    view === 'list'
      ? LIST_CHROME_ROWS
      : view === 'help'
        ? LIST_CHROME_ROWS - BANNER_ROWS
        : DETAIL_CHROME_ROWS + PALETTE_LOG_RESERVE;
  return Math.max(PALETTE_MIN_ROWS, rows - reserved);
}

/** 入力欄（`ui/prompt-input.tsx`）が最小構成で使う縦幅: 上下の罫線 2 + 1 行。 */
export const COMPOSER_ROWS = 3;

/**
 * 許可/質問ダイアログが出ているあいだ、その下に**必ず残す**行数（詳細ビューは会話ログ、
 * 一覧ビューはセッション行）。
 *
 * ダイアログはログの兄弟で `flexShrink={0}` なので、縦に伸びたぶんは `flexGrow` の
 * ログ領域から丸ごと奪われる。実測（幅 100 桁・選択肢 4 件 + 説明）で 24 行の端末では
 * **ログの可視行が 0** になり、`Tab: ログを遡る` に切り替えても何も見えなかった
 * （= 質問の背景を読めないまま答えることになる）。ここで席を確保して、溢れるぶんは
 * ダイアログ側の内部スクロール（`core/choice-lines.ts` の `choiceView`）に押し出す。
 */
export const DIALOG_CONTENT_RESERVE = 5;

/** ダイアログに必ず与える縦幅（見出し + 質問 + 選択肢数行 + 相談する + ヒント + 枠）。 */
export const DIALOG_MIN_ROWS = 12;

/** ダイアログの選択肢ブロックに必ず残す行数（カーソルの件が見えなくならないように）。 */
export const DIALOG_CHOICE_MIN_ROWS = 3;

/**
 * 許可/質問ダイアログ（`ui/permission-dialog.tsx`）が使ってよい縦幅（**枠線を含む**）を
 * 端末高から求める純関数。`paletteMaxRows` と同じ考え方で、下に残す領域
 * （{@link DIALOG_CONTENT_RESERVE}）を先に取り分ける。
 *
 * ダイアログは入力欄の位置に出る（入力欄は消える）ので、確保済み chrome から
 * その 3 行（{@link COMPOSER_ROWS}）を戻して数える。
 */
export function dialogMaxRows(rows: number, view: 'list' | 'detail'): number {
  const chrome = view === 'detail' ? DETAIL_CHROME_ROWS : LIST_CHROME_ROWS;
  return Math.max(DIALOG_MIN_ROWS, rows - (chrome - COMPOSER_ROWS) - DIALOG_CONTENT_RESERVE);
}

/**
 * セッション一覧を高さ `cap` 行のウィンドウに収めるための表示範囲。
 * 一覧がヘッダ/フッタの間で内部スクロールするときに使う純粋な計算。
 */
export interface ListView {
  /** 表示する最初の項目インデックス（含む） */
  start: number;
  /** 表示する最後の項目インデックスの次（含まない） */
  end: number;
  /** ウィンドウより上に隠れている項目数 */
  hiddenAbove: number;
  /** ウィンドウより下に隠れている項目数 */
  hiddenBelow: number;
  /** 上端に「さらに N 件」インジケータ行を出すか */
  showAbove: boolean;
  /** 下端に「さらに N 件」インジケータ行を出すか */
  showBelow: boolean;
}

/**
 * `total` 件のうち `cap` 行に収まる表示範囲を、`selected` を常に見える位置に
 * 保ちながら求める。項目が溢れる端には「さらに N 件」インジケータ用に 1 行を
 * 予約するため、描画行数（項目 + インジケータ）は常に `cap` 以下になる。
 * 選択はウィンドウ下端寄りにアンカーする（下へ動かすとスクロールする挙動。
 * コンポーザの {@link visibleLineRange} と同じ）。
 *
 * ただし端に隠れているのが 1 件だけの場合は、インジケータ（「他 1 件」）を出さず
 * その項目自体を表示する。インジケータも実項目も 1 行なので描画行数は変わらず、
 * 「1 件を隠して代わりに 1 行のインジケータを出す」より実項目を見せたほうがよい
 * （下から 2 番目を選ぶと最後の 1 件が「↓ 他 1 件」に化ける、を防ぐ）。
 */
export function listView(total: number, selected: number, cap: number): ListView {
  const c = Math.max(1, Math.floor(cap));
  if (total <= c) {
    return {
      start: 0,
      end: total,
      hiddenAbove: 0,
      hiddenBelow: 0,
      showAbove: false,
      showBelow: false,
    };
  }
  const sel = Math.max(0, Math.min(selected, total - 1));
  // 溢れる端ごとにインジケータ 1 行を予約するが、その予約でウィンドウが縮むと
  // 別の端が新たに溢れることがある（縮小は隠れ項目を増やすだけなので単調）。
  // 予約は増やす方向にのみ更新して不動点まで反復する（最大 3 周で収束）。
  let above = false;
  let below = false;
  let win = { start: 0, end: 0 };
  for (let i = 0; i < 3; i++) {
    // インジケータで席を使い切らないよう、内容行を必ず 1 行は残す。
    const reserved = Math.min((above ? 1 : 0) + (below ? 1 : 0), c - 1);
    win = visibleLineRange(total, sel, c - reserved);
    const nextAbove = win.start > 0;
    const nextBelow = win.end < total;
    if (nextAbove === above && nextBelow === below) {
      break;
    }
    above = above || nextAbove;
    below = below || nextBelow;
  }
  // 極端に低い cap では両方は出せない。内容行を守るため下インジケータから捨てる。
  const rows = win.end - win.start;
  let showAbove = above;
  let showBelow = below;
  while ((showAbove ? 1 : 0) + (showBelow ? 1 : 0) > c - rows) {
    if (showBelow) {
      showBelow = false;
    } else {
      showAbove = false;
    }
  }
  // 隠れているのが 1 件だけの端は、インジケータ用に予約した 1 行へその項目を
  // 直接出す（描画行数は不変）。両端が同時に 1 件になることは overflow 時には
  // 起きない（それは total === cap を意味し、その場合は上で早期 return 済み）。
  let start = win.start;
  let end = win.end;
  if (showBelow && total - end === 1) {
    end += 1;
    showBelow = false;
  }
  if (showAbove && start === 1) {
    start -= 1;
    showAbove = false;
  }
  const hiddenAbove = start;
  const hiddenBelow = total - end;
  return {
    start,
    end,
    hiddenAbove,
    hiddenBelow,
    showAbove: showAbove && hiddenAbove > 0,
    showBelow: showBelow && hiddenBelow > 0,
  };
}
