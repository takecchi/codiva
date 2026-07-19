/**
 * スラッシュコマンドのレジストリと解析（純粋・I/O 非依存）。
 *
 * 入力欄の先頭が `/` のとき、通常の指示ではなくコマンドとして扱う。コマンドは
 * この 1 ファイルの `COMMANDS` に 1 エントリ足すだけで増やせる設計にしている:
 *   1. `CommandAction` に新しい動作を足す（UI 側が switch で受ける）
 *   2. `COMMANDS` に `{ name, action, describe }` を足す
 *   3. `describe` の文言は i18n カタログ（`messages.command`）に置く
 *
 * 解析・照合はここに閉じ込め、実際の副作用（終了・ヘルプ表示など）は UI 層が
 * `CommandAction` を解釈して行う（core は Ink/React に依存しない規約）。
 */

import type { Messages } from './i18n';

/** コマンドが UI に要求する動作。新コマンド追加時はここに足して UI で受ける。 */
export type CommandAction = 'help' | 'exit' | 'model' | 'diff';

/** 1 つのスラッシュコマンドの定義。 */
export interface CommandSpec {
  /** 正式名（先頭スラッシュなし・小文字）。一覧・実行の主キー。 */
  name: string;
  /** 別名（`/? ` = `/help` など）。省略可。 */
  aliases?: readonly string[];
  /** UI が解釈する動作。 */
  action: CommandAction;
  /** パレット/ヘルプに出す 1 行説明（言語カタログから引く）。 */
  describe: (m: Messages) => string;
}

/**
 * 利用可能なコマンド一覧。**コマンドを増やすときはここに 1 エントリ足す。**
 * 表示順はこの配列順。
 */
export const COMMANDS: readonly CommandSpec[] = [
  { name: 'model', action: 'model', describe: (m) => m.command.model },
  { name: 'diff', aliases: ['changes'], action: 'diff', describe: (m) => m.command.diff },
  { name: 'help', aliases: ['?'], action: 'help', describe: (m) => m.command.help },
  { name: 'exit', action: 'exit', describe: (m) => m.command.exit },
];

/** 先頭が `/` ならコマンド入力とみなす（引数の有無は問わない）。 */
export function isCommandInput(value: string): boolean {
  return value.startsWith('/');
}

/** 解析済みコマンド: 名前（小文字）と残り引数（トリム済み）。 */
export interface ParsedCommand {
  /** `/` を除いた最初の語（小文字）。`/` のみなら空文字。 */
  name: string;
  /** 名前以降のテキスト（トリム済み。無ければ空文字）。 */
  args: string;
}

/** `/name args...` を分解する。コマンド入力でなければ null。 */
export function parseCommand(value: string): ParsedCommand | null {
  if (!isCommandInput(value)) {
    return null;
  }
  const rest = value.slice(1);
  const match = rest.match(/\s/);
  const cut = match?.index ?? -1;
  const name = (cut === -1 ? rest : rest.slice(0, cut)).toLowerCase();
  const args = cut === -1 ? '' : rest.slice(cut).trim();
  return { name, args };
}

/** 名前または別名で完全一致するコマンドを返す。 */
export function findCommand(name: string): CommandSpec | undefined {
  return COMMANDS.find((c) => c.name === name || c.aliases?.includes(name));
}

/**
 * 入力中の名前を接頭辞として、前方一致するコマンドをパレット表示用に返す。
 * `/`（名前が空）のときは全コマンド。コマンド入力でなければ空配列。
 */
export function matchCommands(value: string): CommandSpec[] {
  const parsed = parseCommand(value);
  if (!parsed) {
    return [];
  }
  const q = parsed.name;
  if (q === '') {
    return [...COMMANDS];
  }
  return COMMANDS.filter(
    (c) => c.name.startsWith(q) || (c.aliases?.some((a) => a.startsWith(q)) ?? false),
  );
}

/** コマンド実行の解決結果。UI は `run` を受けたら `command.action` で分岐する。 */
export type CommandResult =
  | { kind: 'run'; command: CommandSpec }
  | { kind: 'unknown'; name: string };

/**
 * コマンド入力文字列を解決する。`/` のみ（名前が空）は help 扱いにして、誤爆で
 * unknown エラーを出さない。未知の名前は `unknown` を返し、UI がエラー表示する。
 */
export function runCommand(value: string): CommandResult {
  const parsed = parseCommand(value);
  if (!parsed) {
    return { kind: 'unknown', name: '' };
  }
  if (parsed.name === '') {
    const help = findCommand('help');
    if (help) {
      return { kind: 'run', command: help };
    }
  }
  const spec = findCommand(parsed.name);
  return spec ? { kind: 'run', command: spec } : { kind: 'unknown', name: parsed.name };
}
