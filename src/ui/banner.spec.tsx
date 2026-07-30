import { EventEmitter } from 'node:events';
import { render as inkRender } from 'ink';
import { render } from 'ink-testing-library';
import stringWidth from 'string-width';
import { describe, expect, it } from 'vitest';
import { type BannerLine, bannerLines, bannerText, messages, type RateLimitWindow } from '@/core';
import { Banner } from './banner';
import { MessagesProvider } from './i18n-context';

const NOW = 1_000_000_000_000;
const CWD = '/Users/hoge/codiva';

// 色が有効な環境でも比較できるように装飾（SGR）を落とす。制御文字を正規表現リテラルに
// 書くと Biome の noControlCharactersInRegex に触れるので組み立てる。
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

/** The header lines for a typical startup state. */
function lines(overrides: Partial<Parameters<typeof bannerLines>[1]> = {}): BannerLine[] {
  return bannerLines(messages.en, {
    sessionCount: 1,
    version: '0.1.5',
    model: 'sonnet',
    cwd: CWD,
    ...overrides,
  });
}

/** Rendered frame with styling stripped (the text a terminal would show). */
function frameOf(element: Parameters<typeof render>[0]): string {
  return (render(element).lastFrame() ?? '').replace(ANSI, '');
}

/** ヘッダを描画するときに MessagesProvider で包む（使用状況節が文言を引くため）。 */
function frameWith(element: Parameters<typeof render>[0], lang: 'en' | 'ja' = 'en'): string {
  return frameOf(<MessagesProvider value={messages[lang]}>{element}</MessagesProvider>);
}

