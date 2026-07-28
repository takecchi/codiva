import { describe, expect, it } from 'vitest';
import {
  logLines,
  logWindow,
  pageStep,
  type ScrollAnchor,
  scrollDown,
  scrollUp,
  streamTail,
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

describe('streamTail', () => {
  it('returns the last non-empty line', () => {
    expect(streamTail('foo\nbar\nbaz')).toBe('baz');
  });

  it('skips trailing empty lines', () => {
    expect(streamTail('foo\nbar\n\n')).toBe('bar');
  });

  it('returns an empty string for all-empty input', () => {
    expect(streamTail('')).toBe('');
    expect(streamTail('\n\n')).toBe('');
  });

  it('returns a single line unchanged', () => {
    expect(streamTail('just one')).toBe('just one');
  });
});
