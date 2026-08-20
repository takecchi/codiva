import { describe, expect, it } from 'vitest';
import {
  CHOICE_DESCRIPTION_INDENT,
  type ChoiceRowItem,
  choiceIndexAtRow,
  choiceLines,
  choiceRowHeights,
  choiceView,
} from './choice-lines';

describe('choiceLines', () => {
  it('keeps a short label and its description on separate lines', () => {
    expect(choiceLines({ label: 'English', description: 'en' }, 40, '❯ ')).toEqual([
      { key: 'label:0', text: '❯ English', description: false },
      { key: 'desc:0', text: `  ${' '.repeat(CHOICE_DESCRIPTION_INDENT)}en`, description: true },
    ]);
  });

  it('wraps a long label instead of truncating it, aligning continuation rows', () => {
    const label = 'Rewrite the persistence layer so restored sessions resume lazily';
    const lines = choiceLines({ label }, 24, '❯ ');
    // 全文が残る（切り捨てられない）。折返しは端末と同じハードラップなので、
    // prefix / 字下げ（2 セル）を除いて連結すると元のラベルに戻る。
    expect(lines.map((l) => l.text.slice(2)).join('')).toBe(label);
    // 1 行目だけ prefix、以降は同じ幅の字下げ。
    expect(lines[0]?.text.startsWith('❯ ')).toBe(true);
    for (const line of lines.slice(1)) {
      expect(line.text.startsWith('  ')).toBe(true);
    }
    for (const line of lines) {
      expect(line.text.length).toBeLessThanOrEqual(24);
    }
  });

  it('wraps a long description under the label with a deeper indent', () => {
    const description = 'Uses the CLI default model and never passes --model to the SDK.';
    const lines = choiceLines({ label: 'Default', description }, 30, '❯ ');
    const descLines = lines.filter((l) => l.description);
    expect(descLines.length).toBeGreaterThan(1);
    expect(descLines.map((l) => l.text.slice(2 + CHOICE_DESCRIPTION_INDENT)).join('')).toBe(
      description,
    );
    for (const line of descLines) {
      expect(line.text.startsWith(' '.repeat(2 + CHOICE_DESCRIPTION_INDENT))).toBe(true);
    }
  });

  it('measures width in display cells so Japanese wraps where the terminal does', () => {
    // 全角 5 文字 = 10 セル。prefix 2 + 本文 4 セル → 1 行に全角 2 文字。
    const lines = choiceLines({ label: 'あいうえお' }, 6, '❯ ');
    expect(lines.map((l) => l.text)).toEqual(['❯ あい', '  うえ', '  お']);
  });

  it('honors newlines inside a description', () => {
    const lines = choiceLines({ label: 'x', description: 'first\nsecond' }, 40, '> ');
    expect(lines.filter((l) => l.description).map((l) => l.text.trim())).toEqual([
      'first',
      'second',
    ]);
  });

  const emptyDescriptions: { name: string; description: string | undefined }[] = [
    { name: 'empty', description: '' },
    { name: 'blank', description: '   ' },
    { name: 'missing', description: undefined },
  ];
  it.each(emptyDescriptions)(
    'emits only the label line for a $name description',
    ({ description }) => {
      expect(choiceLines({ label: 'Yes', description }, 40, '❯ ')).toEqual([
        { key: 'label:0', text: '❯ Yes', description: false },
      ]);
    },
  );

  it('never returns a zero-width content column for absurd widths', () => {
    const lines = choiceLines({ label: 'ab', description: 'cd' }, 1, '❯ ');
    expect(lines.map((l) => l.text)).toEqual(['❯ a', '  b', '    c', '    d']);
  });
});

describe('choiceRowHeights / choiceIndexAtRow', () => {
  // 1 件 = 1 行ではない（ラベルの折返し + 説明）ので、行数の配列がクリック逆算の土台。
  // 幅 6・prefix 2 セル → ラベルは 4 セル、説明はさらに 2 セル字下げで 2 セルに折返す。
  const items: ChoiceRowItem[] = [
    { choice: { label: 'A', description: 'first' }, prefix: '❯ ' }, // ラベル1 + 説明3 = 4 行
    { choice: { label: 'B' }, prefix: '❯ ' }, // 1 行
    { choice: { label: 'あいうえお' }, prefix: '❯ ' }, // 全角5 = 10 セル → 3 行
  ];

  it('counts the label wrap and the description rows of every item', () => {
    expect(choiceRowHeights(items, 6)).toEqual([4, 1, 3]);
  });

  const hits: { row: number; index: number | undefined }[] = [
    { row: -1, index: undefined },
    { row: 0, index: 0 }, // A のラベル行
    { row: 3, index: 0 }, // A の説明の最終行（同じ塊として選べる）
    { row: 4, index: 1 }, // B
    { row: 5, index: 2 }, // 折返した 3 件目の 1 行目
    { row: 7, index: 2 }, // 折返しの最終行
    { row: 8, index: undefined }, // リストの下（余白）
  ];
  it.each(hits)('maps row $row to choice $index', ({ row, index }) => {
    expect(choiceIndexAtRow(choiceRowHeights(items, 6), row)).toBe(index);
  });

  it('returns undefined for an empty list', () => {
    expect(choiceIndexAtRow([], 0)).toBeUndefined();
  });
});

