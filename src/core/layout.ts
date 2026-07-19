import { visibleLineRange } from './text-buffer';

/**
 * 全画面レイアウトに必要な最小の端末行数。固定部分（バナー6行 + 入力欄3行 +
 * フッタ・余白・パディング）だけで約15行あり、これ未満で root の height を
 * 固定するとクリップで入力欄やフッタが消えて操作不能になる。
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
 * 詳細ビューでログ以外に消費される固定の縦幅（ステータスヘッダ + 余白 + 入力欄 +
 * フッタ）のおおよその見積り。実測値の下限をやや大きめに取る（過小評価すると
 * スクロール1回の移動量が実際の可視ログ高さを超え、未表示の行を飛ばしてしまうため）。
 */
export const DETAIL_CHROME_ROWS = 10;

/**
 * 詳細ビューで実際にログが見える行数のおおよその見積り。端末全体の rows から
 * 固定 chrome を引く。ページスクロールの移動量（`scroll.ts` の `pageStep`）を
 * この可視高さから導くことで「一度に画面外の行を飛び越える」のを防ぐ。
 */
export function logViewportRows(rows: number): number {
  return Math.max(1, rows - DETAIL_CHROME_ROWS);
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
  const hiddenAbove = win.start;
  const hiddenBelow = total - win.end;
  return {
    start: win.start,
    end: win.end,
    hiddenAbove,
    hiddenBelow,
    showAbove: showAbove && hiddenAbove > 0,
    showBelow: showBelow && hiddenBelow > 0,
  };
}
