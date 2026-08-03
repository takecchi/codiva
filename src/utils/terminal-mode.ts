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
 * 端末を「codiva が何も設定していない状態」へ戻す一括リセット列。
 *
 * `toggleEscape` の teardown は個別のモードを戻すが、プロセスが**強制終了**した
 * （OOM の abort / SIGKILL / segfault）ときは `process.on('exit')` すら走らないため、
 * マウスレポートが有効なまま残る。その端末でスクロールすると `\x1b[<64;…M` が
 * 送られ続け、シェルには大量の文字が入力されたように見える。次の起動時と
 * `codiva --reset-terminal` でこの列を送って復旧する。
 *
 * 内容は「マウスレポート全モード off（?1000/?1002/?1003 と SGR/urxvt 拡張の
 * ?1006/?1015）→ bracketed paste off → カーソル表示 → alt screen 退出」。
 * 有効でないモードへの off は no-op なので、何度送っても安全。
 */
const RESET_TERMINAL =
  '\x1b[?1006l\x1b[?1015l\x1b[?1003l\x1b[?1002l\x1b[?1000l\x1b[?2004l\x1b[?25h\x1b[?1049l';

/** 上記のリセット列を書き込む（冪等。TTY 以外へは呼び出し側が送らない）。 */
export function resetTerminalModes(stream: WritableLike = process.stdout): void {
  stream.write(RESET_TERMINAL);
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
