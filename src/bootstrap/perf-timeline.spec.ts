import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PERF_TIMELINE_CLEANUP_MS,
  type PerfTimeline,
  startPerfTimelineCleanup,
} from './perf-timeline';

function fakeTimeline(): PerfTimeline & { marks: number; measures: number } {
  const calls = {
    marks: 0,
    measures: 0,
    clearMarks: () => {
      calls.marks += 1;
    },
    clearMeasures: () => {
      calls.measures += 1;
    },
  };
  return calls;
}

describe('startPerfTimelineCleanup', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('間隔ごとに measures と marks を捨てる', () => {
    const timeline = fakeTimeline();
    startPerfTimelineCleanup(timeline, 1_000);
    expect(timeline.measures).toBe(0); // 張った時点では掃除しない
    vi.advanceTimersByTime(3_000);
    expect(timeline.measures).toBe(3);
    expect(timeline.marks).toBe(3);
  });

  it('停止したら以後掃除しない', () => {
    const timeline = fakeTimeline();
    const stop = startPerfTimelineCleanup(timeline, 1_000);
    vi.advanceTimersByTime(1_000);
    stop();
    vi.advanceTimersByTime(10_000);
    expect(timeline.measures).toBe(1);
  });

  it('掃除が throw しても伝播させない（best-effort）', () => {
    const timeline: PerfTimeline = {
      clearMarks: () => {
        throw new Error('nope');
      },
      clearMeasures: () => {
        throw new Error('nope');
      },
    };
    startPerfTimelineCleanup(timeline, 1_000);
    expect(() => vi.advanceTimersByTime(2_000)).not.toThrow();
  });

  it('タイマーは unref する（これだけでプロセスを生かし続けない）', () => {
    const timeline = fakeTimeline();
    const unref = vi.fn();
    const spy = vi
      .spyOn(globalThis, 'setInterval')
      .mockReturnValue({ unref } as unknown as ReturnType<typeof setInterval>);
    startPerfTimelineCleanup(timeline, 1_000);
    expect(unref).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('既定の間隔はヒープに残る量の上限を決める（30 秒）', () => {
    expect(PERF_TIMELINE_CLEANUP_MS).toBe(30_000);
  });
});
