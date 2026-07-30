import { platform as osPlatform } from 'node:os';
import type { NotificationSpec } from '@/core';
import { fireAndForget } from './exec';
import { type WritableLike, wrapForTmux } from './terminal-mode';

/**
 * デスクトップ通知の I/O。2 経路あり、**端末に出させる方を優先**する。
 *
 * 1. **OSC 通知**（`buildNotifySequence`）: 端末エミュレータ自身に通知を出させる
 *    エスケープシーケンス。通知は端末アプリ（Ghostty / iTerm2 …）名義で投函されるので、
 *    クリックすると**その端末が前面に来る**＝復帰動線になる。SSH / コンテナ越しでも動く
 *    （OSC 52 のクリップボードと同じ理由）。
 * 2. **OS コマンド**（`notifyCommand`）: 上が使えない端末向けのフォールバック。
 *
 * macOS で 1 を優先するのは、`osascript` からの `display notification` が
 * **Script Editor 名義**になるため。通知センターはアプリバンドル単位で通知を管理し、
 * `osascript` は自前のバンドルを持たないので AppleScript の代表バンドル
 * （`com.apple.ScriptEditor2`）に紐づく。通知クリック＝送信元アプリのアクティベートなので、
 * codiva の完了通知を押すと**スクリプトエディタが開く**という実害になっていた。
 */

const ESC = '\x1b';
const BEL = '\x07';
const ST = `${ESC}\\`;

/** 通知文字列の上限。長いセッションタイトルで通知が読めなくなるのを防ぐ。 */
const MAX_CHARS = 120;

/** 端末が解釈する通知シーケンスの方言。 */
export type NotifyProtocol = 'osc777' | 'osc9' | 'osc99';

/**
 * 端末が対応する通知シーケンスの方言を環境変数から判定する。判定できなければ
 * undefined を返し、呼び出し側は OS コマンドへフォールバックする。
 *
 * OSC は投げっぱなしで、端末が解釈したか知る手段がない（無視されると無音で消える）。
 * なので**対応が確実な端末だけを列挙**し、推測で広げない。
 */
export function detectNotifyProtocol(env: NodeJS.ProcessEnv): NotifyProtocol | undefined {
  const program = env.TERM_PROGRAM ?? '';
  const term = env.TERM ?? '';
  // kitty は独自の OSC 99 を持つ（OSC 9 も解釈するが本文 1 つしか運べない）ので 99 を優先。
  if (env.KITTY_WINDOW_ID !== undefined || term.includes('kitty')) {
    return 'osc99';
  }
  // Ghostty / WezTerm / foot は OSC 777（title + body を運べる）。
  // **tmux は TERM_PROGRAM を 'tmux' で上書きし、TERM も screen-* に化ける**ので、
  // TERM/TERM_PROGRAM だけ見ると tmux 内で必ず判定漏れする（= フォールバックに落ちて
  // Script Editor 名義に戻る）。端末が自前で撒く変数も見る（tmux はサーバ起動時の環境を
  // 引き継ぐため残る）。
  if (
    program === 'ghostty' ||
    term === 'xterm-ghostty' ||
    env.GHOSTTY_BIN_DIR !== undefined ||
    env.GHOSTTY_RESOURCES_DIR !== undefined
  ) {
    return 'osc777';
  }
  if (
    program === 'WezTerm' ||
    env.WEZTERM_PANE !== undefined ||
    env.WEZTERM_EXECUTABLE !== undefined
  ) {
    return 'osc777';
  }
  if (term.startsWith('foot')) {
    return 'osc777';
  }
  // iTerm2 は OSC 9（本文 1 つだけ）。`LC_TERMINAL` は ssh が既定で転送する（`SendEnv LC_*`）
  // ので、リモートの codiva からでも手元の iTerm2 に通知が出る。
  if (
    program === 'iTerm.app' ||
    env.LC_TERMINAL === 'iTerm2' ||
    env.ITERM_SESSION_ID !== undefined
  ) {
    return 'osc9';
  }
  // 以下は意図的に列挙しない（誤判定すると通知が無音で消え、動いていた OS 通知も失う）:
  // - Windows Terminal: OSC 9 は ConEmu 方言の数値サブコマンド専用で、通知用の OSC 777 は
  //   `allowOSC777` 設定が既定 false（microsoft/terminal#20012）。
  // - urxvt: OSC 777 は「第1フィールド名の perl 拡張へ丸投げ」する汎用口で、`notify` 拡張は
  //   同梱されておらず `perl-ext-common` での追加読み込みが必要。
  return undefined;
}

/**
 * 通知に載せる文字列を無害化する。制御文字はシーケンスを途中で終了させてしまうので
 * 空白へ潰し、長さも切る。C0 と DEL に加えて **C1（U+0080–U+009F）も落とす**:
 * UTF-8 のまま U+009C を ST、U+009B を CSI として解釈する端末があるため。
 * セッションタイトルは LLM がリポジトリの内容から作る＝完全に信頼できない入力なので、
 * 改行や制御文字が混ざっていても壊れないようにする。
 */
function sanitize(text: string): string {
  let out = '';
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    out += code < 0x20 || (code >= 0x7f && code <= 0x9f) ? ' ' : ch;
  }
  const trimmed = out.trim();
  return trimmed.length > MAX_CHARS ? `${trimmed.slice(0, MAX_CHARS - 1)}…` : trimmed;
}

