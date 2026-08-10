import { describe, expect, it } from 'vitest';
import { COMMANDS } from './commands';
import {
  BANNER_ROWS,
  bannerGaugeWidth,
  DETAIL_CHROME_ROWS,
  DIALOG_CHROME_COLUMNS,
  dialogContentWidth,
  isFullscreenViewport,
  LIST_CHROME_ROWS,
  listView,
  listViewportRows,
  logViewportRows,
  MIN_BRANCH_COLUMN_COLUMNS,
  MIN_FULLSCREEN_ROWS,
  PALETTE_MIN_ROWS,
  paletteMaxRows,
  showsBranchColumn,
} from './layout';

describe('isFullscreenViewport', () => {
  it.each([
    [MIN_FULLSCREEN_ROWS - 1, false],
    [MIN_FULLSCREEN_ROWS, true],
    [8, false],
    [24, true],
    [0, false],
  ])('rows=%d → %s', (rows, expected) => {
    expect(isFullscreenViewport(rows)).toBe(expected);
  });
});

describe('showsBranchColumn', () => {
  it.each([
    [MIN_BRANCH_COLUMN_COLUMNS - 1, false],
    [MIN_BRANCH_COLUMN_COLUMNS, true],
    [40, false],
    [120, true],
    [0, false],
  ])('columns=%d → %s', (columns, expected) => {
    expect(showsBranchColumn(columns)).toBe(expected);
  });
});

describe('dialogContentWidth', () => {
  it.each([
    [100, 94],
    [80, 74],
    [40, 34],
    // 極端に狭い端末では下限で止める（1 セルずつ折返して縦に爆発させない）。
    [12, 10],
    [4, 10],
    [0, 10],
  ])('columns=%d → %d', (columns, expected) => {
    expect(dialogContentWidth(columns)).toBe(expected);
  });

  it('leaves room for the view padding, the border and the dialog padding', () => {
    expect(dialogContentWidth(100)).toBe(100 - DIALOG_CHROME_COLUMNS);
  });
});

describe('logViewportRows', () => {
  it('subtracts the fixed chrome from the terminal height', () => {
    expect(logViewportRows(30)).toBe(30 - DETAIL_CHROME_ROWS);
  });

  it('never returns less than 1, even on tiny terminals', () => {
    expect(logViewportRows(DETAIL_CHROME_ROWS)).toBe(1);
    expect(logViewportRows(0)).toBe(1);
  });
});

describe('listView', () => {
  /** 描画行数（項目 + 表示インジケータ）は cap を超えない、という不変条件。 */
  const renderedRows = (v: ReturnType<typeof listView>) =>
    v.end - v.start + (v.showAbove ? 1 : 0) + (v.showBelow ? 1 : 0);

  it('shows everything and no indicators when the list fits', () => {
    expect(listView(3, 0, 10)).toEqual({
      start: 0,
      end: 3,
      hiddenAbove: 0,
      hiddenBelow: 0,
      showAbove: false,
      showBelow: false,
    });
  });

  it('shows everything when total equals cap', () => {
    const v = listView(5, 4, 5);
    expect(v).toEqual({
      start: 0,
      end: 5,
      hiddenAbove: 0,
      hiddenBelow: 0,
      showAbove: false,
      showBelow: false,
    });
  });

  it('at the top: only a below indicator, selection visible', () => {
    const v = listView(10, 0, 5);
    expect(v.start).toBe(0);
    expect(v.showAbove).toBe(false);
    expect(v.showBelow).toBe(true);
    expect(v.hiddenBelow).toBe(10 - v.end);
    expect(0).toBeGreaterThanOrEqual(v.start);
    expect(0).toBeLessThan(v.end);
    expect(renderedRows(v)).toBe(5);
  });

  it('at the bottom: only an above indicator, selection visible', () => {
    const v = listView(10, 9, 5);
    expect(v.end).toBe(10);
    expect(v.showAbove).toBe(true);
    expect(v.showBelow).toBe(false);
    expect(9).toBeGreaterThanOrEqual(v.start);
    expect(9).toBeLessThan(v.end);
    expect(renderedRows(v)).toBe(5);
  });

  it('in the middle: both indicators, selection visible', () => {
    const v = listView(20, 10, 5);
    expect(v.showAbove).toBe(true);
    expect(v.showBelow).toBe(true);
    expect(10).toBeGreaterThanOrEqual(v.start);
    expect(10).toBeLessThan(v.end);
    expect(renderedRows(v)).toBe(5);
  });

  it('keeps the selection visible for every index without overflowing cap', () => {
    const total = 30;
    const cap = 7;
    for (let sel = 0; sel < total; sel++) {
      const v = listView(total, sel, cap);
      expect(sel, `sel=${sel} start`).toBeGreaterThanOrEqual(v.start);
      expect(sel, `sel=${sel} end`).toBeLessThan(v.end);
      expect(renderedRows(v), `sel=${sel} rows`).toBeLessThanOrEqual(cap);
      expect(v.showAbove).toBe(v.start > 0);
      expect(v.showBelow).toBe(v.end < total);
    }
  });

  it('shows the last item instead of a "1 more" indicator (second-from-bottom selected)', () => {
    // 画面が埋まった状態で下から2番目を選ぶと、従来は末尾1件が「↓ 他 1 件」に
    // 化けていた。インジケータではなくその実項目を表示する。
    const v = listView(10, 8, 5);
    expect(v.end).toBe(10); // 末尾の項目まで表示
    expect(v.showBelow).toBe(false); // 「↓ 他 1 件」は出さない
    expect(v.hiddenBelow).toBe(0);
    expect(8).toBeGreaterThanOrEqual(v.start);
    expect(8).toBeLessThan(v.end);
    expect(renderedRows(v)).toBe(5); // 描画行数は cap のまま
  });

  it('never shows an indicator that hides only one item (shows the item instead)', () => {
    for (const total of [6, 7, 10, 15, 30]) {
      for (let cap = 2; cap <= 9; cap++) {
        for (let sel = 0; sel < total; sel++) {
          const v = listView(total, sel, cap);
          const at = `total=${total} cap=${cap} sel=${sel}`;
          if (v.showBelow) {
            expect(v.hiddenBelow, `${at} below`).toBeGreaterThan(1);
          }
          if (v.showAbove) {
            expect(v.hiddenAbove, `${at} above`).toBeGreaterThan(1);
          }
          expect(sel, `${at} start`).toBeGreaterThanOrEqual(v.start);
          expect(sel, `${at} end`).toBeLessThan(v.end);
          expect(renderedRows(v), `${at} rows`).toBeLessThanOrEqual(cap);
        }
      }
    }
  });

  it('never overflows a tiny cap (drops indicators, keeps one content row)', () => {
    const v1 = listView(10, 5, 1);
    expect(v1.end - v1.start).toBe(1);
    expect(v1.showAbove).toBe(false);
    expect(v1.showBelow).toBe(false);
    expect(renderedRows(v1)).toBe(1);

    const v2 = listView(10, 5, 2);
    expect(renderedRows(v2)).toBe(2);
    expect(5).toBeGreaterThanOrEqual(v2.start);
    expect(5).toBeLessThan(v2.end);
  });

  it('clamps out-of-range selection', () => {
    expect(() => listView(10, 99, 5)).not.toThrow();
    const v = listView(10, 99, 5);
    expect(v.end).toBe(10);
  });
});

