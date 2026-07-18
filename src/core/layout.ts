import type { LogEntry } from './types';

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
 * 詳細ビューの末尾ビューポートへ渡すログ行。画面には端末の行数ぶんしか映らない
 * ため末尾 rows 件に絞り、Ink の描画ノード数に上限を掛ける。rows が 0 以下でも
 * 最新 1 件は返す（slice(-0) が全件になる事故の防止）。
 */
export function tailMessages(messages: LogEntry[], rows: number): LogEntry[] {
  return messages.slice(-Math.max(1, rows));
}
