import stringWidth from 'string-width';
import { describe, expect, it } from 'vitest';
import { choiceIndexAtRow, choiceRowHeights } from './choice-lines';
import { messages } from './i18n';
import {
  subagentChoices,
  subagentElapsedMs,
  subagentRow,
  subagentRowHit,
  subagentRowLabel,
} from './subagent-row';
import type { SubagentRun, SubagentStatus } from './types';

const m = messages.ja;

function run(id: string, over: Partial<SubagentRun> = {}): SubagentRun {
  return {
    id,
    toolUseId: `tool-${id}`,
    kind: 'general-purpose',
    status: 'running',
    startedAt: 0,
    messages: [],
    ...over,
  };
}

describe('subagentRow', () => {
  it.each([
    ['1 件も無い', [], 'idle'],
    ['undefined', undefined, 'idle'],
    ['1 件', [run('a')], 'one'],
    ['複数件', [run('a'), run('b'), run('c')], 'many'],
  ] as const)('%s → %s', (_name, runs, kind) => {
    expect(subagentRow(runs).kind).toBe(kind);
  });

  it('複数件では残りの件数を数える', () => {
    const row = subagentRow([run('a'), run('b'), run('c')]);
    expect(row.kind === 'many' && row.others).toBe(2);
  });

  it('走っているものを代表にする（決着済みより優先）', () => {
    const row = subagentRow([run('a'), run('b', { status: 'completed' })]);
    expect(row.kind !== 'idle' && row.run.id).toBe('a');
  });

  it('走っているものが複数あれば最後に起動されたもの', () => {
    const row = subagentRow([run('a'), run('b'), run('c')]);
    expect(row.kind !== 'idle' && row.run.id).toBe('c');
  });

  it('全部決着済みなら最後のもの', () => {
    const row = subagentRow([run('a', { status: 'completed' }), run('b', { status: 'failed' })]);
    expect(row.kind !== 'idle' && row.run.id).toBe('b');
  });

  // 文言が理由なくちらつくと、クリックの行き先まで変わってしまう。
  it('決着済みが末尾に足されても代表は動かない', () => {
    const before = subagentRow([run('a'), run('b', { status: 'completed' })]);
    const after = subagentRow([
      run('a'),
      run('b', { status: 'completed' }),
      run('c', { status: 'completed' }),
    ]);
    expect(before.kind !== 'idle' && before.run.id).toBe('a');
    expect(after.kind !== 'idle' && after.run.id).toBe('a');
  });
});

describe('subagentElapsedMs', () => {
  it.each([
    // provider が所要時間を報告していればそれを使う（毎秒の再描画が要らない）。
    ['報告された所要時間', run('a', { usage: { durationMs: 8_067 } }), 100_000, 8_067],
    ['終了時刻から', run('a', { startedAt: 1_000, finishedAt: 4_000 }), 100_000, 3_000],
    ['走っている間は now との差', run('a', { startedAt: 1_000 }), 3_500, 2_500],
  ] as const)('%s', (_name, subject, now, expected) => {
    expect(subagentElapsedMs(subject, now)).toBe(expected);
  });

  it('now が無ければ走っているものの経過は出さない', () => {
    expect(subagentElapsedMs(run('a'))).toBeUndefined();
  });
});

