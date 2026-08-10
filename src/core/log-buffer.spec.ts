import { describe, expect, it } from 'vitest';
import {
  capLogEntries,
  clipLogText,
  clipStreamText,
  MAX_LOG_CHARS,
  MAX_LOG_ENTRIES,
  MAX_LOG_ENTRY_CHARS,
  MAX_STREAM_PREVIEW_CHARS,
  pushLogEntry,
  STREAM_PREVIEW_KEEP_CHARS,
} from './log-buffer';
import type { LogEntry } from './types';

const entry = (seq: number, text = `line ${seq}`): LogEntry => ({
  seq,
  kind: 'assistant_text',
  text,
});

const many = (n: number): LogEntry[] => Array.from({ length: n }, (_, i) => entry(i + 1));

describe('clipLogText', () => {
  it.each([
    ['短いテキストはそのまま', 'hello'],
    ['ちょうど上限までは触らない', 'x'.repeat(MAX_LOG_ENTRY_CHARS)],
  ])('%s', (_name, text) => {
    expect(clipLogText(text)).toBe(text);
  });

  it('上限を超えたら切って印を付ける', () => {
    const clipped = clipLogText('y'.repeat(MAX_LOG_ENTRY_CHARS + 500));
    expect(clipped.length).toBe(MAX_LOG_ENTRY_CHARS + 2);
    expect(clipped.endsWith('…')).toBe(true);
  });

  // 絵文字の途中で切ると孤立サロゲートになり端末に `�` が出る。
  it('サロゲートペアを分断しない', () => {
    const clipped = clipLogText(`${'y'.repeat(MAX_LOG_ENTRY_CHARS - 1)}🎉rest`);
    expect(clipped).toBe(`${'y'.repeat(MAX_LOG_ENTRY_CHARS - 1)} …`);
  });
});

describe('clipStreamText', () => {
  it('上限まではそのまま', () => {
    const text = 'a'.repeat(MAX_STREAM_PREVIEW_CHARS);
    expect(clipStreamText(text)).toBe(text);
  });

  it('超えたら末尾だけ残す', () => {
    const text = `${'a'.repeat(MAX_STREAM_PREVIEW_CHARS)}TAIL`;
    const clipped = clipStreamText(text);
    expect(clipped.length).toBe(STREAM_PREVIEW_KEEP_CHARS);
    expect(clipped.endsWith('TAIL')).toBe(true);
  });

  // 行の途中で落とすと、残ったテキストの折り返し位置が全部ズレて描画済みの行が
  // 別の文字列になる（画面が横に跳ね、Ink の上限なしキャッシュにキーが積まれる）。
  it('できるだけ行頭で落とす（残る行の折り返しが変わらない）', () => {
    // 切り出し位置のすぐ先に改行がある形。CR / VT / FF も折り返し側と同じ扱いにする。
    for (const br of ['\n', '\r\n', '\r', '\v', '\f']) {
      const tail = 'B'.repeat(STREAM_PREVIEW_KEEP_CHARS - 1_000);
      const clipped = clipStreamText(
        `${'A'.repeat(MAX_STREAM_PREVIEW_CHARS - 10_000)}${br}${tail}`,
      );
      expect(clipped).toBe(tail);
    }
  });

  // 行境界を優先するあまり、見えている内容まで捨ててはいけない。
  it('次の行頭が遠すぎるときは文字単位で落とす', () => {
    const clipped = clipStreamText(`${'A'.repeat(MAX_STREAM_PREVIEW_CHARS)}\n${'C'.repeat(1_000)}`);
    expect(clipped.length).toBe(STREAM_PREVIEW_KEEP_CHARS);
    expect(clipped.startsWith('A')).toBe(true);
  });

  // 上限と落とし先が同じ値だと、上限に達して以降 1 文字届くたびに切り直すことになり
  // 毎デルタで折り返しがズレる。切ったあとは次の上限まで余裕があること。
  it('切ったあとは上限まで余裕が残る（毎デルタで切り直さない）', () => {
    const clipped = clipStreamText('a'.repeat(MAX_STREAM_PREVIEW_CHARS + 1));
    expect(clipped.length).toBeLessThanOrEqual(MAX_STREAM_PREVIEW_CHARS / 2);
    expect(clipStreamText(clipped)).toBe(clipped);
  });

  it('先頭に孤立した下位サロゲートを残さない', () => {
    // 切り出し位置がちょうど絵文字の途中に来る長さにする
    const tail = 'a'.repeat(STREAM_PREVIEW_KEEP_CHARS - 1);
    const clipped = clipStreamText(`${'x'.repeat(STREAM_PREVIEW_KEEP_CHARS + 1)}🎉${tail}`);
    expect(clipped).toBe(tail);
  });
});

