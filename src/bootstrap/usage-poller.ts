import type { UsageProbeResult } from '@/utils';
import { hasNoSubscription, hasUsageData } from '@/utils';

/**
 * How often the claude.ai usage snapshot is refreshed. Five minutes is the
 * balance the numbers themselves suggest: the windows are 5-hour / 7-day, the
 * countdown to reset ticks locally (`useClock`), and a live session pushes a
 * `rate_limit_event` at the start of every turn — so polling exists to cover the
 * *idle* case, not to chase the last percent. Each poll spawns a short-lived
 * `claude` subprocess (no inference, no tokens), which is exactly why it is
 * minutes rather than seconds.
 */
export const USAGE_POLL_INTERVAL_MS = 5 * 60_000;

/**
 * Fallback give-up threshold, for logins that report *nothing* — no plan, no
 * windows, and not even the "limits don't apply" signal that
 * {@link hasNoSubscription} keys on (an SDK that dropped both control requests,
 * say). The primary stop path is that positive signal; this one only exists so an
 * unknown environment can't be probed forever.
 *
 * Three in a row (15 minutes) rather than two, because a cold start contending with
 * the model-catalog probe, one offline moment, or one slow control request must not
 * be mistaken for "this account has no subscription".
 */
const MAX_EMPTY_POLLS = 3;

export interface UsagePollingDeps {
  /** Runs one probe (`utils/usage-probe.fetchUsageSnapshot`, best-effort). */
  fetch: () => Promise<UsageProbeResult>;
  /** Folds the result into the manager (`manager.applyUsage`). */
  apply: (result: UsageProbeResult) => void;
  /**
   * Optional gate for the first probe (the composition root passes the model-catalog
   * fetch). Both probes spawn a `claude` subprocess, so waiting avoids two cold
   * starts at once — which is also what makes the probe deadlines fire spuriously.
   * Rejection is ignored; the poll runs either way.
   */
  after?: Promise<unknown>;
  /**
   * 問い合わせてよいか（毎回の poll の直前に聞く）。`false` の回は probe を立てず、
   * 「空振り」としても数えない（あとで対象が現れたら再開する）。
   *
   * 使用状況ゲージは `usage` を報告する provider のアカウントの話なので、Codex /
   * Grok だけで作業している間は表示もしないし取りにも行かない（合成レイヤが
   * `showsAccountUsage` で判定する）。省略時は常に問い合わせる。
   */
  enabled?: () => boolean;
  /** Override for tests. Defaults to {@link USAGE_POLL_INTERVAL_MS}. */
  intervalMs?: number;
}

/**
 * Keep the account plan + usage windows fresh: probe once (after `after` settles),
 * then every `intervalMs`. Returns a stop fn (the composition root calls it on
 * shutdown).
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
    // 出さない画面のために `claude` のサブプロセスを立てない。stop() はしない —
    // あとで Claude のセッションを作ったら（既定を戻したら）そこから再開する。
    if (deps.enabled?.() === false) {
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
      // apply は購読者（UI）を起こすので、そこの例外でポーリングを殺さない。
      try {
        deps.apply(result);
      } catch {
        // best-effort: 表示の更新に失敗しても次回の取得は続ける。
      }
      if (hasNoSubscription(result)) {
        stop(); // このログインでは永久に取れない — サブプロセスを立てるのをやめる。
      } else if (hasUsageData(result)) {
        emptyPolls = 0;
      } else if (++emptyPolls >= MAX_EMPTY_POLLS) {
        stop();
      }
    } finally {
      inFlight = false;
    }
  };

  const first = deps.after ?? Promise.resolve();
  void first.then(
    () => poll(),
    () => poll(),
  );
  timer = setInterval(() => {
    void poll();
  }, intervalMs);
  timer.unref?.();
  return stop;
}
