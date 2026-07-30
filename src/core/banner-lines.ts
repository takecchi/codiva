import stringWidth from 'string-width';
import { formatUsd } from './cost';
import type { Messages } from './i18n';
import { type RateLimitWindow, rateLimitLabelKey, resetCountdown } from './rate-limit';
import { caretIndexForColumn, indexAtRowCol } from './text-buffer';

/**
 * Semantic emphasis for a header segment. The banner lives in `ui/` but its text
 * is composed here (pure), so tones stay abstract — `ui/theme.ts` is still the only
 * place that knows actual colors (see .claude/rules/ink-components.md).
 */
export type BannerTone = 'normal' | 'dim' | 'warn' | 'error';

/** A styled run of text within one header line. */
export interface BannerSegment {
  readonly text: string;
  readonly tone: BannerTone;
  readonly bold?: boolean;
}

/** One rendered header row. An empty `segments` is a blank spacer row. */
export interface BannerLine {
  readonly segments: readonly BannerSegment[];
}

export interface BannerInput {
  cwd?: string;
  model?: string;
  /** アプリのバージョン（package.json 由来）。ワードマークの右に `vX.Y.Z` で表示。 */
  version?: string;
  sessionCount: number;
  totalCostUsd?: number;
  /** claude.ai サブスクリプションの使用リミット枠（SDK 由来。空なら非表示）。 */
  rateLimits?: readonly RateLimitWindow[];
  /** リセットまでの残り時間を算出する基準時刻（ms）。 */
  now: number;
}

/** Semantic tone for a usage window: error when rejected, warn on warning, else dim. */
function usageTone(status: RateLimitWindow['status']): BannerTone {
  if (status === 'rejected') {
    return 'error';
  }
  if (status === 'allowed_warning') {
    return 'warn';
  }
  return 'dim';
}

/** Build the "5% used · resets in 4h45m" trailing detail for a usage window. */
function usageDetail(m: Messages, window: RateLimitWindow, now: number): string {
  const parts: string[] = [];
  if (window.utilization !== undefined) {
    parts.push(m.banner.usage.used(Math.round(window.utilization)));
  }
  if (window.resetsAt !== undefined) {
    const { days, hours, minutes } = resetCountdown(window.resetsAt, now);
    parts.push(m.banner.usage.resetsIn(days, hours, minutes));
  }
  return parts.join(' · ');
}

/**
 * The header's text block, one entry per rendered row: wordmark / subtitle /
 * model / cwd, then the claude.ai usage section (blank spacer + heading + one row
 * per window) when the SDK reports limits.
 *
 * Rows are emitted as an explicit list — including the blank spacer, rather than a
 * `marginTop` on the usage box — so row index === line index. Mouse hit-testing
 * inverts that mapping to locate the drag-selected characters (`bannerCaretAt`),
 * and a margin would silently shift every line below it.
 */
export function bannerLines(m: Messages, input: BannerInput): BannerLine[] {
  const lines: BannerLine[] = [];

  // ワードマークは通常色 + Bold、右に dim でバージョン・セッション数・合計コスト。
  const head: BannerSegment[] = [{ text: 'Codiva', tone: 'normal', bold: true }];
  if (input.version) {
    head.push({ text: ` v${input.version}`, tone: 'dim' });
  }
  head.push({ text: `   ${m.list.sessionCount(input.sessionCount)}`, tone: 'dim' });
  const cost = input.totalCostUsd ?? 0;
  if (cost > 0) {
    head.push({ text: `   ${m.list.totalCost(formatUsd(cost))}`, tone: 'dim' });
  }
  lines.push({ segments: head });

  lines.push({ segments: [{ text: m.banner.subtitle, tone: 'dim' }] });
  lines.push({
    segments: [{ text: m.banner.model(input.model ?? m.banner.defaultModel), tone: 'dim' }],
  });
  if (input.cwd) {
    lines.push({ segments: [{ text: input.cwd, tone: 'dim' }] });
  }

  const windows = input.rateLimits ?? [];
  if (windows.length > 0) {
    lines.push({ segments: [] }); // 使用状況節の前の空行（marginTop の代わり）
    lines.push({ segments: [{ text: m.banner.usage.heading, tone: 'dim' }] });
    for (const w of windows) {
      const detail = usageDetail(m, w, input.now);
      const label = m.banner.usage[rateLimitLabelKey(w.type)];
      lines.push({
        segments: [{ text: `  ${label}${detail ? `  ${detail}` : ''}`, tone: usageTone(w.status) }],
      });
    }
  }
  return lines;
}

/** The plain text of one header line (segments concatenated, styling dropped). */
export function bannerLineText(line: BannerLine): string {
  return line.segments.map((s) => s.text).join('');
}

/**
 * The header as one selectable document: every line joined with '\n'. This is the
 * `value` that selection ranges index into (`core/text-selection.ts`), so the same
 * caret-index arithmetic the composer uses applies unchanged.
 */
export function bannerText(lines: readonly BannerLine[]): string {
  return lines.map(bannerLineText).join('\n');
}

/**
 * Caret index into `bannerText(lines)` for a mouse point inside the header's text
 * block. `contentRow` is the 0-based row within the block (`y` minus its top) and
 * `cells` the display column within that row (`x` minus its left edge). Returns
 * undefined when the point is outside the block — above/below it, or left of it
 * (i.e. on the mascot, which isn't selectable text).
 *
 * `beyondEnd` decides what a point past the row's last character means:
 * - `'reject'` (既定): テキストの上でなければ当たりとしない。press はこちら — 行末より
 *   右の余白でクリックを飲むと、そこに何かを置いたときに黙って奪ってしまう。
 * - `'clamp'`: 行末に丸める。drag はこちら — 行末より先までドラッグしたら「行末まで
 *   選ぶ」のが期待動作（パス全体を選ぶときに数セル行き過ぎるのは普通の操作）。
 *
 * Display-width based via `caretIndexForColumn`, so CJK/emoji in a path or model
 * name map to the right character.
 */
export function bannerCaretAt(
  lines: readonly BannerLine[],
  contentRow: number,
  cells: number,
  beyondEnd: 'reject' | 'clamp' = 'reject',
): number | undefined {
  if (contentRow < 0 || contentRow >= lines.length || cells < 0) {
    return undefined;
  }
  const line = lines[contentRow];
  if (line === undefined) {
    return undefined;
  }
  const text = bannerLineText(line);
  if (beyondEnd === 'reject' && cells > stringWidth(text)) {
    return undefined;
  }
  return indexAtRowCol(bannerText(lines), contentRow, caretIndexForColumn(text, cells));
}