function base64(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

/**
 * 端末に通知を出させるエスケープシーケンスを組む。純粋（I/O なし）なので単体テスト可能。
 * `id` は OSC 99 の通知 ID に使う（同じ ID は直前の通知を上書きするため通知ごとに変える）。
 */
export function buildNotifySequence(
  spec: NotificationSpec,
  protocol: NotifyProtocol,
  opts: { tmux?: boolean; id?: string } = {},
): string {
  const title = sanitize(spec.title);
  const body = sanitize(spec.body);
  const seq = ((): string => {
    switch (protocol) {
      case 'osc777':
        // `777;notify;<title>;<body>`。title 内の ';' はフィールド境界と誤読されるので
        // ',' へ置換する（body は最終フィールド＝残り全部なので置換不要）。
        return `${ESC}]777;notify;${title.replaceAll(';', ',')};${body}${BEL}`;
      case 'osc9':
        // OSC 9 は本文 1 つだけ（タイトルは端末名になる）ので連結する。ConEmu / iTerm2 の
        // 方言は `9;<数値>;…` をプログレスバー等のサブコマンドに使うため、';' を ',' へ
        // 置換して本文がサブコマンドに化けないようにする（例: 本文 `4;70`）。
        return `${ESC}]9;${`${title} — ${body}`.replaceAll(';', ',')}${BEL}`;
      case 'osc99': {
        // kitty 方言。d=0 で title を送り、d=1 の body で確定（同じ id で連結される）。
        // payload は base64（e=1）にして ';' や非 ASCII をそのまま運ぶ。
        const id = opts.id ?? '0';
        return (
          `${ESC}]99;i=${id}:d=0:p=title:e=1;${base64(title)}${ST}` +
          `${ESC}]99;i=${id}:d=1:p=body:e=1;${base64(body)}${ST}`
        );
      }
    }
  })();
  return opts.tmux ? wrapForTmux(seq) : seq;
}

/**
 * Build the OS command that shows a desktop notification, or undefined if the
 * platform is unsupported. Kept pure (platform passed in) so it can be unit-tested.
 * Title/body are always passed as argv — never interpolated into a shell/script
 * string — so a session title can't inject anything.
 */
export function notifyCommand(
  spec: NotificationSpec,
  platform: NodeJS.Platform,
): { file: string; args: string[] } | undefined {
  switch (platform) {
    case 'darwin':
      // Read title/body from `argv` inside the AppleScript instead of splicing
      // them into the script text (osascript -e), which would be injectable.
      // NOTE: この通知は Script Editor 名義になる（クリックでスクリプトエディタが開く）。
      // OSC 通知に対応した端末では上の経路が使われるので、ここはあくまで最後の砦。
      return {
        file: 'osascript',
        args: [
          '-e',
          'on run argv',
          '-e',
          'display notification (item 1 of argv) with title (item 2 of argv)',
          '-e',
          'end run',
          spec.body,
          spec.title,
        ],
      };
    case 'linux':
      return { file: 'notify-send', args: [spec.title, spec.body] };
    default:
      // Windows toast requires extra modules / injection-prone PowerShell; skip
      // it for now rather than ship untested code. Notifications are best-effort.
      return undefined;
  }
}

/** テストで端末環境を差し替えるための seam（既定は実プロセス）。 */
export interface NotifyDeps {
  stream?: WritableLike;
  env?: NodeJS.ProcessEnv;
  isTty?: boolean;
  platform?: NodeJS.Platform;
}

/** OSC 99 の通知 ID の連番。通知ごとに変えて直前の通知を上書きしないようにする。 */
let sequenceId = 0;

/**
 * kitty の通知 ID。同じ ID の chunk は連結・上書きされるため、1 端末で codiva を
 * 2 つ動かしても衝突しないよう pid を混ぜる（許容文字は `[a-zA-Z0-9_+-.]`）。
 */
function nextNotifyId(): string {
  sequenceId += 1;
  return `${process.pid}-${sequenceId}`;
}

/**
 * Best-effort desktop notification. 端末が対応していれば OSC で端末自身に出させ
 * （クリックで端末が前面に来る）、そうでなければ OS コマンドにフォールバックする。
 * Fire-and-forget: any failure (missing binary, headless session, no display server)
 * is swallowed so notifications never disrupt the TUI or crash the app.
 */
export function notify(spec: NotificationSpec, deps: NotifyDeps = {}): void {
  const env = deps.env ?? process.env;
  // 非 TTY（パイプ・リダイレクト先）へエスケープを書くと通知にならずゴミが残るだけ。
  const isTty = deps.isTty ?? Boolean(process.stdout.isTTY);
  const protocol = isTty ? detectNotifyProtocol(env) : undefined;
  if (protocol) {
    const seq = buildNotifySequence(spec, protocol, {
      tmux: env.TMUX !== undefined,
      id: nextNotifyId(),
    });
    try {
      (deps.stream ?? process.stdout).write(seq);
    } catch {
      // stdout が既に破棄されている（端末が閉じられた直後の遷移など）ケース。
      // 通知は best-effort なので、ここで throw して commit 経路を壊さない。
    }
    return;
  }
  const cmd = notifyCommand(spec, deps.platform ?? osPlatform());
  if (cmd) {
    fireAndForget(cmd.file, cmd.args);
  }
}