describe('Banner', () => {
  it('マスコットと各行を描画する', () => {
    const frame = frameWith(<Banner lines={lines()} />);
    expect(frame).toContain('█'); // マスコット
    expect(frame).toContain('Codiva v0.1.5');
    expect(frame).toContain('Model: sonnet');
    expect(frame).toContain(CWD);
    expect(frame.indexOf('Model: sonnet')).toBeLessThan(frame.indexOf(CWD));
  });

  it('プランとモデルを 1 行に並べる', () => {
    const frame = frameWith(
      <Banner lines={lines({ account: { plan: 'Claude Max', organization: undefined } })} />,
    );
    const row = frame.split('\n').find((l) => l.includes('Model: sonnet')) ?? '';
    expect(row).toContain('Plan: Claude Max');
  });

  it('使用状況はゲージ + パーセント + 残り時間で描く', () => {
    const frame = frameWith(
      <Banner
        lines={lines()}
        now={NOW}
        usage={[
          {
            type: 'five_hour',
            status: 'allowed',
            utilization: 50,
            resetsAt: NOW + 45 * 60_000,
          },
        ]}
      />,
    );
    const row = frame.split('\n').find((l) => l.includes('Current session')) ?? '';
    expect(row).toContain('█'); // 使用済みのセル
    expect(row).toContain('░'); // 残りのセル
    expect(row).toContain('50%');
    expect(row).toContain('resets in 45m');
    // 見出し（Usage）は cwd 行より下、1 行空けて出る。
    const rows = frame.split('\n');
    const heading = rows.findIndex((l) => l.includes('Usage'));
    const cwdRow = rows.findIndex((l) => l.includes(CWD));
    expect(heading - cwdRow).toBe(2);
  });

  it('使用率が取れない枠ではゲージを描かず残り時間だけを出す', () => {
    const frame = frameWith(
      <Banner
        lines={lines()}
        now={NOW}
        usage={[{ type: 'seven_day', status: 'allowed', resetsAt: NOW + 45 * 60_000 }]}
      />,
    );
    const row = frame.split('\n').find((l) => l.includes('This week')) ?? '';
    expect(row).not.toContain('░');
    expect(row).not.toContain('%');
    expect(row).toContain('resets in 45m');
  });

  it('使用リミットが無ければ使用状況節を出さない（API キー利用など）', () => {
    expect(frameWith(<Banner lines={lines()} />)).not.toContain('Usage');
  });

  it('使用状況は選択可能なテキスト（bannerText）に含まれない', () => {
    // ゲージの記号は theme が持ち、行はコピー対象でもないので textRef の外に描く。
    const value = lines();
    expect(bannerText(value)).not.toContain('Usage');
  });

  it('複数の枠でゲージの左端が揃う（見出しは表示幅でパディングされる）', () => {
    const frame = frameWith(
      <Banner
        lines={lines()}
        now={NOW}
        usage={[
          { type: 'five_hour', status: 'allowed', utilization: 42 },
          { type: 'seven_day_opus', status: 'allowed', utilization: 90 },
        ]}
      />,
      'ja',
    );
    // 使用率（`%`）の列で見る。ゲージ記号（█）はマスコットにも出るので使えない。
    // 見出しのパディングとゲージ幅が揃っていて初めてこの列が一致する。
    const percentColumns = frame
      .split('\n')
      .filter((l) => l.includes('%'))
      .map((l) => stringWidth(l.slice(0, l.indexOf('%'))));
    expect(percentColumns).toHaveLength(2);
    expect(percentColumns[0]).toBe(percentColumns[1]);
  });

  it('選択範囲は装飾だけで、表示テキストは変わらない', () => {
    const value = lines();
    const start = bannerText(value).indexOf(CWD);
    const plain = frameOf(<Banner lines={value} />);
    const selected = frameOf(
      <Banner lines={value} selection={{ start, end: start + CWD.length }} />,
    );
    // 文字の落ち・重複（セグメント分割のバグ）をここで捕まえる。
    expect(selected).toBe(plain);
  });

  it('セグメントを跨ぐ選択でも文字を落とさない', () => {
    // ワードマーク行は Codiva / バージョン / セッション数の複数セグメント。
    const value = lines();
    const frame = frameOf(<Banner lines={value} selection={{ start: 0, end: 12 }} />);
    expect(frame).toContain('Codiva v0.1.5');
  });

  it('学習データ利用が ON なら注意行と変更先 URL を出す', () => {
    const frame = frameOf(
      <MessagesProvider value={messages.en}>
        <Banner lines={lines()} trainingOptIn="on" />
      </MessagesProvider>,
    );
    // 端末幅で折り返されうるので、行頭側の短い断片と URL だけを見る。
    expect(frame).toContain('data sharing is ON');
    expect(frame).toContain('https://claude.ai/settings/data-privacy-controls');
  });

  it('日本語でも学習データ利用の注意行を出す', () => {
    const frame = frameOf(
      <MessagesProvider value={messages.ja}>
        <Banner lines={lines()} trainingOptIn="on" />
      </MessagesProvider>,
    );
    expect(frame).toContain('学習データ利用が ON');
  });

  it.each([['off'], ['unknown'], [undefined]] as const)(
    '学習データ利用が %s のときは何も出さない',
    (trainingOptIn) => {
      const frame = frameOf(
        <MessagesProvider value={messages.en}>
          <Banner lines={lines()} trainingOptIn={trainingOptIn} />
        </MessagesProvider>,
      );
      expect(frame).not.toContain('data sharing');
    },
  );

  it('注意行は選択可能なテキスト（bannerText）に含まれない', () => {
    // ヘッダのドラッグ選択は bannerText への caret index。注意行はその外（textRef の外）に
    // 描くので、警告が出ていても選択対象のテキストは変わらない = 当たり判定がズレない。
    const value = lines();
    expect(bannerText(value)).not.toContain('data sharing is ON');
    const frame = frameOf(
      <MessagesProvider value={messages.en}>
        <Banner lines={value} trainingOptIn="on" />
      </MessagesProvider>,
    );
    // 描画上は cwd 行より下に出る。
    expect(frame.indexOf(CWD)).toBeLessThan(frame.indexOf('data sharing is ON'));
  });
});

