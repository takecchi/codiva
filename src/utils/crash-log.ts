import { mkdirSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { crashLogFileName, staleCrashLogs } from '@/core';

/**
 * クラッシュログの I/O。**すべて同期 API** を使う。呼ばれるのは
 * `uncaughtException` ハンドラの中（＝直後に process.exit する）で、
 * 非同期の書き込みは完了する前にプロセスが消えるため。
 * レポート本文の組み立ては純粋な `core/crash.ts` に委譲する。
 */

/** 残すクラッシュログの本数（古いものから消す）。 */
export const CRASH_LOG_KEEP = 20;

/** 既定の出力先 `~/.codiva/logs`（設定と同じ `~/.codiva` 配下にまとめる）。 */
export function defaultLogDir(): string {
  return join(homedir(), '.codiva', 'logs');
}

/**
 * レポートを `<dir>/crash-<時刻>-<pid>.log` へ書き、書けたパスを返す。
 * クラッシュ処理の最後の砦なので**絶対に throw しない**（書けなければ undefined）。
 */
export function writeCrashLogSync(
  report: string,
  options: { at: number; dir?: string; pid?: number; keep?: number },
): string | undefined {
  const dir = options.dir ?? defaultLogDir();
  const path = join(dir, crashLogFileName(options.at, options.pid ?? process.pid));
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, report, 'utf8');
  } catch {
    return undefined;
  }
  pruneCrashLogsSync(dir, options.keep ?? CRASH_LOG_KEEP);
  return path;
}

/** 古いクラッシュログを消す（best-effort。codiva が書いた名前のファイルだけ）。 */
export function pruneCrashLogsSync(dir: string, keep: number = CRASH_LOG_KEEP): void {
  try {
    for (const name of staleCrashLogs(readdirSync(dir), keep)) {
      try {
        unlinkSync(join(dir, name));
      } catch {
        // 消せない 1 件で残りを諦めない。
      }
    }
  } catch {
    // ディレクトリが無い / 読めないなら何もしない。
  }
}

/**
 * Node の診断レポート（`process.report`）の書き出し先だけ設定して有効化する。
 *
 * 自前の `uncaughtException` ハンドラでは**拾えない**死に方——V8 のヒープ枯渇
 * （`FATAL ERROR: Reached heap limit`）やネイティブのクラッシュ——は abort() で
 * 即死するため JS のコードは一切走らない。診断レポートは C++ 層が abort 前に
 * 書くので、この経路だけが「OOM で落ちた」証拠を残せる。`claude` サブプロセスを
 * 何本も抱える codiva では OOM が現実的な容疑者なので既定で有効にする。
 *
 * 例外は `reportOnFatalError` だけに絞る（signal / uncaughtException は自前の
 * ハンドラが読みやすいレポートを書くので二重に出さない）。
 */
export interface FatalReportTarget {
  directory: string;
  reportOnFatalError: boolean;
  reportOnSignal: boolean;
  reportOnUncaughtException: boolean;
  /** Node 23.3+ のみ。診断レポートから環境変数を除外する。 */
  excludeEnv?: boolean;
}

export function enableFatalErrorReports(
  dir: string = defaultLogDir(),
  // `null` = 診断レポートを持たないランタイム（テストからも明示できるようにしている）。
  target: FatalReportTarget | null = process.report ?? null,
): boolean {
  if (target === null) {
    return false;
  }
  try {
    mkdirSync(dir, { recursive: true });
    target.directory = dir;
    target.reportOnFatalError = true;
    target.reportOnSignal = false;
    target.reportOnUncaughtException = false;
    // 診断レポートは既定で**環境変数を丸ごと含む**（`ANTHROPIC_API_KEY` などが入る）。
    // ユーザーが issue に添付できる想定のファイルなので、除外できる Node（23.3+）では必ず除外する。
    if ('excludeEnv' in target) {
      target.excludeEnv = true;
    }
    return true;
  } catch {
    return false;
  }
}
