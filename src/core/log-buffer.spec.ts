import { describe, expect, it } from 'vitest';
import {
  capLogEntries,
  clipLogText,
  clipStreamText,
  MAX_LOG_ENTRIES,
  MAX_LOG_ENTRY_CHARS,
  MAX_STREAM_PREVIEW_CHARS,
  pushLogEntry,
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

  it('超えたら末尾だけ残す（プレビューは最後の行しか出さない）', () => {
    const text = `${'a'.repeat(MAX_STREAM_PREVIEW_CHARS)}TAIL`;
    const clipped = clipStreamText(text);
    expect(clipped.length).toBe(MAX_STREAM_PREVIEW_CHARS);
    expect(clipped.endsWith('TAIL')).toBe(true);
  });

  it('先頭に孤立した下位サロゲートを残さない', () => {
    // 切り出し位置がちょうど絵文字の途中に来る長さにする
    const text = `x🎉${'a'.repeat(MAX_STREAM_PREVIEW_CHARS - 1)}`;
    const clipped = clipStreamText(text);
    expect(clipped.startsWith('a')).toBe(true);
    expect(clipped.length).toBe(MAX_STREAM_PREVIEW_CHARS - 1);
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

  it('巨大なテキストは追記時に切る', () => {
    const after = pushLogEntry([], entry(1, 'z'.repeat(MAX_LOG_ENTRY_CHARS + 10)));
    expect(after[0]?.text.length).toBe(MAX_LOG_ENTRY_CHARS + 2);
  });

  it('切る必要が無いエントリは同じ参照のまま入れる（logLines のキャッシュが効く）', () => {
    const e = entry(1);
    expect(pushLogEntry([], e)[0]).toBe(e);
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
});
