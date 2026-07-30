import { EventEmitter } from 'node:events';
import { render as inkRender } from 'ink';
import { render } from 'ink-testing-library';
import stringWidth from 'string-width';
import { describe, expect, it } from 'vitest';
import { messages, type RateLimitWindow } from '@/core';
import { MessagesProvider } from './i18n-context';
import { StatusFooter } from './status-footer';

const NOW = 1_700_000_000_000;
const MIN = 60_000;

function renderFooter(props: Parameters<typeof StatusFooter>[0], lang: 'ja' | 'en' = 'en') {
  return render(
    <MessagesProvider value={messages[lang]}>
      <StatusFooter {...props} />
    </MessagesProvider>,
  );
}

describe('StatusFooter', () => {
  it('モード行はそのまま出す', () => {
    const { lastFrame } = renderFooter({ mode: 'auto' });
    expect(lastFrame()).toContain('auto mode on');
  });

  it('プラン情報も枠も無ければ使用状況を出さない（API キー利用など）', () => {
    const { lastFrame } = renderFooter({ mode: 'auto', hint: 'hint' });
    expect(lastFrame()).toContain('hint');
    expect(lastFrame()).not.toContain('5h');
  });

  it('プラン名を SDK 由来の文字列そのままで出す', () => {
    const { lastFrame } = renderFooter({ mode: 'auto', account: { plan: 'Claude Team' } });
    expect(lastFrame()).toContain('Claude Team');
  });

  it('使用率のある枠はゲージとパーセントで出す', () => {
    const windows: RateLimitWindow[] = [
      { type: 'five_hour', status: 'allowed', utilization: 50, resetsAt: NOW + 45 * MIN },
    ];
    const { lastFrame } = renderFooter({ mode: 'auto', usage: windows, now: NOW }, 'en');
    const frame = lastFrame() ?? '';
    expect(frame).toContain('5h');
    expect(frame).toContain('████░░░░'); // 50% of 8 cells
    expect(frame).toContain('50%');
    expect(frame).toContain('45m left');
  });

  it('使用率が無い枠（実測の five_hour イベント）は残り時間だけ出す', () => {
    const windows: RateLimitWindow[] = [
      { type: 'five_hour', status: 'allowed', resetsAt: NOW + (3 * 60 + 40) * MIN },
    ];
    const frame = renderFooter({ mode: 'auto', usage: windows, now: NOW }, 'en').lastFrame() ?? '';
    expect(frame).toContain('3h 40m left');
    expect(frame).not.toContain('%');
    expect(frame).not.toContain('░');
  });

  it('日本語カタログでも枠見出しと残り時間を出す', () => {
    const windows: RateLimitWindow[] = [
      { type: 'seven_day', status: 'allowed', utilization: 48, resetsAt: NOW + 2 * 1440 * MIN },
    ];
    const frame = renderFooter({ mode: 'auto', usage: windows, now: NOW }, 'ja').lastFrame() ?? '';
    expect(frame).toContain('今週');
    expect(frame).toContain('48%');
    expect(frame).toContain('残り2日0時間');
  });

  it('広い端末でも最大2枠までしか出さない（1行に収める）', () => {
    const windows: RateLimitWindow[] = [
      { type: 'five_hour', status: 'allowed', utilization: 1 },
      { type: 'seven_day', status: 'allowed', utilization: 2 },
      { type: 'seven_day_opus', status: 'allowed', utilization: 3 },
    ];
    // 2枠出せる幅（閾値以上）で確認する。狭い端末では 1 枠に縮退する。
    const { frame } = renderAtWidth(130, { windows, lang: 'en' });
    expect(frame).toContain('5h');
    expect(frame).toContain('week ');
    expect(frame).not.toContain('week Opus');
  });

  it('使用率 0% でもゲージは空で出す（未使用が読める）', () => {
    const windows: RateLimitWindow[] = [{ type: 'five_hour', status: 'allowed', utilization: 0 }];
    const frame = renderFooter({ mode: 'auto', usage: windows, now: NOW }, 'en').lastFrame() ?? '';
    expect(frame).toContain('░░░░░░░░');
    expect(frame).toContain('0%');
  });
});

/**
 * 幅ごとの段階的縮退。**フッタはどの幅でも1行**（折り返すとログの行を奪う）で、
 * 使用状況は「枠を減らす → ゲージを落とす → プラン名を落とす → 出さない」の順に
 * 削れていく。閾値（core/layout.ts の usageFooterPlan）が実際の描画で妥当かを
 * ここで検証する。ink-testing-library は幅 100 固定なので自前の stdout を使う。
 */
class FakeStdout extends EventEmitter {
  readonly rows = 6;
  readonly frames: string[] = [];
  constructor(readonly columns: number) {
    super();
  }
  write = (frame: string) => {
    this.frames.push(frame);
    return true;
  };
}

