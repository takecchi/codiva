import { toggleEscape, type WritableLike } from './terminal-mode';

/**
 * 代替スクリーンバッファ（alternate screen buffer）の enter/leave。
 * 通常バッファのまま全画面描画するとシェルの過去出力がスクロールバックに残り
 * 上へスクロールできてしまう。alt screen にはスクロールバックが存在しないため、
 * vim / htop と同様にスクロールがロックされ、leave すると元の画面が復元される。
 */
const ENTER_ALT_SCREEN = '\x1b[?1049h';
const LEAVE_ALT_SCREEN = '\x1b[?1049l';

export type AltScreenStream = WritableLike;

/** alt screen に入り、抜けるための関数を返す（冪等・exit 保険付き。terminal-mode 参照）。 */
export function enterAltScreen(stream: AltScreenStream = process.stdout): () => void {
  return toggleEscape(ENTER_ALT_SCREEN, LEAVE_ALT_SCREEN, stream);
}