describe('listViewportRows', () => {
  it('subtracts the fixed list chrome from the terminal rows', () => {
    expect(listViewportRows(40)).toBe(40 - LIST_CHROME_ROWS);
    expect(listViewportRows(40)).toBe(25);
  });

  it('never returns less than 1 row', () => {
    expect(listViewportRows(10)).toBe(1);
    expect(listViewportRows(0)).toBe(1);
  });
});

describe('bannerGaugeWidth', () => {
  it.each([
    // 固定部分 68 セル + ゲージ幅が収まる最大の段を選ぶ。
    [200, 20],
    [88, 20],
    [87, 12],
    [80, 12],
    [79, 8],
    [76, 8],
    [75, 0],
    [0, 0],
  ])('幅 %s ではゲージ %s セル', (columns, expected) => {
    expect(bannerGaugeWidth(columns)).toBe(expected);
  });

  it('狭くなるほどゲージは単調に細くなる', () => {
    let prev = bannerGaugeWidth(200);
    for (let columns = 200; columns >= 0; columns--) {
      const width = bannerGaugeWidth(columns);
      expect(width).toBeLessThanOrEqual(prev);
      prev = width;
    }
  });
});

describe('paletteMaxRows', () => {
  // コマンド一覧が端末に入り切らないと Yoga がパレットの枠を潰して行が消えるので、
  // 「何行まで描いてよいか」を chrome の見積りから決める（溢れは UI が畳む）。
  it('subtracts the view chrome from the terminal rows', () => {
    expect(paletteMaxRows(40, 'list')).toBe(40 - LIST_CHROME_ROWS);
    expect(paletteMaxRows(40, 'detail')).toBe(40 - DETAIL_CHROME_ROWS - 3);
  });

  // `/help` はヘッダを隠して開くので、その 7 行を使ってよい（= 一覧より多く描ける）。
  it('gives the /help overlay the rows the hidden banner frees up', () => {
    expect(paletteMaxRows(40, 'help')).toBe(paletteMaxRows(40, 'list') + BANNER_ROWS);
  });

  // 24 行（よくある端末の下限）で全コマンドが `/help` に収まることを固定する。
  // ここが割れたらコマンドを増やしすぎ（畳まれて末尾が読めなくなる）。
  it('fits the whole command list into a 24-row terminal in /help', () => {
    expect(paletteMaxRows(24, 'help')).toBeGreaterThanOrEqual(COMMANDS.length);
  });

  it('never returns less than the minimum rows', () => {
    for (const view of ['list', 'help', 'detail'] as const) {
      expect(paletteMaxRows(0, view)).toBe(PALETTE_MIN_ROWS);
      expect(paletteMaxRows(10, view)).toBeGreaterThanOrEqual(PALETTE_MIN_ROWS);
    }
  });
});
