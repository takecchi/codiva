import { toggleEscape, type WritableLike } from './terminal-mode';

/**
 * SGR マウスレポートの有効化/無効化。?1000（ボタンイベント）+ ?1006（SGR 形式）
 * のみを使い、モーション追跡は要求しない。有効中は端末のテキスト選択が通常の
 * ドラッグでできなくなる点に注意（多くの端末では Shift+ドラッグで可能）。
 * 解析は純粋な core/mouse.ts の parseSgrMouse が行う。
 */
const ENABLE_MOUSE = '\x1b[?1000h\x1b[?1006h';
const DISABLE_MOUSE = '\x1b[?1006l\x1b[?1000l';

export type MouseStream = WritableLike;

/** マウスレポートを有効化し、無効化する関数を返す（冪等・exit 保険付き。terminal-mode 参照）。 */
export function enableMouse(stream: MouseStream = process.stdout): () => void {
  return toggleEscape(ENABLE_MOUSE, DISABLE_MOUSE, stream);
}
