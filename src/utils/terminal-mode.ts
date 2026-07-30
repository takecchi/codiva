/** テストでフェイクを注入できるよう、必要な write だけに絞ったストリーム型。 */
export interface WritableLike {
  write(text: string): unknown;
}

const ESC = '\x1b';
const ST = `${ESC}\\`;

/**
 * tmux の中では OSC を DCS パススルー（`ESC P tmux; … ESC \`）で包み、内側の ESC を
 * 二重化しないと tmux が食ってしまい外側の端末まで届かない（`allow-passthrough on` が
 * 必要。tmux 3.3 以降は既定で有効）。クリップボード（OSC 52）とデスクトップ通知
 * （OSC 9 / 777 / 99）で同じ処理が必要なのでここに共通化する。
 */
export function wrapForTmux(seq: string): string {
  return `${ESC}Ptmux;${seq.split(ESC).join(`${ESC}${ESC}`)}${ST}`;
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
