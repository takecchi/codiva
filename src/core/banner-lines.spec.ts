import { describe, expect, it } from 'vitest';
import {
  type BannerLine,
  bannerCaretAt,
  bannerLines,
  bannerLineText,
  bannerText,
} from './banner-lines';
import { messages } from './i18n';
import type { RateLimitStatus } from './rate-limit';

const m = messages.en;
const NOW = 1_000_000_000_000;

/** The header text as an array of plain rows (what the terminal shows, styling dropped). */
function rows(line: BannerLine[]): string[] {
  return line.map(bannerLineText);
}

describe('bannerLines', () => {
  it('ワードマーク → サブタイトル → モデル → cwd の順に行を組む', () => {
    const lines = rows(
      bannerLines(m, { sessionCount: 0, model: 'sonnet', cwd: '/tmp/repo', now: NOW }),
    );
    expect(lines[0]).toContain('Codiva');
    expect(lines[1]).toBe(m.banner.subtitle);
    expect(lines[2]).toBe('model: sonnet');
    expect(lines[3]).toBe('/tmp/repo');
    expect(lines).toHaveLength(4);
  });

  it('モデル未設定なら CLI 既定を出す', () => {
    const lines = rows(bannerLines(m, { sessionCount: 0, now: NOW }));
    expect(lines[2]).toBe('model: CLI default');
  });

  it('cwd 未指定ならパス行を作らない', () => {
    expect(rows(bannerLines(m, { sessionCount: 0, now: NOW }))).toHaveLength(3);
  });

  it('プラン名はモデル行と cwd 行の間に入る', () => {
    const lines = rows(
      bannerLines(m, {
        sessionCount: 0,
        model: 'sonnet',
        cwd: '/tmp/repo',
        account: { plan: 'Claude Team', organization: 'Acme' },
        now: NOW,
      }),
    );
    expect(lines[2]).toBe('model: sonnet');
    expect(lines[3]).toBe(m.banner.usage.plan('Claude Team', 'Acme'));
    expect(lines[4]).toBe('/tmp/repo');
  });

  it('プランが取れないときはプラン行を作らない（行 index をずらさない）', () => {
    const base = rows(bannerLines(m, { sessionCount: 0, cwd: '/tmp/repo', now: NOW }));
    for (const account of [undefined, {}, { organization: 'Acme' }]) {
      expect(
        rows(bannerLines(m, { sessionCount: 0, cwd: '/tmp/repo', account, now: NOW })),
      ).toEqual(base);
    }
  });

  const headCases: {
    name: string;
    input: Parameters<typeof bannerLines>[1];
    contains: string[];
    omits: string[];
  }[] = [
    {
      name: 'バージョンをワードマークの右に添える',
      input: { sessionCount: 0, version: '0.1.5', now: NOW },
      contains: ['Codiva v0.1.5'],
      omits: [],
    },
    {
      name: 'バージョン未指定なら v 表記を出さない',
      input: { sessionCount: 0, now: NOW },
      contains: ['Codiva'],
      omits: [' v'],
    },
    {
      name: 'コストが 0 なら合計を出さない',
      input: { sessionCount: 2, totalCostUsd: 0, now: NOW },
      contains: ['2 session'],
      omits: ['total'],
    },
    {
      name: 'コストがあれば合計を添える',
      input: { sessionCount: 2, totalCostUsd: 1.5, now: NOW },
      contains: ['total'],
      omits: [],
    },
  ];
  it.each(headCases)('$name', ({ input, contains, omits }) => {
    const head = rows(bannerLines(m, input))[0] ?? '';
    for (const s of contains) {
      expect(head).toContain(s);
    }
    for (const s of omits) {
      expect(head).not.toContain(s);
    }
  });

  it('更新があるときだけ cwd 行の後ろに 1 行足す', () => {
    const lines = rows(
      bannerLines(m, {
        sessionCount: 0,
        model: 'sonnet',
        cwd: '/tmp/repo',
        updateLatest: '0.3.0',
        now: NOW,
      }),
    );
    expect(lines).toHaveLength(5);
    expect(lines[4]).toContain(m.update.available('0.3.0'));
    expect(lines[4]).toContain(m.update.availableHint);
  });

  it('更新が無ければ行を増やさない（最新でも未確認でも同じ = 行 index をずらさない）', () => {
    const base = { sessionCount: 0, model: 'sonnet', cwd: '/tmp/repo', now: NOW };
    expect(rows(bannerLines(m, base))).toHaveLength(4);
    expect(rows(bannerLines(m, { ...base, updateLatest: undefined }))).toHaveLength(4);
  });

  it('更新行はアクセント色 + dim の 2 セグメントで組む（色は theme が決める）', () => {
    const lines = bannerLines(m, { sessionCount: 0, updateLatest: '0.3.0', now: NOW });
    const update = lines[lines.length - 1];
    expect(update?.segments.map((s) => s.tone)).toEqual(['accent', 'dim']);
  });

  it('使用リミットが無ければ使用状況節を出さない', () => {
    const lines = rows(bannerLines(m, { sessionCount: 0, now: NOW }));
    expect(lines.join('\n')).not.toContain('Usage');
  });

  it('使用リミットがあれば空行 + 見出し + 枠ごとの行を足す', () => {
    const lines = rows(
      bannerLines(m, {
        sessionCount: 0,
        now: NOW,
        rateLimits: [
          {
            type: 'five_hour',
            status: 'allowed',
            utilization: 5,
            resetsAt: NOW + (4 * 60 + 45) * 60_000,
          },
        ],
      }),
    );
    // 3 行（ワードマーク/サブタイトル/モデル）+ 空行 + 見出し + 枠1行。
    expect(lines).toHaveLength(6);
    expect(lines[3]).toBe(''); // marginTop ではなく明示的な空行（行 index = 表示行）
    expect(lines[4]).toBe('Usage');
    expect(lines[5]).toContain('Current session');
    expect(lines[5]).toContain('5% used');
    expect(lines[5]).toContain('resets in 4h 45m');
  });

  it('日本語では使用状況を日本語で組む（ja/en を対で担保する）', () => {
    const lines = rows(
      bannerLines(messages.ja, {
        sessionCount: 0,
        now: NOW,
        rateLimits: [
          { type: 'five_hour', status: 'allowed', utilization: 5, resetsAt: NOW + 285 * 60_000 },
        ],
      }),
    );
    expect(lines[4]).toBe('使用状況');
    expect(lines[5]).toContain('現在のセッション');
    expect(lines[5]).toContain('5% 使用');
    expect(lines[5]).toContain('4時間45分後にリセット');
  });

  const toneCases: [RateLimitStatus, string][] = [
    ['allowed', 'dim'],
    ['allowed_warning', 'warn'],
    ['rejected', 'error'],
  ];
  it.each(toneCases)('使用枠 %s の色調は %s', (status, tone) => {
    const lines = bannerLines(m, {
      sessionCount: 0,
      now: NOW,
      rateLimits: [{ type: 'five_hour', status, utilization: 5 }],
    });
    expect(lines[5]?.segments[0]?.tone).toBe(tone);
  });
});

