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
