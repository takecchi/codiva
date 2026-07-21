import { toggleEscape, type WritableLike } from './terminal-mode';

/**
 * SGR マウスレポートの有効化/無効化。?1002（ボタンイベント + ドラッグ中の
 * モーション追跡）+ ?1006（SGR 形式）を使う。?1002 はボタン押下中の移動も
 * 報告するので、コンポーザ内のドラッグを検知して範囲選択→クリップボードへ
 * コピーできる（`ui/hooks.ts` の useComposerSelection）。有効中は端末の通常
 * ドラッグ選択が奪われるが、アプリ側の選択コピーで代替する（多くの端末では
 * Shift+ドラッグで端末ネイティブ選択も可能）。解析は純粋な core/mouse.ts の
 * parseSgrMouse が行う。無効化は保険で ?1000l も送る（過去モードの取り残し対策）。
 */
const ENABLE_MOUSE = '\x1b[?1002h\x1b[?1006h';
const DISABLE_MOUSE = '\x1b[?1006l\x1b[?1002l\x1b[?1000l';

export type MouseStream = WritableLike;

/** マウスレポートを有効化し、無効化する関数を返す（冪等・exit 保険付き。terminal-mode 参照）。 */
export function enableMouse(stream: MouseStream = process.stdout): () => void {
  return toggleEscape(ENABLE_MOUSE, DISABLE_MOUSE, stream);
}
