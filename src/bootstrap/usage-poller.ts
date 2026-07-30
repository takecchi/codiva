import type { UsageProbeResult } from '@/utils';
import { hasUsageData } from '@/utils';

/**
 * How often the claude.ai usage snapshot is refreshed. Five minutes is the
 * balance the numbers themselves suggest: the windows are 5-hour / 7-day, the
 * countdown to reset ticks locally every second (`useClock`), and a live session
 * pushes a `rate_limit_event` at the start of every turn — so polling exists to
 * cover the *idle* case, not to chase the last percent. Each poll spawns a
 * short-lived `claude` subprocess (no inference, no tokens), which is exactly why
 * it is minutes rather than seconds.
 */
export const USAGE_POLL_INTERVAL_MS = 5 * 60_000;

/**
 * How many consecutive empty probes end the polling. An API-key / Bedrock / Vertex
 * login has no subscription usage at all, and one transient failure (offline,
 * `claude` busy) shouldn't be mistaken for that — so require two in a row before
 * giving up for the rest of the run.
 */
const MAX_EMPTY_POLLS = 2;

export interface UsagePollingDeps {
  /** Runs one probe (`utils/usage-probe.fetchUsageSnapshot`, best-effort). */
  fetch: () => Promise<UsageProbeResult>;
  /** Folds the result into the manager (`manager.applyUsage`). */
  apply: (result: UsageProbeResult) => void;
  /** Override for tests. Defaults to {@link USAGE_POLL_INTERVAL_MS}. */
  intervalMs?: number;
}

/**
 * Keep the account plan + usage windows fresh: probe once now, then every
 * `intervalMs`. Returns a stop fn (the composition root calls it on shutdown).
 *
 * Overlapping probes are skipped rather than queued — a slow probe must not stack
 * up subprocesses — and the timer is unref'd so it never keeps the process alive.
 */
export function startUsagePolling(deps: UsagePollingDeps): () => void {
  const intervalMs = deps.intervalMs ?? USAGE_POLL_INTERVAL_MS;
  let inFlight = false;
  let emptyPolls = 0;
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | undefined;

  const stop = () => {
    stopped = true;
    if (timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  };

  const poll = async (): Promise<void> => {
    if (inFlight || stopped) {
      return;
    }
    inFlight = true;
    try {
      // fetchUsageSnapshot は投げない契約だが、ここで潰しておけば注入側の実装が
      // どうであれポーリング自体は止まらない（unhandled rejection も出ない）。
      const result = await deps.fetch().catch((): UsageProbeResult => ({}));
      if (stopped) {
        return;
      }
      deps.apply(result);
      if (hasUsageData(result)) {
        emptyPolls = 0;
      } else if (++emptyPolls >= MAX_EMPTY_POLLS) {
        // This login will never report subscription usage — stop spawning probes.
        stop();
      }
    } finally {
      inFlight = false;
    }
  };

  void poll();
  timer = setInterval(() => {
    void poll();
  }, intervalMs);
  timer.unref?.();
  return stop;
}
