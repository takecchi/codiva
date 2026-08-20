import { describe, expect, it } from 'vitest';
import { clipStreamText } from './log-buffer';
import {
  clearLogLinesCache,
  type DisplayLine,
  type LogStatusRow,
  logLines,
  logStatusRow,
  logWindow,
  MAX_CACHED_ROWS,
  pageStep,
  type ScrollAnchor,
  scrollDown,
  scrollUp,
  streamLines,
  wrapDisplayLines,
  wrapRichLine,
} from './scroll';
import type { LogEntry, LogKind } from './types';

function entries(n: number): LogEntry[] {
  return Array.from({ length: n }, (_, i) => ({ seq: i, kind: 'assistant_text', text: `l${i}` }));
}

describe('logWindow (bottom / tail follow)', () => {
  it('returns everything when it fits, atBottom', () => {
    const all = entries(3);
    const w = logWindow(all, 10, 'bottom');
    expect(w.entries).toEqual(all);
    expect(w).toMatchObject({ hiddenAbove: 0, hiddenBelow: 0, atBottom: true });
  });

  it('caps to the newest ~rows entries when overflowing', () => {
    const w = logWindow(entries(40), 20, 'bottom');
    expect(w.entries).toHaveLength(20);
    expect(w.entries[0]?.seq).toBe(20);
    expect(w.entries[19]?.seq).toBe(39);
    expect(w.atBottom).toBe(true);
    expect(w.hiddenBelow).toBe(0);
  });

  it('is empty (and atBottom) for an empty log', () => {
    expect(logWindow([], 10, 'bottom')).toMatchObject({ entries: [], atBottom: true });
  });
});

describe('logWindow (scrolled up, numeric anchor)', () => {
  it('renders a window ending at the anchor, reporting hidden counts', () => {
    // 40 entries, end=30 → window [10,30), 10 newer below
    const w = logWindow(entries(40), 20, 30);
    expect(w.entries[0]?.seq).toBe(10);
    expect(w.entries.at(-1)?.seq).toBe(29);
    expect(w.hiddenBelow).toBe(10);
    expect(w.hiddenAbove).toBe(10);
    expect(w.atBottom).toBe(false);
  });

  it('a scrolled window is stable as new entries append (end stays fixed)', () => {
    const before = logWindow(entries(40), 20, 25);
    const after = logWindow(entries(50), 20, 25); // 10 more appended
    expect(after.entries.at(-1)?.seq).toBe(before.entries.at(-1)?.seq); // same bottom line
    expect(after.hiddenBelow).toBe(25); // more below now
  });

  it('clamps an anchor past the end to the tail', () => {
    const w = logWindow(entries(5), 20, 99);
    expect(w.atBottom).toBe(true);
    expect(w.entries).toHaveLength(5);
  });

  // Regression: an anchor below one viewport used to render only `anchor` rows
  // pinned to the bottom of an otherwise blank screen, so the top of the log was
  // never shown as a readable page.
  it('floors the window at one full viewport so the top of the log fills the screen', () => {
    const w = logWindow(entries(40), 20, 3);
    expect(w.entries).toHaveLength(20);
    expect(w.entries[0]?.seq).toBe(0);
    expect(w.entries.at(-1)?.seq).toBe(19);
    expect(w.hiddenAbove).toBe(0);
    expect(w.hiddenBelow).toBe(20);
  });

  it('never renders more rows than the viewport (Yoga shrinks overflow instead of clipping)', () => {
    for (const anchor of [1, 5, 20, 33, 40] as const) {
      expect(logWindow(entries(40), 20, anchor).entries.length).toBeLessThanOrEqual(20);
    }
  });
});

describe('logStatusRow', () => {
  // ログ直下は**常に 1 行**。2 状態のどちらかが必ず返る（undefined を返さない）ことが
  // 「ログの高さがスクロール位置・ストリーミングで変わらない」の担保になっている。
  const cases: [string, boolean, number, LogStatusRow][] = [
    ['末尾追従中 → 空行', true, 0, { kind: 'idle' }],
    ['スクロール中 → 残り行数の案内', false, 7, { kind: 'scrollback', hiddenBelow: 7 }],
  ];
  it.each(cases)('%s', (_name, atBottom, hiddenBelow, expected) => {
    expect(logStatusRow({ atBottom, hiddenBelow })).toEqual(expected);
  });
});