describe('bannerText', () => {
  it('行を改行で連結して 1 つの選択対象テキストにする', () => {
    const lines: BannerLine[] = [
      {
        segments: [
          { text: 'ab', tone: 'normal' },
          { text: 'c', tone: 'dim' },
        ],
      },
      { segments: [] },
      { segments: [{ text: 'd', tone: 'dim' }] },
    ];
    expect(bannerText(lines)).toBe('abc\n\nd');
  });
});

describe('bannerCaretAt', () => {
  // 'abc\n日本語\n' — 行0 は 0..3、行1 は 4..7（日本語は 1 文字 2 セル）、行2 は空。
  const lines: BannerLine[] = [
    {
      segments: [
        { text: 'a', tone: 'normal' },
        { text: 'bc', tone: 'dim' },
      ],
    },
    { segments: [{ text: '日本語', tone: 'dim' }] },
    { segments: [] },
  ];

  const cases: [string, number, number, number | undefined][] = [
    ['行頭', 0, 0, 0],
    ['行の途中', 0, 2, 2],
    ['行末（ちょうど末尾のセル）', 0, 3, 3],
    ['行末より右は当たりとしない（既定 = reject）', 0, 4, undefined],
    ['はるか右も当たりとしない', 0, 99, undefined],
    ['次の行の行頭', 1, 0, 4],
    ['全角の左半分は文字の手前に置く', 1, 1, 4],
    ['全角 1 文字ぶん進む', 1, 2, 5],
    ['空行', 2, 0, 8],
    ['行より下は対象外', 3, 0, undefined],
    ['行より上は対象外', -1, 0, undefined],
    ['テキスト枠の左（マスコット側）は対象外', 0, -1, undefined],
  ];
  it.each(cases)('%s', (_name, row, cells, expected) => {
    expect(bannerCaretAt(lines, row, cells)).toBe(expected);
  });

  // ドラッグは行末より先まで行き過ぎても「行末まで選ぶ」ことを期待する操作なので、
  // press（reject）と違って行末へ丸める。
  const clampCases: [string, number, number, number | undefined][] = [
    ['行末より右は行末へ丸める', 0, 99, 3],
    ['全角行の右外も行末へ丸める', 1, 99, 7],
    ['それでも行の外（下）は対象外', 3, 0, undefined],
    ['それでもテキスト枠の左は対象外', 0, -1, undefined],
  ];
  it.each(clampCases)('clamp: %s', (_name, row, cells, expected) => {
    expect(bannerCaretAt(lines, row, cells, 'clamp')).toBe(expected);
  });

  it('返す index は bannerText の該当文字を指す', () => {
    const text = bannerText(lines);
    const index = bannerCaretAt(lines, 1, 2);
    expect(index).not.toBeUndefined();
    expect(text.slice(index)).toBe('本語\n');
  });
});
