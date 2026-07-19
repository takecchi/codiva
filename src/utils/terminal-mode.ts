/** テストでフェイクを注入できるよう、必要な write だけに絞ったストリーム型。 */
export interface WritableLike {
  write(text: string): unknown;
}

/**
 * ある端末モードへ入り、抜けるための関数を返す共通ヘルパ。`enter` を書き込み、
 * 返り値を呼ぶと `leave` を書き込む（冪等）。クラッシュ（uncaughtException 等）で
 * 明示 leave を通らなくても端末をそのモードに取り残さないよう、process の exit
 * イベントにも保険で登録し、leave 時に解除する。alt screen とマウスレポートの
 * 有効化/無効化はどちらもこの形なので共通化している。
 */
export function toggleEscape(
  enter: string,
  leave: string,
  stream: WritableLike = process.stdout,
): () => void {
  stream.write(enter);
  let done = false;
  const teardown = (): void => {
    if (done) {
      return;
    }
    done = true;
    process.removeListener('exit', teardown);
    stream.write(leave);
  };
  process.on('exit', teardown);
  return teardown;
}
