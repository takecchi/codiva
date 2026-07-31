import { describe, expect, it } from 'vitest';
import {
  emptyInputHistory,
  INPUT_HISTORY_LIMIT,
  type InputHistory,
  isBrowsingHistory,
  recallNext,
  recallPrev,
  recordInput,
  resetHistoryBrowse,
} from './input-history';

/** 送信を順に積んだ履歴（呼び出し位置は未使用の状態）。 */
function historyOf(...texts: string[]): InputHistory {
  return texts.reduce(recordInput, emptyInputHistory());
}

describe('recordInput', () => {
  const cases: { name: string; texts: string[]; entries: string[] }[] = [
    { name: '送信順に積む（末尾が最新）', texts: ['a', 'b', 'c'], entries: ['a', 'b', 'c'] },
    { name: '空文字は積まない', texts: ['a', '', '   '], entries: ['a'] },
    { name: '前後の空白は落とす', texts: ['  a  '], entries: ['a'] },
    { name: '直前と同じテキストは積まない', texts: ['a', 'a', 'b', 'a'], entries: ['a', 'b', 'a'] },
  ];
  for (const c of cases) {
    it(c.name, () => {
      expect(historyOf(...c.texts).entries).toEqual(c.entries);
    });
  }

  it('上限を超えたら古い方から捨てる', () => {
    const many = Array.from({ length: INPUT_HISTORY_LIMIT + 5 }, (_, i) => `t${i}`);
    const history = historyOf(...many);
    expect(history.entries).toHaveLength(INPUT_HISTORY_LIMIT);
    expect(history.entries[0]).toBe('t5');
    expect(history.entries.at(-1)).toBe(`t${INPUT_HISTORY_LIMIT + 4}`);
  });

  it('送信すると呼び出し位置がリセットされる（次の ↑ は最新から）', () => {
    const browsing = recallPrev(historyOf('a', 'b'), '')?.history;
    expect(browsing && isBrowsingHistory(browsing)).toBe(true);
    const after = recordInput(browsing ?? emptyInputHistory(), 'c');
    expect(isBrowsingHistory(after)).toBe(false);
    expect(recallPrev(after, '')?.value).toBe('c');
  });
});

describe('recallPrev / recallNext', () => {
  it('↑ は新しい方から古い方へ辿り、最古で止まる', () => {
    const h0 = historyOf('one', 'two', 'three');
    const s1 = recallPrev(h0, '');
    expect(s1?.value).toBe('three');
    const s2 = recallPrev(s1?.history ?? h0, '');
    expect(s2?.value).toBe('two');
    const s3 = recallPrev(s2?.history ?? h0, '');
    expect(s3?.value).toBe('one');
    // 最古まで来たら呼び出せない（呼び出し側はキャレット移動へ委ねる）。
    expect(recallPrev(s3?.history ?? h0, '')).toBeUndefined();
  });

  it('履歴が空なら ↑ は何も呼び出さない', () => {
    expect(recallPrev(emptyInputHistory(), 'draft')).toBeUndefined();
  });

  it('↓ は最新まで戻ったら辿り始めたときの書きかけへ復帰する', () => {
    const h0 = historyOf('one', 'two');
    const up1 = recallPrev(h0, 'draft'); // 書きかけを保存して 'two' を表示
    expect(up1?.value).toBe('two');
    const up2 = recallPrev(up1?.history ?? h0, 'ignored'); // 辿り中は draft を上書きしない
    expect(up2?.value).toBe('one');
    const down1 = recallNext(up2?.history ?? h0);
    expect(down1?.value).toBe('two');
    const down2 = recallNext(down1?.history ?? h0);
    expect(down2?.value).toBe('draft');
    expect(down2 && isBrowsingHistory(down2.history)).toBe(false);
    // 書きかけへ戻った後の ↓ は何もしない。
    expect(recallNext(down2?.history ?? h0)).toBeUndefined();
  });

  it('辿っていないときの ↓ は何もしない', () => {
    expect(recallNext(historyOf('one'))).toBeUndefined();
  });
});

describe('resetHistoryBrowse', () => {
  it('辿っていない履歴は同じ参照を返す', () => {
    const history = historyOf('a');
    expect(resetHistoryBrowse(history)).toBe(history);
  });

  it('辿り中は書きかけモードへ戻す（draft も捨てる）', () => {
    const browsing = recallPrev(historyOf('a'), 'draft')?.history ?? emptyInputHistory();
    const reset = resetHistoryBrowse(browsing);
    expect(isBrowsingHistory(reset)).toBe(false);
    expect(reset.draft).toBe('');
    expect(reset.entries).toEqual(['a']);
  });
});