const WINDOWS: RateLimitWindow[] = [
  { type: 'five_hour', status: 'allowed', utilization: 50, resetsAt: NOW + 45 * MIN },
  { type: 'seven_day', status: 'allowed', utilization: 48, resetsAt: NOW + 2 * 1440 * MIN },
];

/**
 * 最長ケース: 長いプラン名 + 長いラベル（`今週Opus` / `今週Sonnet`）+ 3桁% +
 * 複数日の残り時間。閾値を典型ケースで決めると、この組み合わせで数字の途中が
 * 黙って切れる（実際に起きた）。
 */
const WIDEST_WINDOWS: RateLimitWindow[] = [
  {
    type: 'seven_day_opus',
    status: 'allowed',
    utilization: 100,
    resetsAt: NOW + (6 * 1440 + 23 * 60) * MIN,
  },
  {
    type: 'seven_day_sonnet',
    status: 'allowed',
    utilization: 100,
    resetsAt: NOW + (6 * 1440 + 23 * 60) * MIN,
  },
];
const WIDEST_PLAN = 'Claude Enterprise';

function renderAtWidth(
  columns: number,
  opts: { plan?: string; windows?: RateLimitWindow[]; lang?: 'ja' | 'en' } = {},
) {
  const stdout = new FakeStdout(columns);
  const app = inkRender(
    <MessagesProvider value={messages[opts.lang ?? 'ja']}>
      <StatusFooter
        mode="auto"
        // 実際の一覧ビューのヒント程度の長さ（最初に削られる枠）。
        hint="Tab: 一覧 / Enter: 送信 / /help: コマンド"
        account={{ plan: opts.plan ?? 'Claude Team' }}
        usage={opts.windows ?? WINDOWS}
        now={NOW}
      />
    </MessagesProvider>,
    {
      stdout: stdout as unknown as NodeJS.WriteStream,
      patchConsole: false,
      exitOnCtrlC: false,
      debug: true,
    },
  );
  const frame = stdout.frames.at(-1) ?? '';
  app.unmount();
  const lines = frame.split('\n').filter((l) => l.trim().length > 0);
  return { lines, frame };
}

/** 各段の境界（しきい値とその1つ下）と極端な幅。 */
const WIDTHS = [200, 130, 116, 115, 100, 81, 80, 79, 63, 62, 61, 51, 50, 49, 40, 30, 20];

describe('StatusFooter の幅ごとの縮退', () => {
  it.each(WIDTHS)('幅 %s でも1行に収まる', (columns) => {
    const { lines } = renderAtWidth(columns);
    expect(lines).toHaveLength(1);
    expect(stringWidth(lines[0] ?? '')).toBeLessThanOrEqual(columns);
  });

  it.each(WIDTHS)(
    '幅 %s: 最長の文言（Enterprise + 今週Sonnet + 100% + 複数日）でも溢れない',
    (columns) => {
      const { lines } = renderAtWidth(columns, {
        plan: WIDEST_PLAN,
        windows: WIDEST_WINDOWS,
        lang: 'ja',
      });
      expect(lines).toHaveLength(1);
      expect(stringWidth(lines[0] ?? '')).toBeLessThanOrEqual(columns);
    },
  );

  it.each(WIDTHS)('幅 %s: 英語カタログの最長文言でも溢れない', (columns) => {
    const { lines } = renderAtWidth(columns, {
      plan: WIDEST_PLAN,
      windows: WIDEST_WINDOWS,
      lang: 'en',
    });
    expect(lines).toHaveLength(1);
    expect(stringWidth(lines[0] ?? '')).toBeLessThanOrEqual(columns);
  });

  it.each([
    // [幅, プラン名, 2つ目の枠, ゲージ, 5時間枠]
    [130, true, true, true, true],
    [116, true, true, true, true],
    [115, true, false, true, true],
    [80, true, false, true, true],
    [79, false, false, true, true],
    [62, false, false, true, true],
    [61, false, false, false, true],
    [50, false, false, false, true],
    [49, false, false, false, false],
  ])('幅 %s: プラン=%s 2枠目=%s ゲージ=%s 5時間枠=%s', (columns, plan, second, bar, first) => {
    const { frame } = renderAtWidth(columns);
    expect(frame.includes('Claude Team')).toBe(plan);
    expect(frame.includes('今週')).toBe(second);
    expect(frame.includes('░')).toBe(bar);
    expect(frame.includes('5時間')).toBe(first);
    // ゲージを落とした幅でも使用率そのものは残す（数字が一番効く情報）。
    expect(frame.includes('50%')).toBe(first);
  });

  it('プラン名も枠も出せない幅ではモード表示だけが残る', () => {
    const { frame } = renderAtWidth(40);
    expect(frame).toContain('自動モード');
    expect(frame).not.toContain('5時間');
  });
});