describe('pushLogEntry', () => {
  it('上限未満はそのまま追記する（元の配列は変えない）', () => {
    const before = many(3);
    const after = pushLogEntry(before, entry(4));
    expect(after.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    expect(before).toHaveLength(3);
  });

  it('上限に達したら古い方を落として長さを保つ', () => {
    const full = many(MAX_LOG_ENTRIES);
    const after = pushLogEntry(full, entry(MAX_LOG_ENTRIES + 1));
    expect(after).toHaveLength(MAX_LOG_ENTRIES);
    expect(after[0]?.seq).toBe(2); // 先頭 1 件が落ちる
    expect(after.at(-1)?.seq).toBe(MAX_LOG_ENTRIES + 1);
  });

  it('上限を超えた配列を渡されても長さまで畳む', () => {
    const over = many(MAX_LOG_ENTRIES + 50);
    const after = pushLogEntry(over, entry(9999));
    expect(after).toHaveLength(MAX_LOG_ENTRIES);
    expect(after.at(-1)?.seq).toBe(9999);
  });

  it('切り詰めても kind と timestamp は保つ', () => {
    const after = pushLogEntry([], {
      seq: 1,
      kind: 'user',
      text: 'p'.repeat(MAX_LOG_ENTRY_CHARS + 1),
      timestamp: 42,
    });
    expect(after[0]).toMatchObject({ seq: 1, kind: 'user', timestamp: 42 });
  });

  it('巨大なテキストは追記時に切る', () => {
    const after = pushLogEntry([], entry(1, 'z'.repeat(MAX_LOG_ENTRY_CHARS + 10)));
    expect(after[0]?.text.length).toBe(MAX_LOG_ENTRY_CHARS + 2);
  });

  it('切る必要が無いエントリは同じ参照のまま入れる（logLines のキャッシュが効く）', () => {
    const e = entry(1);
    expect(pushLogEntry([], e)[0]).toBe(e);
  });
});

describe('pushLogEntry (文字数の上限)', () => {
  // 件数だけでは何も保証できない（1 件が 1 文字でも 20,000 文字でもよいので、
  // 件数 × 1 件上限 = 4000 万文字になる）。描画コストは文字数に比例するので、
  // 文字数側の予算が実際にヒープを縛っている。
  const big = (seq: number): LogEntry => entry(seq, 'w'.repeat(MAX_LOG_ENTRY_CHARS));
  const fill = (): LogEntry[] => {
    let messages: LogEntry[] = [];
    for (let i = 1; i <= Math.ceil(MAX_LOG_CHARS / MAX_LOG_ENTRY_CHARS) + 5; i += 1) {
      messages = pushLogEntry(messages, big(i));
    }
    return messages;
  };

  it('合計文字数が上限を超えないよう古い方を落とす', () => {
    const messages = fill();
    const chars = messages.reduce((n, m) => n + m.text.length, 0);
    expect(chars).toBeLessThanOrEqual(MAX_LOG_CHARS);
    expect(messages.length).toBeLessThan(MAX_LOG_ENTRIES); // 件数より先に文字数が縛る
  });

  it('最新のエントリは必ず残る', () => {
    const messages = fill();
    expect(messages.at(-1)?.text.length).toBe(MAX_LOG_ENTRY_CHARS);
    const last = pushLogEntry(messages, entry(9999, 'tail'));
    expect(last.at(-1)?.text).toBe('tail');
  });
});

describe('capLogEntries', () => {
  it('上限以下はそのまま', () => {
    const entries = many(5);
    expect(capLogEntries(entries).map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
  });

  it('新しい方を残す（seq は振り直さない）', () => {
    const capped = capLogEntries(many(MAX_LOG_ENTRIES + 10));
    expect(capped).toHaveLength(MAX_LOG_ENTRIES);
    expect(capped.at(-1)?.seq).toBe(MAX_LOG_ENTRIES + 10);
    expect(capped[0]?.seq).toBe(11);
  });

  it('巨大なテキストは切る', () => {
    const capped = capLogEntries([entry(1, 'q'.repeat(MAX_LOG_ENTRY_CHARS + 1))]);
    expect(capped[0]?.text.endsWith('…')).toBe(true);
  });

  it('ちょうど上限のときは 1 件も落とさない', () => {
    const capped = capLogEntries(many(MAX_LOG_ENTRIES));
    expect(capped).toHaveLength(MAX_LOG_ENTRIES);
    expect(capped[0]?.seq).toBe(1);
  });

  it('文字数の上限でも畳む', () => {
    const heavy = Array.from({ length: 40 }, (_, i) =>
      entry(i + 1, 'h'.repeat(MAX_LOG_ENTRY_CHARS)),
    );
    const capped = capLogEntries(heavy);
    expect(capped.reduce((n, m) => n + m.text.length, 0)).toBeLessThanOrEqual(MAX_LOG_CHARS);
    expect(capped.at(-1)?.seq).toBe(40); // 新しい方を残す
  });

  it('kind と timestamp は保つ', () => {
    const capped = capLogEntries([{ seq: 7, kind: 'tool_result', text: 'ok', timestamp: 1234 }]);
    expect(capped[0]).toEqual({ seq: 7, kind: 'tool_result', text: 'ok', timestamp: 1234 });
  });
});
