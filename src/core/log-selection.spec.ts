import { describe, expect, it } from 'vitest';
import {
  compareLogPoints,
  type LogPoint,
  type LogViewport,
  logCaretAt,
  logEdgeAt,
  logEdgePoint,
  logLinkAt,
  logRowAt,
  logRowSelection,
  logSelectionText,
  normalizeLogSelection,
} from './log-selection';
import { type DisplayLine, logWindow } from './scroll';

/** `logLines` の出力を模した行（このモジュールが読むのは `text` だけ）。 */
function line(text: string, i = 0): DisplayLine {
  return { key: `${i}:0`, kind: 'assistant_text', text };
}

const LINES: DisplayLine[] = ['alpha', 'bravo', '', 'delta', '日本語の行'].map(line);

/** 可視域: 上端 y=5, 左端 x=2, 高さ 3, 文書の 1 行目から 3 行ぶんを描いている。 */
const VIEW: LogViewport = { top: 5, left: 2, height: 3, firstRow: 1, rows: 3 };

describe('compareLogPoints / normalizeLogSelection', () => {
  const cases: [LogPoint, LogPoint, number][] = [
    [{ row: 1, col: 2 }, { row: 1, col: 2 }, 0],
    [{ row: 1, col: 2 }, { row: 1, col: 3 }, -1],
    [{ row: 2, col: 0 }, { row: 1, col: 9 }, 1],
  ];
  it.each(cases)('compare(%o, %o) の符号', (a, b, sign) => {
    expect(Math.sign(compareLogPoints(a, b))).toBe(sign);
  });

  it('アンカーと終点の順序に関わらず start ≤ end に正規化する', () => {
    const a = { row: 1, col: 4 };
    const b = { row: 3, col: 1 };
    expect(normalizeLogSelection(a, b)).toEqual({ start: a, end: b });
    expect(normalizeLogSelection(b, a)).toEqual({ start: a, end: b });
  });

  it('同じ点（クリックだけ）は選択なし', () => {
    expect(normalizeLogSelection({ row: 2, col: 3 }, { row: 2, col: 3 })).toBeUndefined();
  });
});

describe('logRowAt / logCaretAt', () => {
  // 高さ 3 に 3 行 → 隙間なし。y=5,6,7 が文書行 1,2,3。
  const cases: [number, number | undefined][] = [
    [4, undefined], // 可視域の上
    [5, 1],
    [7, 3],
    [8, undefined], // 可視域の下
  ];
  it.each(cases)('y=%i → 行 %o', (y, row) => {
    expect(logRowAt(VIEW, y)).toBe(row);
  });

  it('行数が高さに足りないときは末尾寄せの隙間ぶん下から始まる', () => {
    // 高さ 5 に 2 行 → 上に 3 行の隙間。y=8,9 が文書行 1,2。
    const view: LogViewport = { ...VIEW, height: 5, rows: 2 };
    expect(logRowAt(view, 7)).toBeUndefined();
    expect(logRowAt(view, 8)).toBe(1);
    expect(logRowAt(view, 9)).toBe(2);
    expect(logRowAt(view, 10)).toBeUndefined();
  });

  // 状態行（プレビュー / スクロール案内）は**ログ枠の外**にあるので、ログの可視域は
  // それに左右されない（`rows` はいつでも描いたログ行数そのもの）。
  it('可視域の下（状態行の側）はログ行として当たらない', () => {
    const view: LogViewport = { ...VIEW, height: 2, rows: 2 };
    expect(logRowAt(view, 5)).toBe(1);
    expect(logRowAt(view, 6)).toBe(2);
    expect(logRowAt(view, 7)).toBeUndefined(); // 可視域の外 = 状態行
  });

  it('桁は表示幅で逆算し、行末より右は行末に丸める', () => {
    expect(logCaretAt(LINES, VIEW, 2, 5)).toEqual({ row: 1, col: 0 }); // 'bravo' の先頭
    expect(logCaretAt(LINES, VIEW, 4, 5)).toEqual({ row: 1, col: 2 });
    expect(logCaretAt(LINES, VIEW, 99, 5)).toEqual({ row: 1, col: 5 }); // 行末へ丸め
    expect(logCaretAt(LINES, VIEW, 0, 5)).toEqual({ row: 1, col: 0 }); // 左端より左
    expect(logCaretAt(LINES, VIEW, 5, 8)).toBeUndefined(); // 可視域の外
  });

  it('全角は 2 セルとして数える', () => {
    // 文書行 4 = '日本語の行' を先頭に描くビュー。
    const view: LogViewport = { ...VIEW, firstRow: 4, rows: 1, height: 1 };
    expect(logCaretAt(LINES, view, 2, 5)).toEqual({ row: 4, col: 0 });
    expect(logCaretAt(LINES, view, 4, 5)).toEqual({ row: 4, col: 1 }); // 2 セル進んで 1 文字
    expect(logCaretAt(LINES, view, 6, 5)).toEqual({ row: 4, col: 2 });
  });
});