describe('choiceView', () => {
  // 質問ダイアログの実物に近い形: 選択肢 4 件（ラベル1 + 説明1）+ 「自分で入力する」1 行。
  const heights = [2, 2, 2, 2, 1];

  it('shows every choice when the rows fit', () => {
    expect(choiceView(heights, 0, 9)).toEqual({
      start: 0,
      end: 5,
      hiddenAbove: 0,
      hiddenBelow: 0,
      showAbove: false,
      showBelow: false,
    });
  });

  it('returns an empty window for an empty list', () => {
    expect(choiceView([], 0, 5)).toEqual({
      start: 0,
      end: 0,
      hiddenAbove: 0,
      hiddenBelow: 0,
      showAbove: false,
      showBelow: false,
    });
  });

  // 端ごとにインジケータ 1 行を予約するので、描画行数（選択肢 + インジケータ）は cap 以下。
  const cases: {
    name: string;
    cursor: number;
    cap: number;
    want: ReturnType<typeof choiceView>;
  }[] = [
    {
      name: 'カーソルが先頭: 下へ隠す',
      cursor: 0,
      cap: 4,
      want: {
        start: 0,
        end: 1,
        hiddenAbove: 0,
        hiddenBelow: 4,
        showAbove: false,
        showBelow: true,
      },
    },
    {
      name: 'カーソルが末尾: 上へ隠す',
      cursor: 4,
      cap: 4,
      want: {
        start: 3,
        end: 5,
        hiddenAbove: 3,
        hiddenBelow: 0,
        showAbove: true,
        showBelow: false,
      },
    },
    {
      name: 'カーソルが途中: 両端に隠れる',
      cursor: 2,
      cap: 5,
      want: {
        start: 2,
        end: 3,
        hiddenAbove: 2,
        hiddenBelow: 2,
        showAbove: true,
        showBelow: true,
      },
    },
    {
      // 「これについて相談する」を選んでいるあいだ（cursor はこのリストの範囲外）は
      // 末尾に張り付ける。範囲外の cursor で窓が飛ばないことの番人。
      name: 'カーソルが範囲外: 末尾に丸める',
      cursor: 99,
      cap: 4,
      want: {
        start: 3,
        end: 5,
        hiddenAbove: 3,
        hiddenBelow: 0,
        showAbove: true,
        showBelow: false,
      },
    },
  ];
  it.each(cases)('$name', ({ cursor, cap, want }) => {
    const view = choiceView(heights, cursor, cap);
    expect(view).toEqual(want);
    // カーソルの件は必ず窓の中（範囲外なら末尾）。
    const sel = Math.min(cursor, heights.length - 1);
    expect(sel).toBeGreaterThanOrEqual(view.start);
    expect(sel).toBeLessThan(view.end);
    // 描画行数（選択肢 + インジケータ）が cap を超えない = ログの席を奪わない。
    const drawn =
      heights.slice(view.start, view.end).reduce((sum, rows) => sum + rows, 0) +
      (view.showAbove ? 1 : 0) +
      (view.showBelow ? 1 : 0);
    expect(drawn).toBeLessThanOrEqual(cap);
  });

  // ↓ でカーソルを送ると窓がついてくる（下端アンカー = `listView` と同じ挙動）。
  it('scrolls as the cursor moves down', () => {
    const seen = [0, 1, 2, 3, 4].map((cursor) => choiceView(heights, cursor, 4));
    for (const [cursor, view] of seen.entries()) {
      expect(cursor).toBeGreaterThanOrEqual(view.start);
      expect(cursor).toBeLessThan(view.end);
    }
    // 単調に下へ送られる（同じ窓に留まる回もあるが戻らない）。
    for (let i = 1; i < seen.length; i += 1) {
      expect(seen[i]?.start ?? 0).toBeGreaterThanOrEqual(seen[i - 1]?.start ?? 0);
    }
  });

  /**
   * 1 件が可視域より高いときは**上限を超えてもその件を出す**（選んでいるものが見えないと
   * 何を決めるのか分からない）。`paletteMaxRows` の下限と同じ「最低限は必ず見せる」方針。
   */
  it('keeps the cursor choice even when it is taller than the cap', () => {
    expect(choiceView([5, 1], 0, 2)).toEqual({
      start: 0,
      end: 1,
      hiddenAbove: 0,
      hiddenBelow: 1,
      showAbove: false,
      showBelow: true,
    });
  });

  it('treats a cap below 1 as 1 row', () => {
    expect(choiceView([1, 1, 1], 0, 0).end).toBe(1);
  });
});
