import { describe, expect, it } from 'vitest';
import {
  crashLogFileName,
  formatCrashReport,
  formatMemoryUsage,
  isCrashLogName,
  staleCrashLogs,
  summarizeStatuses,
} from './crash';
import type { SessionStatus } from './types';

const AT = Date.UTC(2026, 7, 3, 12, 34, 56, 789);

describe('crashLogFileName', () => {
  it('時刻と pid からファイル名を作る（記号は - に置換）', () => {
    expect(crashLogFileName(AT, 4242)).toBe('crash-2026-08-03T12-34-56-789Z-4242.log');
  });

  it('辞書順 = 時刻順になる（ローテーションがソートで済む）', () => {
    const older = crashLogFileName(AT, 1);
    const newer = crashLogFileName(AT + 1000, 1);
    expect([newer, older].sort()).toEqual([older, newer]);
  });
});

describe('isCrashLogName', () => {
  it.each([
    ['crash-2026-08-03T12-34-56-789Z-1.log', true],
    ['crash-x.log', true],
    ['report.20260803.1.0.001.json', false],
    ['state.json', false],
    ['crash-1.log.bak', false],
    ['nope.log', false],
  ])('%s → %s', (name, expected) => {
    expect(isCrashLogName(name)).toBe(expected);
  });
});

describe('staleCrashLogs', () => {
  const names = [
    'crash-2026-08-01T00-00-00-000Z-1.log',
    'crash-2026-08-02T00-00-00-000Z-1.log',
    'crash-2026-08-03T00-00-00-000Z-1.log',
    'state.json',
  ];

  it.each([
    [3, []],
    [2, [names[0]]],
    [1, [names[0], names[1]]],
    [0, [names[0], names[1], names[2]]],
  ] as [number, string[]][])('keep=%i で古い %o を返す', (keep, expected) => {
    expect(staleCrashLogs(names, keep)).toEqual(expected);
  });

  it('codiva 以外のファイルは絶対に対象にしない', () => {
    expect(staleCrashLogs(['state.json', 'config.json'], 0)).toEqual([]);
  });

  it('keep が負でも壊れない', () => {
    expect(staleCrashLogs([names[0] as string], -5)).toEqual([names[0]]);
  });
});

describe('formatCrashReport', () => {
  it('見出し・時刻・種別・要約・診断・スタックを順に並べる', () => {
    const report = formatCrashReport({
      kind: 'uncaughtException',
      at: AT,
      summary: 'boom',
      stack: 'Error: boom\n    at somewhere',
      diagnostics: [
        ['codiva', '0.3.6'],
        ['sessions', 'running=1'],
      ],
    });
    expect(report).toBe(
      [
        'codiva crash report',
        'time: 2026-08-03T12:34:56.789Z',
        'kind: uncaughtException',
        'summary: boom',
        'codiva: 0.3.6',
        'sessions: running=1',
        '',
        'Error: boom',
        '    at somewhere',
        '',
      ].join('\n'),
    );
  });

  it('スタックが無くても本文を落とさない', () => {
    const report = formatCrashReport({ kind: 'signal', at: AT, summary: 'terminated by SIGTERM' });
    expect(report).toContain('kind: signal');
    expect(report).toContain('(no stack trace)');
  });
});

describe('formatMemoryUsage', () => {
  it('MB 単位の 1 行にする', () => {
    expect(
      formatMemoryUsage({
        rss: 210 * 1024 * 1024,
        heapTotal: 120 * 1024 * 1024,
        heapUsed: 90 * 1024 * 1024,
        external: 5 * 1024 * 1024,
      }),
    ).toBe('rss=210MB heapUsed=90MB heapTotal=120MB external=5MB');
  });
});

describe('summarizeStatuses', () => {
  it.each([
    [[], 'none'],
    [['running'], 'running=1'],
    [['running', 'completed', 'running'], 'running=2 completed=1'],
  ] as [SessionStatus[], string][])('%o → %s', (statuses, expected) => {
    expect(summarizeStatuses(statuses)).toBe(expected);
  });
});