describe('logEdgeAt / logEdgePoint', () => {
  const cases: [number, 'up' | 'down' | undefined][] = [
    [3, 'up'],
    [4, 'up'],
    [5, undefined],
    [7, undefined],
    [8, 'down'],
    [20, 'down'], // コンポーザの上まで出ても down
  ];
  it.each(cases)('y=%i → %o', (y, edge) => {
    expect(logEdgeAt(VIEW, y)).toBe(edge);
  });

  it('末尾寄せの隙間（可視域内だが行より上）も up 扱い', () => {
    expect(logEdgeAt({ ...VIEW, height: 6, rows: 2 }, 6)).toBe('up');
  });

  it('自動スクロール中の終点は上端行の行頭 / 末尾行の行末', () => {
    const win = logWindow(LINES, 3, 4); // 文書行 1..3 を表示
    expect(logEdgePoint(win, 'up')).toEqual({ row: 1, col: 0 });
    expect(logEdgePoint(win, 'down')).toEqual({ row: 3, col: 'delta'.length });
  });

  it('1 行も描いていないときも点を返す（0 行のログ）', () => {
    expect(logEdgePoint(logWindow([], 3, 'bottom'), 'down')).toEqual({ row: 0, col: 0 });
  });
});

describe('logRowSelection', () => {
  const range = { start: { row: 1, col: 2 }, end: { row: 3, col: 3 } };
  const cases: [number, number, { from: number; to: number } | undefined][] = [
    [0, 5, undefined], // 範囲の前
    [1, 5, { from: 2, to: 5 }], // 開始行は col から行末まで
    [2, 6, { from: 0, to: 6 }], // 中間行は行全体
    [3, 5, { from: 0, to: 3 }], // 終了行は行頭から col まで
    [4, 5, undefined], // 範囲の後
    [2, 0, undefined], // 範囲に含まれる空行は光らせるものが無い
  ];
  it.each(cases)('row=%i length=%i → %o', (row, length, expected) => {
    expect(logRowSelection(range, row, length)).toEqual(expected);
  });

  it('1 行内の選択は col の範囲だけ', () => {
    const single = { start: { row: 2, col: 1 }, end: { row: 2, col: 4 } };
    expect(logRowSelection(single, 2, 9)).toEqual({ from: 1, to: 4 });
    expect(logRowSelection(single, 1, 9)).toBeUndefined();
  });

  it('col が行の長さを超えていても行末で止まる（幅が変わった残り）', () => {
    expect(logRowSelection({ start: { row: 1, col: 0 }, end: { row: 1, col: 99 } }, 1, 4)).toEqual({
      from: 0,
      to: 4,
    });
  });
});

