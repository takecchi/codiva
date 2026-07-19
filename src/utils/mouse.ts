/**
 * SGR マウスレポートの有効化/無効化。?1000（ボタンイベント）+ ?1006（SGR 形式）
 * のみを使い、モーション追跡は要求しない。有効中は端末のテキスト選択が通常の
 * ドラッグでできなくなる点に注意（多くの端末では Shift+ドラッグで可能）。
 * 解析は純粋な core/mouse.ts の parseSgrMouse が行う。
 */
const ENABLE_MOUSE = '\x1b[?1000h\x1b[?1006h';
const DISABLE_MOUSE = '\x1b[?1006l\x1b[?1000l';

/** テストでフェイクを注入できるよう、必要な write だけに絞ったストリーム型。 */
export interface MouseStream {
  write(text: string): unknown;
}

/**
 * マウスレポートを有効化し、無効化する関数を返す。disable は冪等。
 * クラッシュ時に端末へレポートモードを残さないよう exit にも保険で登録する。
 */
export function enableMouse(stream: MouseStream = process.stdout): () => void {
  stream.write(ENABLE_MOUSE);
  let disabled = false;
  const disable = (): void => {
    if (disabled) {
      return;
    }
    disabled = true;
    process.removeListener('exit', disable);
    stream.write(DISABLE_MOUSE);
  };
  process.on('exit', disable);
  return disable;
}
