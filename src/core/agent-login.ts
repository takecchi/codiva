import { detectUrls, openableUrl } from './url';

/**
 * TUI 内で完結するエージェントのログイン進行（純粋）。実際のプロセス起動は
 * `utils/agent-login.ts`、UI は `ui/login-dialog.tsx`。ここは「出力行の列 → 表示状態」の
 * 変換だけを持つ。
 *
 * 端末を明け渡さず codiva の中でログインを進めるので、鍵になるのは **login CLI が
 * 出力する認証 URL**（＋デバイスコードフローなら user code）。それを拾ってダイアログに
 * 出し、クリック / 自動オープンでブラウザへ渡す。プロセスが終わったら成否を確定し、
 * 呼び出し側が可用性を再検出する。
 */

/** ログインの進行状態。 */
export type LoginStatus = 'running' | 'succeeded' | 'failed';

export interface LoginState {
  status: LoginStatus;
  /** 認証で開くべき URL（最初に検出したもの）。まだ出ていなければ undefined。 */
  url?: string;
  /**
   * デバイスコード（`codex login --device-auth` が出す "enter code XXXX-YYYY"）。
   * URL と別に見せると、ブラウザで開いたページに入力しやすい。
   */
  code?: string;
  /** 画面に出す出力行（上限付き。CLI が饒舌でもダイアログを流さない）。 */
  lines: readonly string[];
  /** 失敗時の理由（終了コード / 最後の非空行）。 */
  error?: string;
}

/** ダイアログに保持する出力行の上限。 */
export const MAX_LOGIN_LINES = 40;

/** 初期状態（プロセス起動直後）。 */
export function initialLoginState(): LoginState {
  return { status: 'running', lines: [] };
}

/** `XXXX-XXXX` 形式のデバイスコードらしき断片（英数 4-8 桁 + ハイフン + 英数 4-8 桁）。 */
const DEVICE_CODE_RE = /\b([A-Z0-9]{4,8}-[A-Z0-9]{4,8})\b/;

/**
 * ANSI エスケープ（SGR の色付け・CSI・OSC）を落とす。login CLI は URL や
 * デバイスコードを**色付きで**出す（実測: `codex login --device-auth` は青字）。
 * 剥がさないと `\x1b[94m` の直後の `\b`（単語境界）が崩れて URL / コードを拾えない。
 * 制御文字は正規表現リテラルに直書きせず組み立てる（Biome の noControlCharactersInRegex）。
 */
const ESC = String.fromCharCode(27);
const ANSI_RE = new RegExp(
  `${ESC}\\][\\s\\S]*?(?:${String.fromCharCode(7)}|${ESC}\\\\)|${ESC}\\[[0-9;?]*[ -/]*[@-~]`,
  'g',
);

function stripAnsi(line: string): string {
  return line.replace(ANSI_RE, '');
}

/**
 * 出力行を 1 本畳み込む。URL は最初に見つかったものを固定し、以降は上書きしない
 * （ログインの入口 URL は最初に出るため。後続行の別 URL に振り回されない）。
 */
export function appendLoginLine(state: LoginState, rawLine: string): LoginState {
  // 色付けを剥がしてから検出も表示もする（ダイアログにも生エスケープを出さない）。
  const line = stripAnsi(rawLine.replace(/\r$/, ''));
  const lines = [...state.lines, line].slice(-MAX_LOGIN_LINES);
  let url = state.url;
  if (url === undefined) {
    const found = detectUrls(line)[0];
    const openable = openableUrl(found?.url);
    if (openable) {
      url = openable;
    }
  }
  let code = state.code;
  if (code === undefined) {
    const m = line.match(DEVICE_CODE_RE);
    if (m) {
      code = m[1];
    }
  }
  return { ...state, lines, url, code };
}

/**
 * プロセス終了を畳み込む。終了コード 0 を成功、それ以外を失敗とする。
 * 失敗理由は stderr 由来の最後の非空行（無ければ終了コード）を使う。
 */
export function finishLogin(state: LoginState, code: number | null): LoginState {
  if (code === 0) {
    return { ...state, status: 'succeeded', error: undefined };
  }
  const lastLine = [...state.lines].reverse().find((l) => l.trim().length > 0);
  return {
    ...state,
    status: 'failed',
    error: lastLine ?? `exited with code ${code ?? 'null'}`,
  };
}
