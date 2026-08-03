/**
 * CLI 引数の解釈（純粋）。codiva は基本的に引数なしで起動する TUI なので、
 * ここで扱うのは TUI を起動しない保守用のフラグだけ。未知の引数は無視して
 * 通常起動する（将来の引数追加で既存の起動が壊れないため）。
 */

/** 起動時に何をするか。 */
export type CliCommand =
  /** 通常の TUI 起動。 */
  | { kind: 'run' }
  /**
   * 端末モード（マウス捕捉・代替スクリーン・カーソル）のリセットだけを行って終了する。
   * codiva が OOM などで**強制終了**すると `process.on('exit')` が走らず、マウス
   * レポート（?1002/?1006）が有効なまま残る。その状態でスクロールすると端末が
   * `\x1b[<64;…M` を送り続け、シェルには大量の文字が入力されたように見える。
   * 復旧のための脱出口（`codiva --reset-terminal`）。
   */
  | { kind: 'reset-terminal' };

const RESET_FLAGS: readonly string[] = ['--reset-terminal', '--reset'];

/** argv（`process.argv.slice(2)` 相当）から起動コマンドを決める。 */
export function parseCliArgs(argv: readonly string[]): CliCommand {
  if (argv.some((arg) => RESET_FLAGS.includes(arg))) {
    return { kind: 'reset-terminal' };
  }
  return { kind: 'run' };
}
