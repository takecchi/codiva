import { describe, expect, it } from 'vitest';
import {
  type BannerLine,
  bannerCaretAt,
  bannerLines,
  bannerLineText,
  bannerText,
  bannerUsageRows,
} from './banner-lines';
import { messages } from './i18n';
import type { RateLimitStatus, RateLimitWindow } from './rate-limit';

const m = messages.en;
const NOW = 1_000_000_000_000;

/** The header text as an array of plain rows (what the terminal shows, styling dropped). */
function rows(line: BannerLine[]): string[] {
  return line.map(bannerLineText);
}

describe('bannerLines', () => {
  it('ワードマーク → プラン + モデル → cwd の順に行を組む（サブタイトルは出さない）', () => {
    const lines = rows(bannerLines(m, { sessionCount: 0, model: 'sonnet', cwd: '/tmp/repo' }));
    expect(lines[0]).toContain('Codiva');
    expect(lines[1]).toBe('Model: sonnet');
    expect(lines[2]).toBe('/tmp/repo');
    expect(lines).toHaveLength(3);
  });

  it('モデル未設定なら CLI 既定を出す', () => {
    const lines = rows(bannerLines(m, { sessionCount: 0 }));
    expect(lines[1]).toBe('Model: CLI default');
  });

  it('cwd 未指定ならパス行を作らない', () => {
    expect(rows(bannerLines(m, { sessionCount: 0 }))).toHaveLength(2);
  });

  it('既定のエージェントはモデルと同じ行に並ぶ（行を増やさない）', () => {
    // 一覧の行のエージェント列は混在時だけ出るので、単一 provider で使っている人が
    // 「何で動くか」を確かめられるのはここになる。
    const lines = rows(
      bannerLines(m, { sessionCount: 0, agent: 'Codex', model: 'gpt-5', cwd: '/tmp/repo' }),
    );
    expect(lines[1]).toBe('Agent: Codex   Model: gpt-5');
    expect(lines).toHaveLength(3);
  });

  it('エージェント未指定なら出さない', () => {
    expect(rows(bannerLines(m, { sessionCount: 0 }))[1]).toBe('Model: CLI default');
  });

  it('プラン名はモデルと同じ行に並ぶ（行を増やさない）', () => {
    const lines = rows(
      bannerLines(m, {
        sessionCount: 0,
        model: 'sonnet',
        cwd: '/tmp/repo',
        account: { plan: 'Claude Team', organization: 'Acme' },
      }),
    );
    expect(lines[1]).toBe('Plan: Claude Team (Acme)   Model: sonnet');
    expect(lines[2]).toBe('/tmp/repo');
    expect(lines).toHaveLength(3);
  });

  it('現在ブランチはプラン・モデルと同じ行に並べる（cwd 行は汚さない）', () => {
    const lines = rows(
      bannerLines(m, {
        sessionCount: 0,
        model: 'sonnet',
        cwd: '/tmp/repo',
        branch: 'main',
        account: { plan: 'Max' },
      }),
    );
    expect(lines[1]).toBe('Plan: Max   Model: sonnet   Branch: main');
    expect(lines[2]).toBe('/tmp/repo');
    expect(lines).toHaveLength(3);
  });

  it('ブランチが取れないときは表示しない（detached HEAD / git 失敗）', () => {
    const base = { sessionCount: 0, model: 'sonnet', cwd: '/tmp/repo' };
    const expected = rows(bannerLines(m, base));
    for (const branch of [undefined, '']) {
      expect(rows(bannerLines(m, { ...base, branch }))).toEqual(expected);
    }
  });

  it('プランが取れなくてもブランチはモデルの右に並ぶ', () => {
    const lines = rows(bannerLines(m, { sessionCount: 0, model: 'sonnet', branch: 'feat/x' }));
    expect(lines[1]).toBe('Model: sonnet   Branch: feat/x');
  });

  it('プランが取れないときはモデルだけの行にする（行 index をずらさない）', () => {
    const base = rows(bannerLines(m, { sessionCount: 0, cwd: '/tmp/repo' }));
    for (const account of [undefined, {}, { organization: 'Acme' }]) {
      expect(rows(bannerLines(m, { sessionCount: 0, cwd: '/tmp/repo', account }))).toEqual(base);
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
      input: { sessionCount: 0, version: '0.1.5' },
      contains: ['Codiva v0.1.5'],
      omits: [],
    },
    {
      name: 'バージョン未指定なら v 表記を出さない',
      input: { sessionCount: 0 },
      contains: ['Codiva'],
      omits: [' v'],
    },
    {
      name: 'コストが 0 なら合計を出さない',
      input: { sessionCount: 2, totalCostUsd: 0 },
      contains: ['2 session'],
      omits: ['total'],
    },
    {
      name: 'コストがあれば合計を添える',
      input: { sessionCount: 2, totalCostUsd: 1.5 },
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
      }),
    );
    expect(lines).toHaveLength(4);
    expect(lines[3]).toContain(m.update.available('0.3.0'));
    expect(lines[3]).toContain(m.update.availableHint);
  });

  it('更新が無ければ行を増やさない（最新でも未確認でも同じ = 行 index をずらさない）', () => {
    const base = { sessionCount: 0, model: 'sonnet', cwd: '/tmp/repo' };
    expect(rows(bannerLines(m, base))).toHaveLength(3);
    expect(rows(bannerLines(m, { ...base, updateLatest: undefined }))).toHaveLength(3);
  });

  it('更新行はアクセント色 + dim の 2 セグメントで組む（色は theme が決める）', () => {
    const lines = bannerLines(m, { sessionCount: 0, updateLatest: '0.3.0' });
    const update = lines[lines.length - 1];
    expect(update?.segments.map((s) => s.tone)).toEqual(['accent', 'dim']);
  });

  it('使用状況は行リストに含めない（記号を持つゲージは ui 側で描く）', () => {
    const lines = rows(bannerLines(m, { sessionCount: 0, cwd: '/tmp/repo' }));
    expect(lines.join('\n')).not.toContain('Usage');
  });
});

