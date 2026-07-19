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
