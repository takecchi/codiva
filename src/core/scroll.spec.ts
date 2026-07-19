import { describe, expect, it } from 'vitest';
import { logWindow, pageStep, type ScrollAnchor, scrollDown, scrollUp } from './scroll';
import type { LogEntry } from './types';

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

  it('scrollUp keeps going and never reaches the tail', () => {
    let a: ScrollAnchor = scrollUp('bottom', 40, 20); // 30
    a = scrollUp(a, 40, 20); // 20
    a = scrollUp(a, 40, 20); // 10
    a = scrollUp(a, 40, 20); // max(1, 0) = 1
    expect(a).toBe(1);
  });

  it('scrollUp on a tiny log stays at bottom', () => {
    expect(scrollUp('bottom', 1, 20)).toBe('bottom');
    expect(scrollUp('bottom', 0, 20)).toBe('bottom');
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
});
