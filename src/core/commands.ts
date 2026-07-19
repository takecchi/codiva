/**
 * コンポーザに入力されたスラッシュコマンドの解析（純粋）。
 *
 * 現状は `/model`（モデル切替ダイアログを開く）のみ。コマンドは行全体が
 * 一致した場合のみ成立させ、通常の指示文（例: "implement /model page"）を
 * 誤ってコマンド扱いしないようにする。
 */

export type SlashCommand = 'model';

/**
 * 入力テキストがスラッシュコマンドなら対応する種別を、そうでなければ null を返す。
 * 前後空白は無視し、大文字小文字は区別しない（`/MODEL` も可）。
 */
export function parseSlashCommand(text: string): SlashCommand | null {
  return text.trim().toLowerCase() === '/model' ? 'model' : null;
}