describe('subagentRowLabel', () => {
  const PREFIX = '⏺ ';
  const WIDE = 200;

  it('1 件も無ければ undefined（呼び側は空行を描く）', () => {
    expect(subagentRowLabel({ kind: 'idle' }, m, PREFIX, WIDE)).toBeUndefined();
  });

  it('種別・状態・説明・直近のツール・経過を 1 行に並べる', () => {
    const label = subagentRowLabel(
      subagentRow([run('a', { description: 'Writing report.txt', lastTool: 'Write' })]),
      m,
      PREFIX,
      WIDE,
      12_000,
    );
    expect(label?.text).toContain('general-purpose');
    expect(label?.text).toContain(m.subagent.statusRunning);
    expect(label?.text).toContain('Writing report.txt');
    expect(label?.text).toContain('Write');
    expect(label?.text).toContain('12s');
  });

  it('複数件は「他 N 件」に畳む', () => {
    const label = subagentRowLabel(subagentRow([run('a'), run('b')]), m, PREFIX, WIDE);
    expect(label?.text).toContain('他 1 件');
  });

  it('説明が名前と同じなら重ねない', () => {
    const label = subagentRowLabel(
      subagentRow([run('a', { kind: undefined, description: 'Explore the repo' })]),
      m,
      PREFIX,
      WIDE,
    );
    const occurrences = label?.text.split('Explore the repo').length ?? 0;
    expect(occurrences - 1).toBe(1);
  });

  // 毎フレーム変わる文字列を切らずに `<Text>` へ渡すと Ink の上限なしキャッシュに
  // 積まれ続ける（過去に OOM した経路）。**渡す文字列自体**が短いことを確かめる。
  it('必ず表示幅に切る（返す width は実測値と一致）', () => {
    const label = subagentRowLabel(
      subagentRow([run('a', { description: 'x'.repeat(500), lastTool: 'Bash' })]),
      m,
      PREFIX,
      40,
      1_000,
    );
    expect(stringWidth(label?.text ?? '')).toBeLessThanOrEqual(40);
    expect(label?.width).toBe(stringWidth(label?.text ?? ''));
  });

  it('必ず 1 行に収める（改行を含まない）', () => {
    const label = subagentRowLabel(
      subagentRow([run('a', { description: 'y'.repeat(300) })]),
      m,
      PREFIX,
      30,
      1_000,
    );
    expect(label?.text).not.toContain('\n');
  });

  it('CJK を 2 セルで数える', () => {
    const label = subagentRowLabel(
      subagentRow([run('a', { kind: undefined, description: 'あ'.repeat(100) })]),
      m,
      PREFIX,
      21,
      1_000,
    );
    expect(stringWidth(label?.text ?? '')).toBeLessThanOrEqual(21);
  });

  it.each<[SubagentStatus, string]>([
    ['running', m.subagent.statusRunning],
    ['completed', m.subagent.statusDone],
    ['failed', m.subagent.statusFailed],
    ['stopped', m.subagent.statusStopped],
  ])('状態 %s のラベルを出す', (status, expected) => {
    const label = subagentRowLabel(subagentRow([run('a', { status })]), m, PREFIX, WIDE);
    expect(label?.text).toContain(expected);
  });
});

describe('subagentRowHit', () => {
  const box = { top: 10, left: 2 };

  it.each([
    ['ラベルの内側', { x: 5, y: 10 }, 1, 20, true],
    ['行の左端', { x: 2, y: 10 }, 1, 20, true],
    ['ラベルの右端の 1 つ内側', { x: 21, y: 10 }, 1, 20, true],
    // 行末より右は「何も無い余白」なので当たりにしない（押しても遷移させない）。
    ['ラベルの右端', { x: 22, y: 10 }, 1, 20, false],
    ['ラベルより右の余白', { x: 60, y: 10 }, 1, 20, false],
    ['左端より左', { x: 1, y: 10 }, 1, 20, false],
    ['1 行上', { x: 5, y: 9 }, 1, 20, false],
    ['1 行下', { x: 5, y: 11 }, 1, 20, false],
    // 実測できていない / 縦に潰れている間は当たり判定そのものをやめる。
    ['高さ 0（潰れている）', { x: 5, y: 10 }, 0, 20, false],
    ['ラベルが空', { x: 5, y: 10 }, 1, 0, false],
  ] as const)('%s → %s', (_name, point, height, labelWidth, expected) => {
    expect(subagentRowHit(point, box, height, labelWidth)).toBe(expected);
  });
});

describe('subagentChoices', () => {
  it('件数ぶんの選択肢を返す', () => {
    const items = subagentChoices([run('a'), run('b')], m);
    expect(items).toHaveLength(2);
    expect(items[0]?.choice.label).toBe('general-purpose');
  });

  it('説明に状態・直近のツール・経過を入れる', () => {
    const items = subagentChoices(
      [run('a', { description: 'Writing report.txt', lastTool: 'Write' })],
      m,
      9_000,
    );
    const description = items[0]?.choice.description ?? '';
    expect(description).toContain('Writing report.txt');
    expect(description).toContain(m.subagent.statusRunning);
    expect(description).toContain('Write');
    expect(description).toContain('9s');
  });

  // 1 件 = 1 行**ではない**（ラベルの折返し + 説明）ので、クリック位置の逆算は
  // 描画に使ったのと同じ配列・同じ幅を通す必要がある。
  it('クリック位置の逆算と行数計算が整合する', () => {
    const items = subagentChoices([run('a'), run('b'), run('c')], m, 1_000);
    const heights = choiceRowHeights(items, 40);
    expect(heights.every((h) => h >= 1)).toBe(true);
    let row = 0;
    for (const [index, height] of heights.entries()) {
      expect(choiceIndexAtRow(heights, row)).toBe(index);
      // 各件の最終行も同じ選択肢に当たる。
      expect(choiceIndexAtRow(heights, row + height - 1)).toBe(index);
      row += height;
    }
    // 全行の外は undefined（黙って最後の件に丸めない）。
    expect(choiceIndexAtRow(heights, row)).toBeUndefined();
  });
});