describe('logSelectionText', () => {
  it('複数行は表示どおり改行で繋ぐ（空行も 1 行として残る）', () => {
    const range = { start: { row: 1, col: 3 }, end: { row: 3, col: 2 } };
    expect(logSelectionText(LINES, range)).toBe('vo\n\nde');
  });

  it('1 行内はその部分だけ', () => {
    expect(logSelectionText(LINES, { start: { row: 0, col: 1 }, end: { row: 0, col: 4 } })).toBe(
      'lph',
    );
  });

  it('文書の末尾を越える終点は最後の行で打ち切る', () => {
    const range = { start: { row: 4, col: 0 }, end: { row: 9, col: 0 } };
    expect(logSelectionText(LINES, range)).toBe('日本語の行');
  });

  it('全行の選択は全文を返す', () => {
    const range = { start: { row: 0, col: 0 }, end: { row: 4, col: 5 } };
    expect(logSelectionText(LINES, range)).toBe('alpha\nbravo\n\ndelta\n日本語の行');
  });
});

describe('logLinkAt', () => {
  const URL = 'https://x.dev/a';
  /** 行 1 = `ab https://x.dev/a` （URL は 3..18）。可視域は VIEW（left=2, 先頭行=1）。 */
  const linked: DisplayLine[] = [
    line('row0'),
    { key: '1:0', kind: 'system', text: `ab ${URL}`, links: [{ from: 3, to: 18, url: URL }] },
    line('row2', 2),
  ];

  it('URL の上をクリックすると URL を返す', () => {
    // 文書行 1 は可視域の 1 行目（y = top = 5）。x = left + col。
    expect(logLinkAt(linked, VIEW, 2 + 3, 5)).toBe(URL);
    expect(logLinkAt(linked, VIEW, 2 + 10, 5)).toBe(URL);
    expect(logLinkAt(linked, VIEW, 2 + 17, 5)).toBe(URL);
  });

  it('URL の手前・直後は返さない', () => {
    expect(logLinkAt(linked, VIEW, 2 + 0, 5)).toBeUndefined();
    expect(logLinkAt(linked, VIEW, 2 + 2, 5)).toBeUndefined();
  });

  it('行末より右の余白は当たりにしない（丸めない）', () => {
    // 行の表示幅は 18。col 18 以上は URL で終わる行でも undefined。
    expect(logLinkAt(linked, VIEW, 2 + 18, 5)).toBeUndefined();
    expect(logLinkAt(linked, VIEW, 2 + 40, 5)).toBeUndefined();
  });

  it('可視域の左外は当たりにしない', () => {
    expect(logLinkAt(linked, VIEW, 0, 5)).toBeUndefined();
  });

  it('links を持たない行・ログ行の外は undefined', () => {
    expect(logLinkAt(linked, VIEW, 2 + 1, 6)).toBeUndefined(); // 文書行 2（links なし）
    expect(logLinkAt(linked, VIEW, 2 + 1, 99)).toBeUndefined(); // ログ行の外
  });

  it('選択のアンカー（logCaretAt）とは違い、行末で丸めない', () => {
    // 同じ座標で logCaretAt は「行末」を返す = 選択は始められる。
    expect(logCaretAt(linked, VIEW, 2 + 40, 5)).toEqual({ row: 1, col: 18 });
    expect(logLinkAt(linked, VIEW, 2 + 40, 5)).toBeUndefined();
  });

  it('CJK を含む行でも表示幅で当たる', () => {
    const lines: DisplayLine[] = [
      line('row0'),
      {
        key: '1:0',
        kind: 'system',
        // '日本語 ' = 7 セル（3 文字 + 空白）。URL は文字 index 4..19。
        text: `日本語 ${URL}`,
        links: [{ from: 4, to: 19, url: URL }],
      },
    ];
    expect(logLinkAt(lines, VIEW, 2 + 7, 5)).toBe(URL); // URL 先頭のセル
    expect(logLinkAt(lines, VIEW, 2 + 1, 5)).toBeUndefined(); // 日本語の上
  });
});