describe('wrapDisplayLines', () => {
  it('keeps short single-line text as one line', () => {
    expect(wrapDisplayLines('hello', 10)).toEqual(['hello']);
  });

  it('splits on embedded newlines (LF / CRLF / VT / FF)', () => {
    expect(wrapDisplayLines('a\nb\r\nc\vd\fe', 10)).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('hard-wraps a long line at the display width', () => {
    expect(wrapDisplayLines('abcdefgh', 3)).toEqual(['abc', 'def', 'gh']);
  });

  it('counts CJK as 2 cells so Japanese wraps where the terminal does', () => {
    // 6 cells per row → 3 CJK chars per row
    expect(wrapDisplayLines('こんにちは世界', 6)).toEqual(['こんに', 'ちは世', '界']);
  });

  it('preserves empty logical lines (paragraph breaks stay visible)', () => {
    expect(wrapDisplayLines('a\n\nb', 10)).toEqual(['a', '', 'b']);
  });

  it('never wraps when width is non-positive (degenerate viewport)', () => {
    expect(wrapDisplayLines('abcdef', 0)).toEqual(['abcdef']);
  });
});

describe('logLines: クリックできる URL の範囲（links）', () => {
  const prefixFor = (kind: LogKind) => (kind === 'user' ? '> ' : '');

  it('プレーン行の裸 URL に範囲が付き、prefix のぶんずれる', () => {
    const [row] = logLines([{ seq: 1, kind: 'user', text: 'see https://x.dev/a' }], 60, prefixFor);
    // prefix '> ' が 2 文字。'see ' が 4 文字なので 6..
    expect(row?.text).toBe('> see https://x.dev/a');
    expect(row?.links).toEqual([{ from: 6, to: 21, url: 'https://x.dev/a' }]);
    expect(row?.text.slice(6, 21)).toBe('https://x.dev/a');
  });

  it('URL の無い行に links を付けない（大多数の行のコストをゼロに保つ）', () => {
    expect(logLines([{ seq: 2, kind: 'user', text: 'no links' }], 60, prefixFor)[0]?.links).toBe(
      undefined,
    );
  });

  it('折り返しで URL が割れても、どちらの行も URL 全体を指す', () => {
    // 幅 12・prefix なし → content 12。URL が 2 行に割れる。
    const rows = logLines(
      [{ seq: 3, kind: 'system', text: 'https://x.dev/abcdefgh' }],
      12,
      prefixFor,
    );
    expect(rows.length).toBeGreaterThan(1);
    for (const row of rows) {
      expect(row.links?.[0]?.url).toBe('https://x.dev/abcdefgh');
    }
    // 各行の範囲はその行のテキスト内に収まる
    for (const row of rows) {
      const link = row.links?.[0];
      expect(link?.from).toBeGreaterThanOrEqual(0);
      expect(link?.to).toBeLessThanOrEqual(row.text.length);
    }
  });

  it('複数行のうち URL がある行だけに範囲が付く', () => {
    const rows = logLines(
      [{ seq: 4, kind: 'system', text: 'plain\nhttps://x.dev/a\nplain again' }],
      60,
      prefixFor,
    );
    expect(rows.map((r) => r.links !== undefined)).toEqual([false, true, false]);
  });

  it('Markdown の [label](url) は label の範囲に href が付く', () => {
    const [row] = logLines(
      [{ seq: 5, kind: 'assistant_text', text: 'see [docs](https://x.dev/d)' }],
      60,
      prefixFor,
    );
    expect(row?.text).toBe('see docs');
    expect(row?.links).toEqual([{ from: 4, to: 8, url: 'https://x.dev/d' }]);
  });

  it('コードブロック内の裸 URL も拾う（href が付かない経路の受け皿）', () => {
    const rows = logLines(
      [{ seq: 6, kind: 'assistant_text', text: '```\nhttps://x.dev/c\n```' }],
      60,
      prefixFor,
    );
    const hit = rows.find((r) => r.text.includes('https://x.dev/c'));
    expect(hit?.links?.[0]?.url).toBe('https://x.dev/c');
  });

  it('隣り合う別リンクを 1 スパンに畳まない', () => {
    const [row] = logLines(
      [{ seq: 7, kind: 'assistant_text', text: '[a](https://a.test)[b](https://b.test)' }],
      60,
      prefixFor,
    );
    expect(row?.links).toEqual([
      { from: 0, to: 1, url: 'https://a.test' },
      { from: 1, to: 2, url: 'https://b.test' },
    ]);
  });
});

describe('logLines: エージェント切替の区切り行', () => {
  const prefixFor = () => '';
  const divider = (agent: string) => `-- ${agent} --`;

  it('LogEntry.agent が変わる境界に 1 行だけ挿む', () => {
    const rows = logLines(
      [
        { seq: 1, kind: 'system', text: 'a' },
        { seq: 2, kind: 'system', text: 'b', agent: 'codex' },
        { seq: 3, kind: 'system', text: 'c', agent: 'codex' },
        { seq: 4, kind: 'system', text: 'd', agent: 'claude' },
      ],
      40,
      prefixFor,
      divider,
    );
    expect(rows.map((r) => r.text)).toEqual(['a', '-- codex --', 'b', 'c', '-- claude --', 'd']);
    // 区切りのキーは行のキーと衝突しない（描画キーは key で決まる）。
    expect(new Set(rows.map((r) => r.key)).size).toBe(rows.length);
  });

  it('切替を使っていないセッション（agent が全行 undefined）には 1 本も出さない', () => {
    const rows = logLines(
      [
        { seq: 1, kind: 'system', text: 'a' },
        { seq: 2, kind: 'system', text: 'b' },
      ],
      40,
      prefixFor,
      divider,
    );
    expect(rows.map((r) => r.text)).toEqual(['a', 'b']);
  });

  it('dividerFor を渡さなければ従来どおり（行数を変えない）', () => {
    const messages: LogEntry[] = [{ seq: 1, kind: 'system', text: 'a', agent: 'codex' }];
    expect(logLines(messages, 40, prefixFor)).toHaveLength(1);
  });
});

describe('logLines (entries → physical rows)', () => {
  const prefixFor = (kind: LogKind) => (kind === 'user' ? '> ' : '');

  it('expands a multi-line entry into one DisplayLine per physical row', () => {
    // `system` is a non-Markdown kind → plain flat-text path (no spans).
    const lines = logLines([{ seq: 1, kind: 'system', text: 'one\ntwo' }], 20, prefixFor);
    expect(lines).toEqual([
      { key: '1:0', kind: 'system', text: 'one' },
      { key: '1:1', kind: 'system', text: 'two' },
    ]);
  });

  it('prefixes the first row and indents continuation rows by the prefix width', () => {
    const lines = logLines([{ seq: 3, kind: 'user', text: 'abcd' }], 4, prefixFor);
    // width 4 minus prefix "> " (2 cells) → 2 chars per row
    expect(lines).toEqual([
      { key: '3:0', kind: 'user', text: '> ab' },
      { key: '3:1', kind: 'user', text: '  cd' },
    ]);
  });

  it('keeps entry order and unique keys across entries', () => {
    const lines = logLines(
      [
        { seq: 1, kind: 'user', text: 'hi' },
        { seq: 2, kind: 'assistant_text', text: 'yo' },
      ],
      20,
      prefixFor,
    );
    expect(lines.map((l) => l.key)).toEqual(['1:0', '2:0']);
  });

  it('renders assistant_text as Markdown, attaching styled spans', () => {
    const lines = logLines(
      [{ seq: 5, kind: 'assistant_text', text: 'hello **world**' }],
      40,
      prefixFor,
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]?.text).toBe('hello world');
    expect(lines[0]?.spans).toEqual([{ text: 'hello ' }, { text: 'world', bold: true }]);
  });

  it('renders a Markdown heading as a bold heading-toned span', () => {
    const lines = logLines([{ seq: 6, kind: 'assistant_text', text: '# Title' }], 40, prefixFor);
    expect(lines[0]?.spans).toEqual([{ text: 'Title', bold: true, tone: 'heading' }]);
  });

  it('does NOT Markdown-render non-assistant kinds (flat text, no spans)', () => {
    const lines = logLines([{ seq: 7, kind: 'user', text: '**not bold**' }], 40, prefixFor);
    expect(lines[0]?.spans).toBeUndefined();
    expect(lines[0]?.text).toBe('> **not bold**');
  });

  it('wraps a rich Markdown line by display width, preserving span styling', () => {
    // width 5 → "aaa" then "aaa" (bold code carried across the wrap)
    const lines = logLines([{ seq: 8, kind: 'assistant_text', text: '`aaaaaa`' }], 5, prefixFor);
    expect(lines).toHaveLength(2);
    expect(lines[0]?.spans).toEqual([{ text: 'aaaaa', tone: 'code' }]);
    expect(lines[1]?.spans).toEqual([{ text: 'a', tone: 'code' }]);
  });

  // 追記のたびにログ全体を再展開（= Markdown 再パース）していたのが OOM の主因なので、
  // 「同じエントリは 2 度展開しない」ことをオブジェクト同一性で担保する。
  describe('per-entry memoization', () => {
    it('reuses the same row objects for an unchanged entry', () => {
      const entry: LogEntry = { seq: 1, kind: 'assistant_text', text: 'hello **world**' };
      const first = logLines([entry], 40, prefixFor);
      const second = logLines([entry], 40, prefixFor);
      expect(second[0]).toBe(first[0]);
    });

    it('only expands the newly appended entry (older rows stay identical)', () => {
      const old: LogEntry = { seq: 1, kind: 'assistant_text', text: 'first' };
      const before = logLines([old], 40, prefixFor);
      const after = logLines(
        [old, { seq: 2, kind: 'assistant_text', text: 'second' }],
        40,
        prefixFor,
      );
      expect(after[0]).toBe(before[0]);
      expect(after).toHaveLength(2);
    });

    it('re-wraps when the width changes', () => {
      const entry: LogEntry = { seq: 1, kind: 'system', text: 'abcd' };
      expect(logLines([entry], 40, prefixFor)).toEqual([
        { key: '1:0', kind: 'system', text: 'abcd' },
      ]);
      expect(logLines([entry], 2, prefixFor).map((l) => l.text)).toEqual(['ab', 'cd']);
      // 元の幅に戻せば元の行に戻る（キャッシュが幅を跨いで漏れない）
      expect(logLines([entry], 40, prefixFor).map((l) => l.text)).toEqual(['abcd']);
    });

    it('re-expands when the prefix for the kind changes', () => {
      const entry: LogEntry = { seq: 1, kind: 'user', text: 'hi' };
      expect(logLines([entry], 40, prefixFor)[0]?.text).toBe('> hi');
      expect(logLines([entry], 40, () => '# ')[0]?.text).toBe('# hi');
    });

    it('a rewritten entry (new object, same seq) is expanded again', () => {
      expect(
        logLines([{ seq: 1, kind: 'system', text: 'api retry 1/10' }], 40, prefixFor)[0]?.text,
      ).toBe('api retry 1/10');
      expect(
        logLines([{ seq: 1, kind: 'system', text: 'api retry 2/10' }], 40, prefixFor)[0]?.text,
      ).toBe('api retry 2/10');
    });

    // Markdown 経路（spans 付き）は行の作り方が別なので、幅の再計算も別に確かめる。
    it('re-wraps the Markdown path on a width change (spans and indent stay correct)', () => {
      const entry: LogEntry = { seq: 1, kind: 'assistant_text', text: '`aaaaaa`' };
      const wide = logLines([entry], 40, prefixFor);
      expect(wide).toHaveLength(1);
      const narrow = logLines([entry], 5, prefixFor);
      expect(narrow.map((l) => l.spans)).toEqual([
        [{ text: 'aaaaa', tone: 'code' }],
        [{ text: 'a', tone: 'code' }],
      ]);
      // メモ化前と同じ結果に戻る（キャッシュが幅を跨いで漏れない）
      clearLogLinesCache();
      expect(logLines([entry], 5, prefixFor)).toEqual(narrow);
      expect(logLines([entry], 40, prefixFor)).toEqual(wide);
    });

    it('memoized output equals the unmemoized output (rich + plain, prefixed)', () => {
      const messages: LogEntry[] = [
        { seq: 1, kind: 'user', text: 'これは日本語の長い指示で折り返します' },
        { seq: 2, kind: 'assistant_text', text: '# Title\n\n- **a** and `b`\n\nlong tail text' },
        { seq: 3, kind: 'tool_result', text: 'ok' },
      ];
      const memoized = logLines(messages, 12, prefixFor);
      clearLogLinesCache();
      // 別オブジェクトの同内容エントリ = キャッシュに当たらない経路
      const fresh = logLines(
        messages.map((m) => ({ ...m })),
        12,
        prefixFor,
      );
      expect(memoized).toEqual(fresh);
    });

    // メモ化した行は「エントリが生きている限り」保持されるので、上限が無いと
    // 一過性のゴミが**永続的な保持**に化ける（開いた全セッション × 全エントリ）。
    it('bounds what it keeps: the least-recently-used rows are dropped', () => {
      clearLogLinesCache();
      const rowsPerEntry = 40;
      const wide = 'z'.repeat(rowsPerEntry * 10); // width 10 → 40 行
      // 予算を確実に超える件数（1 件ずつ描くので、前の描画は「使用中」ではない）
      const count = Math.ceil(MAX_CACHED_ROWS / rowsPerEntry) + 10;
      const entries: LogEntry[] = Array.from({ length: count }, (_, i) => ({
        seq: i + 1,
        kind: 'system',
        text: wide,
      }));
      const oldest = entries[0] as LogEntry;
      const first = logLines([oldest], 10, prefixFor);
      expect(first).toHaveLength(rowsPerEntry);
      for (const entry of entries.slice(1)) {
        logLines([entry], 10, prefixFor);
      }
      // 最も古いものは追い出されているので、同じ内容でも新しい行オブジェクトになる
      expect(logLines([oldest], 10, prefixFor)[0]).not.toBe(first[0]);
      // 直前に描いたものはキャッシュに残っている（追い出しは古い順）
      const newest = entries.at(-1) as LogEntry;
      expect(logLines([newest], 10, prefixFor)[0]).toBe(logLines([newest], 10, prefixFor)[0]);
    });

    it('never evicts rows the current call is still using (a log larger than the budget)', () => {
      clearLogLinesCache();
      const rowsPerEntry = 40;
      const text = 'y'.repeat(rowsPerEntry * 10);
      const entries: LogEntry[] = Array.from({ length: 300 }, (_, i) => ({
        seq: i + 1,
        kind: 'system',
        text,
      }));
      const before = logLines(entries, 10, prefixFor);
      expect(before).toHaveLength(300 * rowsPerEntry); // 予算（8000 行）より多い
      const after = logLines(entries, 10, prefixFor);
      // 2 回目も全行キャッシュヒット = 予算超過でも自分の行を捨てて毎フレーム再展開しない
      expect(after[0]).toBe(before[0]);
      expect(after.at(-1)).toBe(before.at(-1));
    });
  });
});

describe('wrapRichLine', () => {
  it('returns one empty row for an empty line', () => {
    expect(wrapRichLine([], 10)).toEqual([[]]);
  });

  it('keeps a short styled line on one row', () => {
    const spans = [{ text: 'ab', bold: true }, { text: 'cd' }];
    expect(wrapRichLine(spans, 10)).toEqual([spans]);
  });

  it('coalesces adjacent graphemes of identical style back into one span', () => {
    expect(wrapRichLine([{ text: 'hello', tone: 'code' }], 10)).toEqual([
      [{ text: 'hello', tone: 'code' }],
    ]);
  });

  it('wraps across spans at the display-width boundary', () => {
    const rows = wrapRichLine([{ text: 'abc', bold: true }, { text: 'def' }], 4);
    expect(rows).toEqual([[{ text: 'abc', bold: true }, { text: 'd' }], [{ text: 'ef' }]]);
  });

  it('measures CJK width (2 cells) when wrapping', () => {
    // width 4 → two double-width graphemes per row
    const rows = wrapRichLine([{ text: 'あいう' }], 4);
    expect(rows.map((r) => r.map((s) => s.text).join(''))).toEqual(['あい', 'う']);
  });
});

describe('scrollUp / scrollDown', () => {
  it('pageStep is a half-viewport, at least 1', () => {
    expect(pageStep(20)).toBe(10);
    expect(pageStep(1)).toBe(1);
    expect(pageStep(0)).toBe(1);
  });

  it('scrollUp from bottom moves off the tail by a page', () => {
    const a = scrollUp('bottom', 40, 20); // 40 - 10
    expect(a).toBe(30);
  });

  it('scrollUp stops at the top with a full viewport still on screen', () => {
    let a: ScrollAnchor = scrollUp('bottom', 40, 20); // 30
    a = scrollUp(a, 40, 20); // 20 (= one viewport: the top)
    expect(a).toBe(20);
    // Already at the top — further scrolling is a no-op, not a collapse to 1 row.
    expect(scrollUp(a, 40, 20)).toBe(20);
  });

  it('scrollUp on a log that already fits stays at bottom', () => {
    expect(scrollUp('bottom', 1, 20)).toBe('bottom');
    expect(scrollUp('bottom', 0, 20)).toBe('bottom');
    expect(scrollUp('bottom', 20, 20)).toBe('bottom');
  });

  it('scrollDown snaps back to bottom when it reaches the end', () => {
    expect(scrollDown(30, 40, 20)).toBe('bottom'); // 30 + 10 = 40 >= total
    expect(scrollDown(25, 40, 20)).toBe(35); // still scrolled
  });

  it('scrollDown from bottom stays at bottom', () => {
    expect(scrollDown('bottom', 40, 20)).toBe('bottom');
  });

  it('scrollUp then scrollDown returns toward the tail', () => {
    const up = scrollUp('bottom', 100, 20); // 90
    const down = scrollDown(up, 100, 20); // 100 >= total → bottom
    expect(down).toBe('bottom');
  });

  it('an explicit step overrides the half-page default (wheel notch / arrow key)', () => {
    expect(scrollUp('bottom', 100, 20, 3)).toBe(97);
    expect(scrollUp('bottom', 100, 20, 1)).toBe(99);
    expect(scrollDown(97, 100, 20, 3)).toBe('bottom');
    expect(scrollDown(90, 100, 20, 1)).toBe(91);
  });

  it('a one-line step still lands on the top boundary, never below it', () => {
    let a: ScrollAnchor = 21;
    a = scrollUp(a, 40, 20, 1); // 20 → the top
    expect(a).toBe(20);
    expect(scrollUp(a, 40, 20, 1)).toBe(20);
    expect(scrollDown(a, 40, 20, 1)).toBe(21); // and back down one line
  });
});

describe('streamLines (ストリーミング中の本文をログの行として展開する)', () => {
  const text = (rows: readonly DisplayLine[]) => rows.map((r) => r.text);

  it('改行で行を分け、幅で折り返す', () => {
    expect(text(streamLines('hello\nworld wide', 5, '', 10))).toEqual(['hello', 'world', ' wide']);
  });

  it('全角は 2 セルで数える（確定エントリと同じ折り返し）', () => {
    expect(text(streamLines('あいうえ', 4, '', 10))).toEqual(['あい', 'うえ']);
    expect(text(streamLines('あいうえ', 4, '', 10))).toEqual(wrapDisplayLines('あいうえ', 4));
  });

  it('prefix は先頭行だけ、継続行は同じ表示幅で字下げする', () => {
    expect(text(streamLines('abcdef', 5, '> ', 10))).toEqual(['> abc', '  def']);
  });

  // 改行が届いた瞬間だけ下に空行が生えて画面が 1 行跳ねるのを防ぐ（確定時の trim と揃う）。
  it('末尾の空行は落とす / 中身が無ければ 1 行も返さない', () => {
    expect(text(streamLines('done\n\n', 20, '', 10))).toEqual(['done']);
    expect(streamLines('', 20, '', 10)).toEqual([]);
    expect(streamLines('\n \n', 20, '', 10)).toEqual([]);
  });

  it('cap を超えたぶんは先頭から落とす（可視域に入らないので下端を残す）', () => {
    const rows = streamLines('a\nb\nc\nd\ne', 20, '', 3);
    expect(text(rows)).toEqual(['c', 'd', 'e']);
  });

  /**
   * この 2 本が OOM 回帰の番人。Ink は測った文字列をプロセスグローバルな上限なし
   * キャッシュへ積むので、**確定した行の文字列が毎デルタ変わらない**ことが要件になる。
   * 変わってよいのは書きかけの最終行だけ。
   */
  it('伸びても既に確定した行の文字列は変わらない（Ink のキャッシュに当たり続ける）', () => {
    const before = text(streamLines('hello world and', 6, '', 50));
    const after = text(streamLines('hello world and then some', 6, '', 50));
    expect(after.slice(0, before.length - 1)).toEqual(before.slice(0, before.length - 1));
  });

  it.each([
    ['prefix なし', ''],
    // prefix / 字下げの当て方（先頭行だけ prefix）を間違えると、行が 1 つ増えるたびに
    // 全行の lead が付け替わって別文字列になる。
    ['prefix あり', '> '],
  ])('デルタで増えるのは最終行 1 本だけ（新しい文字列の本数・%s）', (_name, prefix) => {
    const chunks = 'the quick brown fox jumps over the lazy dog'.split(' ');
    const seen = new Set<string>();
    let acc = '';
    for (const chunk of chunks) {
      acc += `${chunk} `;
      for (const row of streamLines(acc, 10, prefix, 50)) {
        seen.add(row.text);
      }
    }
    const rows = streamLines(acc, 10, prefix, 50);
    // 全デルタを通して現れた文字列 = 確定した行 + 各デルタの書きかけ 1 本ぶん。
    // 「毎デルタ全行が別文字列」なら行数 × デルタ数まで膨らむ。
    expect(seen.size).toBeLessThanOrEqual(rows.length + chunks.length);
  });

  /**
   * 頭を落とす経路（`clipStreamText`）と合わせた通しの番人。行頭で落とせたときは
   * **残った行の文字列が 1 つも変わらない**こと（= Ink のキャッシュに当たり続け、
   * 画面もズレない）が、上限を超えて伸び続ける長文での前提になっている。
   */
  it('clipStreamText で頭が落ちても、残った行の文字列は変わらない', () => {
    // 切り出し位置のすぐ先に改行が来る形（= 行頭で落とせる経路）。
    const long = `${'A'.repeat(20_000)}\n${'B'.repeat(15_000)}\nC tail`;
    const before = streamLines(long, 80, '', 50).map((r) => r.text);
    const after = streamLines(clipStreamText(long), 80, '', 50).map((r) => r.text);
    expect(after.length).toBeGreaterThan(0);
    expect(before.slice(before.length - after.length)).toEqual(after);
  });

  it('末尾の必要な行数ぶんだけ折り返す（長文でも 1 デルタのコストが頭打ちになる）', () => {
    const long = `${'A'.repeat(200_000)}\n${'B'.repeat(40)}\n${'C'.repeat(40)}`;
    const rows = streamLines(long, 40, '', 2);
    // 先頭の巨大な論理行には触らずに済んでいる（触れば 5,000 行に展開される）。
    expect(rows.map((r) => r.text)).toEqual(['B'.repeat(40), 'C'.repeat(40)]);
  });

  it('Markdown 整形もリンク検出もしない（途中テキストは素で描く）', () => {
    const rows = streamLines('**bold** https://example.com', 80, '', 10);
    expect(rows[0]?.text).toBe('**bold** https://example.com');
    expect(rows[0]?.spans).toBeUndefined();
    expect(rows[0]?.links).toBeUndefined();
    expect(rows[0]?.kind).toBe('assistant_text');
  });

  it('key は論理行 index + 行内 index（伸びても既存行の key が変わらない）', () => {
    const before = streamLines('one\ntwo', 20, '', 10).map((r) => r.key);
    const after = streamLines('one\ntwo\nthree', 20, '', 10).map((r) => r.key);
    expect(before).toEqual(['stream:0:0', 'stream:1:0']);
    expect(after.slice(0, before.length)).toEqual(before);
  });
});
