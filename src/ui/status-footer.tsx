import { Box, Text, useWindowSize } from 'ink';
import type { FC } from 'react';
import {
  type AccountSummary,
  compactRateLimitWindows,
  gaugeCells,
  type RateLimitWindow,
  type RunMode,
  rateLimitLabelKey,
  resetCountdown,
  usageFooterPlan,
} from '@/core';
import { useMessages } from './i18n-context';
import { glyph, statusColor, theme } from './theme';

/** Width of the usage bar in cells. Wide enough to read 1/8 steps, narrow enough for the footer. */
const GAUGE_WIDTH = 8;

/** Semantic color for a usage window: red when turned away, amber on warning, accent otherwise. */
function usageColor(status: RateLimitWindow['status']): string {
  if (status === 'rejected') {
    return statusColor.failed;
  }
  if (status === 'allowed_warning') {
    return statusColor.awaitingPermission;
  }
  return theme.accent;
}

/**
 * `· 5h ███░░░░░ 42% 3h40m left` — the bar is dropped when the SDK reports no
 * utilization (a 0%-looking gauge would be a lie) or when the terminal is too
 * narrow to afford it (`showBar`).
 */
const UsageWindowSegment: FC<{
  window: RateLimitWindow;
  now: number;
  showBar: boolean;
  /** 直前に別の要素があるか（無ければ先頭なので区切りの `·` を出さない）。 */
  separated: boolean;
}> = ({ window, now, showBar, separated }) => {
  const m = useMessages();
  const label = m.footer.usage[rateLimitLabelKey(window.type)];
  const color = usageColor(window.status);
  const percent = window.utilization;
  const bar = !showBar || percent === undefined ? undefined : gaugeCells(percent, GAUGE_WIDTH);
  const countdown =
    window.resetsAt === undefined ? undefined : resetCountdown(window.resetsAt, now);
  return (
    <Text>
      <Text dimColor>{`${separated ? ` ${glyph.dot} ` : ''}${label} `}</Text>
      {bar ? (
        <Text>
          <Text color={color}>{glyph.gaugeFilled.repeat(bar.filled)}</Text>
          <Text dimColor>{glyph.gaugeEmpty.repeat(bar.empty)}</Text>
        </Text>
      ) : null}
      {percent !== undefined ? (
        <Text color={color}>{`${bar ? ' ' : ''}${Math.round(percent)}%`}</Text>
      ) : null}
      {countdown ? (
        <Text dimColor>
          {bar || percent !== undefined ? ' ' : ''}
          {m.footer.usage.resetsInShort(countdown.days, countdown.hours, countdown.minutes)}
        </Text>
      ) : null}
    </Text>
  );
};

/**
 * The right-hand usage readout: plan name plus the most relevant rate-limit
 * windows. Renders nothing when neither is known (API-key logins report no plan
 * and no windows), so it stays invisible where subscription limits don't exist.
 *
 * Windows come from two sources folded together in the manager — `rate_limit_event`
 * (pushed at the start of every turn) and the polled `/usage` snapshot — so the
 * numbers stay close to live without any work here beyond the ticking countdown.
 */
const UsageStatus: FC<{
  account?: AccountSummary;
  windows: readonly RateLimitWindow[];
  now: number;
  columns: number;
}> = ({ account, windows, now, columns }) => {
  // 端末幅に応じて出す量を決める（純粋な判定は core/layout.ts）。
  const plan = usageFooterPlan(columns);
  const shown = compactRateLimitWindows(windows, plan.windows);
  const planName = plan.showPlan ? account?.plan : undefined;
  if (planName === undefined && shown.length === 0) {
    return null;
  }
  return (
    // 縮まない枠（出す量は幅ごとに usageFooterPlan が決める）。念のため
    // truncate-end も付けて、想定外に長い文言でも折り返さないようにする。
    <Box flexShrink={0} marginLeft={2}>
      <Text wrap="truncate-end">
        {/* プラン名は SDK 由来の表示文字列なのでそのまま出す（i18n の例外）。 */}
        {planName ? <Text dimColor>{planName}</Text> : null}
        {shown.map((w, index) => (
          <UsageWindowSegment
            key={w.type}
            window={w}
            now={now}
            showBar={plan.showBars}
            separated={index > 0 || planName !== undefined}
          />
        ))}
      </Text>
    </Box>
  );
};

/**
 * The mode + hint line under the input, echoing Claude Code's
 * "⏵⏵ auto mode on (shift+tab to cycle)" footer, with the claude.ai plan / usage
 * readout pushed to the right edge (the equivalent of Claude Code's status line).
 * `mode` is the live tool-approval mode (toggled with shift+tab); `hint` is the
 * screen's context text (already localized by the caller). Mode labels come from
 * the message catalog.
 *
 * **The footer is exactly one line at any width.** Three zones with explicit
 * priority, because a wrapped footer steals a row from the log and reads as a
 * layout bug:
 *   1. mode indicator — never shrinks (it says whether tools auto-run).
 *   2. usage readout — never shrinks either; instead `usageFooterPlan(columns)`
 *      decides how much of it to build in the first place (2 windows → 1 → drop the
 *      gauge → drop the plan name → nothing), so it degrades in whole units rather
 *      than getting sliced mid-number.
 *   3. context hint — the only zone that shrinks, truncating at the tail.
 */
export const StatusFooter: FC<{
  mode: RunMode;
  hint?: string;
  /** claude.ai のプラン情報（SDK probe 由来）。無い環境では表示しない。 */
  account?: AccountSummary;
  /** 使用リミット枠（rate_limit_event + /usage ポーリングの統合結果）。 */
  usage?: readonly RateLimitWindow[];
  /** リセットまでの残り時間を算出する基準時刻（ms）。省略時は現在時刻。 */
  now?: number;
}> = ({ mode, hint, account, usage = [], now }) => {
  const m = useMessages();
  const { columns } = useWindowSize();
  const auto = mode === 'auto';
  return (
    <Box marginLeft={2}>
      {/* モード表示は縮まない（ツールが自動実行かどうかは常に読めるべき）。 */}
      <Box flexShrink={0}>
        <Text color={auto ? theme.auto : theme.confirm} bold>
          {auto ? glyph.auto : glyph.confirm} {auto ? m.footer.autoMode : m.footer.confirmMode}
        </Text>
      </Box>
      {/* ヒントだけが縮む枠。伸びるのは下のスペーサだけにする（ヒントを伸ばすと
          余白が「内容」扱いになり、幅が足りているのに使用状況が縮められてしまう）。 */}
      <Box flexGrow={0} flexShrink={1} overflowX="hidden">
        <Text dimColor wrap="truncate-end">
          {' '}
          {m.footer.cycleHint}
          {hint ? ` ${glyph.dot} ${hint}` : ''}
        </Text>
      </Box>
      {/* 余白の吸収だけを担うスペーサ（幅 0 なので縮小の配分に影響しない）。 */}
      <Box flexGrow={1} flexShrink={0} />
      <UsageStatus account={account} windows={usage} now={now ?? Date.now()} columns={columns} />
    </Box>
  );
};
