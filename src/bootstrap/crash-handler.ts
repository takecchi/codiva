import {
  type CrashKind,
  type CrashReportInput,
  errorMessage,
  errorStack,
  formatCrashReport,
  type Messages,
} from '@/core';

/**
 * クラッシュ時の後始末を 1 か所に集める。
 *
 * TUI は alt screen + マウス捕捉で動いているので、素の例外で死ぬと
 * (1) 例外の内容が alt screen ごと消えてユーザーには何も残らない、
 * (2) 端末がマウスレポートを送り続ける（スクロールが大量の文字入力に化ける）
 * の 2 つが同時に起きる。ここで `uncaughtException` / `unhandledRejection` を
 * 捕まえ、**端末を戻してから** 通常バッファへ理由を出し、レポートをファイルへ残す。
 *
 * 副作用はすべて DI（`CrashHandlerPorts`）で受け取り、テストではフェイクを渡す。
 */

/** 診断情報の 1 行（順序を保つため key/value のタプル）。 */
export type Diagnostic = readonly [string, string];

export interface CrashHandlerPorts {
  /** 端末を通常状態へ戻す（alt screen 退出 + マウス無効化）。最初に呼ぶ。 */
  restore: () => void;
  /** セッション状態の同期 flush（復元可能なまま残すため。best-effort）。 */
  flush?: () => void;
  /** 追加の診断情報。評価中の例外は無視する（レポート自体を失わないため）。 */
  diagnostics?: () => readonly Diagnostic[];
  /** レポートを永続化し、書けたパスを返す（未設定ならファイルに残さない）。 */
  write?: (report: string, at: number) => string | undefined;
  messages: Messages;
  stderr?: { write(text: string): unknown };
  now?: () => number;
  exit?: (code: number) => void;
  /** ハンドラ登録先（テスト用に差し替え可能）。 */
  target?: CrashTarget;
}

/** `process` のうちこのモジュールが使う部分だけ。 */
export interface CrashTarget {
  on(event: string, listener: (err: unknown) => void): unknown;
  off(event: string, listener: (err: unknown) => void): unknown;
}

export interface CrashHandlers {
  /** ハンドラを外す（正常終了の直前に呼ぶ）。 */
  uninstall: () => void;
  /**
   * 明示的にレポートを残す（終了はしない）。シグナルで殺されたときに
   * 「クラッシュではなく kill された」ことを記録するために使う。
   */
  record: (kind: CrashKind, summary: string, err?: unknown) => string | undefined;
}

/** 例外を出しても後続を止めない実行（クラッシュ処理中は何も信用しない）。 */
function safely(fn: (() => void) | undefined): void {
  try {
    fn?.();
  } catch {
    // ignore
  }
}

export function installCrashHandlers(ports: CrashHandlerPorts): CrashHandlers {
  const target = ports.target ?? process;
  const stderr = ports.stderr ?? process.stderr;
  const now = ports.now ?? Date.now;
  const exit = ports.exit ?? ((code: number) => process.exit(code));
  const m = ports.messages;
  let done = false;

  const collect = (): readonly Diagnostic[] => {
    try {
      return ports.diagnostics?.() ?? [];
    } catch {
      return [];
    }
  };

  const build = (input: Omit<CrashReportInput, 'diagnostics'>): string =>
    formatCrashReport({ ...input, diagnostics: collect() });

  const record: CrashHandlers['record'] = (kind, summary, err) => {
    const at = now();
    const report = build({ kind, at, summary, stack: errorStack(err) });
    try {
      return ports.write?.(report, at);
    } catch {
      return undefined;
    }
  };

  const crash = (kind: CrashKind) => (err: unknown) => {
    if (done) {
      return;
    }
    done = true;
    uninstall();
    // 端末を先に戻す。以降の出力は通常バッファ（= スクロールバックに残る）へ出る。
    safely(ports.restore);
    safely(ports.flush);
    const at = now();
    const summary = errorMessage(err);
    const report = build({ kind, at, summary, stack: errorStack(err) });
    let path: string | undefined;
    try {
      path = ports.write?.(report, at);
    } catch {
      path = undefined;
    }
    safely(() => {
      stderr.write(
        `\n${m.crash.title}\n\n${report}\n${path ? m.crash.log(path) : m.crash.logFailed}\n${m.crash.reset}\n`,
      );
    });
    exit(1);
  };

  const onException = crash('uncaughtException');
  const onRejection = crash('unhandledRejection');

  function uninstall(): void {
    target.off('uncaughtException', onException);
    target.off('unhandledRejection', onRejection);
  }

  target.on('uncaughtException', onException);
  target.on('unhandledRejection', onRejection);

  return { uninstall, record };
}