/**
 * 幅ごとの縮退。ヘッダはフッタと違って縦に伸びてよいが、**マスコットは折り返しては
 * いけない** — truncate を持たないアスキーアートなので、横に縮められると 6 行の絵が
 * バラバラの行に散る。80 桁（もっとも一般的な既定幅）で崩れないことをここで固定する。
 */
describe('Banner の幅ごとの縮退', () => {
  /** 実端末幅を指定して描画するための stdout スタブ（`status-footer.spec.tsx` と同じ手法）。 */
  class FakeStdout extends EventEmitter {
    readonly rows = 24;
    readonly frames: string[] = [];
    constructor(readonly columns: number) {
      super();
    }
    write = (frame: string) => {
      this.frames.push(frame);
      return true;
    };
  }

  /** マスコットの 6 行（`banner.tsx` の LOGO と同じ。折り返すとこの並びが frame から消える）。 */
  const MASCOT = [
    ' ▄▄ ▄▄▄▄▄▄▄ ▄▄',
    ' █████████████',
    '██▀██▀███▀██▀██',
    '██ █ █ ▀ █ █ ██',
    '██ █       █ ██',
    '▀   ▀▀▀▀▀▀▀   ▀',
  ];

  const WIDE_USAGE: RateLimitWindow[] = [
    // ja の最長ケース: 見出しが長い枠 + 3 桁% + 複数日の残り時間。
    { type: 'five_hour', status: 'allowed', utilization: 100, resetsAt: NOW + 285 * 60_000 },
    {
      type: 'seven_day_sonnet',
      status: 'allowed_warning',
      utilization: 100,
      resetsAt: NOW + (3 * 1440 + 23 * 60) * 60_000,
    },
  ];

  function frameAtWidth(columns: number): string {
    const stdout = new FakeStdout(columns);
    const app = inkRender(
      <MessagesProvider value={messages.ja}>
        <Banner
          lines={bannerLines(messages.ja, {
            sessionCount: 3,
            version: '0.3.1',
            model: 'claude-sonnet-5',
            cwd: '/Users/hoge/RustroverProjects/codiva/.codiva/worktrees/some-long-slug',
            account: { plan: 'Claude Enterprise', organization: 'Example Inc' },
          })}
          now={NOW}
          usage={WIDE_USAGE}
        />
      </MessagesProvider>,
      {
        stdout: stdout as unknown as NodeJS.WriteStream,
        patchConsole: false,
        exitOnCtrlC: false,
        debug: true,
      },
    );
    const frame = (stdout.frames.at(-1) ?? '').replace(ANSI, '');
    app.unmount();
    return frame;
  }

  const WIDTHS = [200, 120, 100, 88, 87, 80, 79, 76, 75, 60, 40, 20];

  it.each(WIDTHS)('幅 %s でもマスコットが折り返さない', (columns) => {
    const frame = frameAtWidth(columns);
    for (const row of MASCOT) {
      expect(frame).toContain(row);
    }
  });

  // 極端に狭い幅（マスコット 17 セルの右に見出しが入らない）では見出しごと切れるので、
  // 「行が幅を超えない」の検証は見出しが残る幅だけで行う。
  it.each(WIDTHS.filter((columns) => columns >= 40))(
    '幅 %s でも使用状況の行が端末幅を超えない',
    (columns) => {
      const usageRows = frameAtWidth(columns)
        .split('\n')
        .filter((l) => l.includes('現在のセッション') || l.includes('今週'));
      expect(usageRows.length).toBeGreaterThan(0);
      for (const line of usageRows) {
        expect(stringWidth(line)).toBeLessThanOrEqual(columns);
      }
    },
  );

  it('狭い端末ではゲージを落として使用率と残り時間を残す', () => {
    const narrow = frameAtWidth(70);
    expect(narrow).toContain('100%');
    expect(narrow).toContain('後にリセット');
    expect(narrow).not.toContain('░');
  });
});
