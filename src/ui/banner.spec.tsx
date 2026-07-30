import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { type BannerLine, bannerLines, bannerText, messages } from '@/core';
import { Banner } from './banner';

const NOW = 1_000_000_000_000;
const CWD = '/Users/hoge/codiva';

// 色が有効な環境でも比較できるように装飾（SGR）を落とす。制御文字を正規表現リテラルに
// 書くと Biome の noControlCharactersInRegex に触れるので組み立てる。
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

/** The header lines for a typical startup state (no usage windows unless given). */
function lines(overrides: Partial<Parameters<typeof bannerLines>[1]> = {}): BannerLine[] {
  return bannerLines(messages.en, {
    sessionCount: 1,
    version: '0.1.5',
    model: 'sonnet',
    cwd: CWD,
    now: NOW,
    ...overrides,
  });
}

/** Rendered frame with styling stripped (the text a terminal would show). */
function frameOf(element: Parameters<typeof render>[0]): string {
  return (render(element).lastFrame() ?? '').replace(ANSI, '');
}

describe('Banner', () => {
  it('マスコットと各行を描画する', () => {
    const frame = frameOf(<Banner lines={lines()} />);
    expect(frame).toContain('█'); // マスコット
    expect(frame).toContain('Codiva v0.1.5');
    expect(frame).toContain('model: sonnet');
    expect(frame).toContain(CWD);
    expect(frame.indexOf('model: sonnet')).toBeLessThan(frame.indexOf(CWD));
  });

  it('使用状況節の空行も 1 行として描く（行 index = 表示行を保つ）', () => {
    const withUsage = lines({
      rateLimits: [{ type: 'five_hour', status: 'allowed', utilization: 5, resetsAt: NOW }],
    });
    const rows = frameOf(<Banner lines={withUsage} />).split('\n');
    const heading = rows.findIndex((l) => l.includes('Usage'));
    const cwdRow = rows.findIndex((l) => l.includes(CWD));
    expect(cwdRow).toBeGreaterThanOrEqual(0);
    // cwd 行 → 空行 → 見出し。ここが 1 になったら空行が潰れており、マウスの
    // 当たり判定（行 index = 表示行）がズレる。
    expect(heading - cwdRow).toBe(2);
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
});
