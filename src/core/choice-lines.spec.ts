import { describe, expect, it } from 'vitest';
import {
  CHOICE_DESCRIPTION_INDENT,
  type ChoiceRowItem,
  choiceIndexAtRow,
  choiceLines,
  choiceRowHeights,
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