describe('bannerUsageRows', () => {
  const window = (over: Partial<RateLimitWindow> = {}): RateLimitWindow => ({
    type: 'five_hour',
    status: 'allowed',
    utilization: 5,
    ...over,
  });

  it('枠が無ければ行を作らない（API キー利用など）', () => {
    expect(bannerUsageRows(m, [], NOW)).toEqual([]);
  });

  it('見出し・使用率・残り時間を 1 行ぶんの表示データにする', () => {
    const [row] = bannerUsageRows(m, [window({ resetsAt: NOW + (4 * 60 + 45) * 60_000 })], NOW);
    expect(row).toMatchObject({
      type: 'five_hour',
      label: 'Current session',
      percent: 5,
      percentText: '  5%',
      detail: 'resets in 4h 45m',
      tone: 'accent',
    });
  });

  it('日本語でも同じ構造で組む（ja/en を対で担保する）', () => {
    const [row] = bannerUsageRows(messages.ja, [window({ resetsAt: NOW + 285 * 60_000 })], NOW);
    expect(row?.label).toBe('現在のセッション');
    expect(row?.detail).toBe('4時間45分後にリセット');
  });

  it('見出しは表示幅で揃える（CJK 混在でもゲージの左端が揃う）', () => {
    const rows = bannerUsageRows(messages.ja, [window(), window({ type: 'seven_day_opus' })], NOW);
    // '現在のセッション' = 16 セル、'今週 (Opus)' = 11 セル → 後者に 5 セルの空白が付く。
    expect(rows.map((r) => r.label)).toEqual(['現在のセッション', '今週 (Opus)     ']);
  });

  it('使用率が無い枠は同じ幅の空白にする（0% のゲージを描かせない）', () => {
    const [row] = bannerUsageRows(m, [window({ utilization: undefined })], NOW);
    expect(row?.percent).toBeUndefined();
    expect(row?.percentText).toBe('    ');
  });

  it('残り時間が無い枠では detail を持たない', () => {
    const [row] = bannerUsageRows(m, [window()], NOW);
    expect(row?.detail).toBeUndefined();
  });

  const percentCases: [number, string][] = [
    [0, '  0%'],
    [4.4, '  4%'],
    [42.5, ' 43%'],
    [100, '100%'],
  ];
  it.each(percentCases)('使用率 %s は %s と表示する（右詰めで桁を揃える）', (utilization, text) => {
    expect(bannerUsageRows(m, [window({ utilization })], NOW)[0]?.percentText).toBe(text);
  });

  const toneCases: [RateLimitStatus, string][] = [
    ['allowed', 'accent'],
    ['allowed_warning', 'warn'],
    ['rejected', 'error'],
  ];
  it.each(toneCases)('使用枠 %s の色調は %s', (status, tone) => {
    expect(bannerUsageRows(m, [window({ status })], NOW)[0]?.tone).toBe(tone);
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
