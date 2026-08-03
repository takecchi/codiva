import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  defaultLogDir,
  enableFatalErrorReports,
  type FatalReportTarget,
  writeCrashLogSync,
} from './crash-log';

const AT = Date.UTC(2026, 7, 3, 12, 34, 56, 789);

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'codiva-crash-log-'));
}

describe('defaultLogDir', () => {
  it('~/.codiva/logs を指す', () => {
    expect(defaultLogDir().endsWith(join('.codiva', 'logs'))).toBe(true);
  });
});

describe('writeCrashLogSync', () => {
  it('存在しないディレクトリを作ってレポートを書き、パスを返す', () => {
    const dir = join(tempDir(), 'logs');
    const path = writeCrashLogSync('report body\n', { at: AT, dir, pid: 7 });
    expect(path).toBe(join(dir, 'crash-2026-08-03T12-34-56-789Z-7.log'));
    expect(readFileSync(path as string, 'utf8')).toBe('report body\n');
  });

  it('古いログをローテーションし、無関係なファイルは残す', () => {
    const dir = tempDir();
    for (const name of [
      'crash-2026-08-01T00-00-00-000Z-1.log',
      'crash-2026-08-02T00-00-00-000Z-1.log',
      'state.json',
    ]) {
      writeFileSync(join(dir, name), 'old', 'utf8');
    }
    writeCrashLogSync('new', { at: AT, dir, pid: 3, keep: 2 });
    expect(readdirSync(dir).sort()).toEqual([
      'crash-2026-08-02T00-00-00-000Z-1.log',
      'crash-2026-08-03T12-34-56-789Z-3.log',
      'state.json',
    ]);
  });

  it('書けなければ undefined を返す（クラッシュ処理を巻き込まない）', () => {
    const file = join(tempDir(), 'not-a-dir');
    writeFileSync(file, 'x', 'utf8');
    expect(writeCrashLogSync('report', { at: AT, dir: file, pid: 1 })).toBeUndefined();
  });
});

describe('enableFatalErrorReports', () => {
  it('診断レポートを fatalError のみで有効化する', () => {
    const dir = join(tempDir(), 'logs');
    const target: FatalReportTarget = {
      directory: '',
      reportOnFatalError: false,
      reportOnSignal: true,
      reportOnUncaughtException: true,
    };
    expect(enableFatalErrorReports(dir, target)).toBe(true);
    expect(target).toEqual({
      directory: dir,
      reportOnFatalError: true,
      reportOnSignal: false,
      reportOnUncaughtException: false,
    });
  });

  it('環境変数を除外できる Node では除外する（API キーを残さない）', () => {
    const target: FatalReportTarget = {
      directory: '',
      reportOnFatalError: false,
      reportOnSignal: true,
      reportOnUncaughtException: true,
      excludeEnv: false,
    };
    enableFatalErrorReports(join(tempDir(), 'logs'), target);
    expect(target.excludeEnv).toBe(true);
  });

  it('process.report が無い環境では false を返すだけ', () => {
    expect(enableFatalErrorReports(tempDir(), null)).toBe(false);
  });
});
