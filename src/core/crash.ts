import type { SessionStatus } from './types';

/**
 * クラッシュ報告の純粋な組み立て。ファイル出力は `utils/crash-log.ts`、
 * ハンドラの登録は `bootstrap/crash-handler.ts` が担う（規約: architecture.md）。
 *
 * 目的は「落ちた理由が後から分かること」。TUI は alt screen で描画しているため、
 * 例外のスタックを stderr に出しても画面を抜けた瞬間に消えてしまう
 * （= ユーザーには「突然ターミナルに戻った」としか見えない）。そこでクラッシュ時は
 * この形式のレポートをファイルへ残す。
 */

/** クラッシュ（またはプロセス終了）の種別。 */
export type CrashKind = 'uncaughtException' | 'unhandledRejection' | 'signal';

/** レポートの材料。時刻も呼び出し側から渡して純粋・決定的に保つ。 */
export interface CrashReportInput {
  kind: CrashKind;
  /** 発生時刻（epoch ms）。 */
  at: number;
  /** 1 行の見出し（エラーメッセージ / シグナル名）。 */
  summary: string;
  /** スタックトレース（あれば）。 */
  stack?: string;
  /**
   * 追加の診断情報（バージョン・端末・メモリ・セッション内訳など）。
   * 順序を保ちたいので Record ではなく key/value の配列で受ける。
   */
  diagnostics?: readonly (readonly [string, string])[];
}

const CRASH_LOG_PREFIX = 'crash-';
const CRASH_LOG_SUFFIX = '.log';

/**
 * クラッシュログのファイル名。ISO 時刻の記号を `-` に置き換えるので、
 * **辞書順 = 時刻順**になる（ローテーションがソートだけで済む）。
 * pid を付けるのは、同時刻に複数プロセスが落ちても衝突しないため。
 */
export function crashLogFileName(at: number, pid: number): string {
  const stamp = new Date(at).toISOString().replace(/[:.]/g, '-');
  return `${CRASH_LOG_PREFIX}${stamp}-${pid}${CRASH_LOG_SUFFIX}`;
}

/** codiva が書いたクラッシュログか（無関係なファイルを消さないための判定）。 */
export function isCrashLogName(name: string): boolean {
  return name.startsWith(CRASH_LOG_PREFIX) && name.endsWith(CRASH_LOG_SUFFIX);
}

/**
 * 新しい `keep` 件を残して、消してよい古いログの名前を返す。
 * クラッシュログはユーザーが消さないので、放置すると溜まり続ける。
 */
export function staleCrashLogs(names: readonly string[], keep: number): string[] {
  const logs = names.filter(isCrashLogName).sort();
  const drop = Math.max(0, logs.length - Math.max(0, keep));
  return logs.slice(0, drop);
}

/** レポート本文。1 行目を見れば何が起きたか分かる順に並べる。 */
export function formatCrashReport(input: CrashReportInput): string {
  const lines = [
    'codiva crash report',
    `time: ${new Date(input.at).toISOString()}`,
    `kind: ${input.kind}`,
    `summary: ${input.summary}`,
  ];
  for (const [key, value] of input.diagnostics ?? []) {
    lines.push(`${key}: ${value}`);
  }
  lines.push('', input.stack ?? '(no stack trace)');
  return `${lines.join('\n')}\n`;
}

/** メモリ使用量を MB 単位の 1 行にする（OOM で落ちていないかの判断材料）。 */
export function formatMemoryUsage(usage: {
  rss: number;
  heapTotal: number;
  heapUsed: number;
  external: number;
}): string {
  const mb = (bytes: number): string => `${Math.round(bytes / 1024 / 1024)}MB`;
  return `rss=${mb(usage.rss)} heapUsed=${mb(usage.heapUsed)} heapTotal=${mb(usage.heapTotal)} external=${mb(usage.external)}`;
}

/**
 * セッションのステータス内訳（`running=2 completed=1`）。クラッシュ時に
 * 「何本のサブプロセスが動いていたか」を残すため（1 セッション = `claude` 1 本）。
 */
export function summarizeStatuses(statuses: readonly SessionStatus[]): string {
  if (statuses.length === 0) {
    return 'none';
  }
  const counts = new Map<SessionStatus, number>();
  for (const status of statuses) {
    counts.set(status, (counts.get(status) ?? 0) + 1);
  }
  return [...counts.entries()].map(([status, n]) => `${status}=${n}`).join(' ');
}
