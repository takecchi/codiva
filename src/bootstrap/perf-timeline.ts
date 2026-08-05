/**
 * performance タイムラインの定期掃除。
 *
 * Node の user timing（`performance.mark` / `performance.measure`）は**呼んだ側が
 * 捨てるまで保持され続ける**。React 19.2 の dev ビルドはレンダーごとに
 * `performance.measure()` を 3 本積む（Performance Tracks。`console.timeStamp` と
 * `performance.measure` があれば有効になり、Node には両方ある）ので、長時間動く TUI では
 * ヒープが単調に増えて最後に OOM する。実測: 空 Box の再描画だけで 2,230 B/フレーム、
 * 10 描画/秒 ≒ 86MB/時。既定のヒープ上限 ~4GB に到達して実際に 3 回落ちた。
 *
 * 本筋の対策は `src/index.tsx` が production ビルドを選ばせることで、そちらなら確保自体が
 * 起きない。これはその保険で、**NODE_ENV を明示的に development にして起動したとき**や、
 * 将来 React / Node が別の形で user timing を積み始めたときに効く。誰も読まないエントリを
 * 捨てるだけなので、掃除そのものは安全（codiva は user timing を読まない）。
 *
 * 定期タイマーは unref して、これだけでプロセスを生かし続けないようにする。
 */

/** 掃除の間隔。ヒープに残る量の上限がこの間隔ぶんになる（30 秒 ≒ 1MB 未満）。 */
export const PERF_TIMELINE_CLEANUP_MS = 30_000;

/** このモジュールが使う `performance` の部分だけ（テストからフェイクを渡せるように）。 */
export interface PerfTimeline {
  clearMarks: () => void;
  clearMeasures: () => void;
}

/**
 * `performance` の user timing エントリを定期的に捨てる。停止関数を返す。
 * 失敗しても TUI を落とさない（掃除は best-effort）。
 */
export function startPerfTimelineCleanup(
  timeline: PerfTimeline = performance,
  intervalMs: number = PERF_TIMELINE_CLEANUP_MS,
): () => void {
  const sweep = (): void => {
    try {
      timeline.clearMeasures();
      timeline.clearMarks();
    } catch {
      // 掃除できないランタイムなら諦める（保持が増えるだけで動作は壊れない）。
    }
  };
  const timer = setInterval(sweep, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
