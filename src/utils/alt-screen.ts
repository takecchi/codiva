/**
 * 代替スクリーンバッファ（alternate screen buffer）の enter/leave。
 * 通常バッファのまま全画面描画するとシェルの過去出力がスクロールバックに残り
 * 上へスクロールできてしまう。alt screen にはスクロールバックが存在しないため、
 * vim / htop と同様にスクロールがロックされ、leave すると元の画面が復元される。
 */
const ENTER_ALT_SCREEN = '\x1b[?1049h';
const LEAVE_ALT_SCREEN = '\x1b[?1049l';

/** テストでフェイクを注入できるよう、必要な write だけに絞ったストリーム型。 */
export interface AltScreenStream {
  write(text: string): unknown;
}

/**
 * alt screen に入り、抜けるための関数を返す。leave は冪等。
 * クラッシュ（uncaughtException 等）で明示 leave を通らなくても端末を
 * alt screen に取り残さないよう、process の exit イベントにも保険で登録する。
 */
export function enterAltScreen(stream: AltScreenStream = process.stdout): () => void {
  stream.write(ENTER_ALT_SCREEN);
  let left = false;
  const leave = (): void => {
    if (left) {
      return;
    }
    left = true;
    process.removeListener('exit', leave);
    stream.write(LEAVE_ALT_SCREEN);
  };
  process.on('exit', leave);
  return leave;
}
