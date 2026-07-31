import { Box, type DOMElement, Text, useWindowSize } from 'ink';
import type { FC, RefObject } from 'react';
import {
  type BannerLine,
  type BannerTone,
  type BannerUsageRow,
  bannerGaugeWidth,
  bannerLineText,
  bannerText,
  bannerUsageRows,
  gaugeCells,
  lineSelection,
  type RateLimitWindow,
  type SelectionRange,
  selectionSlices,
  shouldWarnTraining,
  type TrainingOptIn,
} from '@/core';
import { useMessages } from './i18n-context';
import { glyph, palette, statusColor, theme } from './theme';

// codiva mascot. Each glyph is rendered in its own <Text>, so you can paint it
// one character at a time via paint() below.
const LOGO = [
  ' ▄▄ ▄▄▄▄▄▄▄ ▄▄',
  ' █████████████',
  '██▀██▀███▀██▀██',
  '██ █ █ ▀ █ █ ██',
  '██ █       █ ██',
  '▀   ▀▀▀▀▀▀▀   ▀',
];

/**
 * Per-character painter — return an Ink color (named / '#hex' / 'rgb(r,g,b)') for
 * the glyph at (row, col), or undefined for the terminal default. Paint however
 * you like; the example below shades by glyph and tints the two eyes:
 *   - by position (a single cell): `if (row === 3 && col === 5) return 'cyan'`
 *   - by glyph/shade: switch on `ch` ('█' darkest → '▒' lightest)
 *   - by line: switch on `row`
 */
// One-off eye glint — a lighter aqua tint used nowhere else, so it stays local
// rather than expanding the brand palette.
const GLINT = '#c3e5e7';

function paint(row: number, col: number): string | undefined {
  if (col === 0 || col === 1 || col === 13 || col === 14) return palette.aqua;
  if (row === 1 && (col === 5 || col === 7)) return GLINT;
  if (row === 0 && (col === 2 || col === 12)) return palette.ink;
  if (row === 1 && (col === 2 || col === 12)) return palette.pink;
  if (row === 2 && (col === 2 || col === 12)) return palette.ink;
  if (row === 3 && (col === 5 || col === 9)) return palette.teal;
  if (row === 4 && (col === 3 || col === 11)) return palette.teal;
  if (row === 5 && 4 <= col && col <= 10) return palette.teal;
  return palette.aqua;
}

// Precompute cells with stable keys (so JSX keys aren't raw array indices).
const LOGO_ROWS = LOGO.map((line, row) => ({
  key: `logo-row-${row}`,
  cells: [...line].map((ch, col) => ({ key: `${row}:${col}`, ch, row, col })),
}));

/**
 * Map a semantic tone to Ink text props. Colors live only here (`theme.ts`) — the
 * text itself is composed by the pure `bannerLines` in core. A highlighted
 * (inverse) piece drops `dimColor` so the selection stays legible.
 */
function toneStyle(tone: BannerTone, inverse: boolean): { color?: string; dimColor?: boolean } {
  switch (tone) {
    case 'accent':
      return { color: theme.accent };
    case 'warn':
      return { color: statusColor.awaitingPermission };
    case 'error':
      return { color: statusColor.failed };
    case 'dim':
      return inverse ? {} : { dimColor: true };
    default:
      return {};
  }
}

interface RowPiece {
  key: string;
  text: string;
  tone: BannerTone;
  bold?: boolean;
  /** Part of the mouse selection → drawn as an inverse (highlighted) cell run. */
  inverse: boolean;
}

/**
 * Split one header line's segments into styled pieces, cutting each segment at the
 * selection boundaries so the highlight can span a run that crosses segments (the
 * wordmark line is several segments: bold name, dim version, dim counters).
 * `sel` offsets are char indices within this line (see `lineSelection`).
 *
 * 切り分けそのものは純粋な `selectionSlices`（ログ行の反転描画と共用）。ここは片ごとに
 * 元セグメントの色調を引き直すだけ。
 */
function rowPieces(line: BannerLine, sel?: { from: number; to: number }): RowPiece[] {
  return selectionSlices(
    line.segments.map((seg) => seg.text),
    sel,
  ).map((slice) => {
    const seg = line.segments[slice.index];
    return {
      key: `${slice.index}:${slice.offset}`,
      text: slice.text,
      inverse: slice.inverse,
      tone: seg?.tone ?? 'normal',
      bold: seg?.bold,
    };
  });
}

/**
 * One header row. `wrap="truncate-end"` is required, not cosmetic: mouse
 * hit-testing maps a terminal row straight to a line index (`bannerCaretAt`), so a
 * line that soft-wrapped into two rows would shift every line below it.
 */
const BannerRow: FC<{ line: BannerLine; sel?: { from: number; to: number } }> = ({ line, sel }) => {
  const pieces = rowPieces(line, sel);
  if (pieces.length === 0) {
    // 空行（使用状況節の前のスペーサ）。高さ 1 を保つためスペースを 1 つ描く。
    return <Text> </Text>;
  }
  return (
    <Text wrap="truncate-end">
      {pieces.map((p) => (
        <Text key={p.key} bold={p.bold} inverse={p.inverse} {...toneStyle(p.tone, p.inverse)}>
          {p.text}
        </Text>
      ))}
    </Text>
  );
};

/**
 * `████░░░░░░░░░░░░` — フッタと同じ見た目のゲージ。使用率が取れない枠
 * （SDK が返さないプランがある）ではゲージを描かず、**同じ幅の空白**を置いて
 * 右隣の列（残り時間）を揃える（0% のゲージを描くと「まだ使っていない」と誤読される）。
 * `width` が 0（狭い端末）ならゲージそのものを出さない。
 */
const UsageGauge: FC<{ percent?: number; tone: BannerTone; width: number }> = ({
  percent,
  tone,
  width,
}) => {
  if (width === 0) {
    return null;
  }
  if (percent === undefined) {
    return <Text>{' '.repeat(width)}</Text>;
  }
  const cells = gaugeCells(percent, width);
  return (
    <Text>
      <Text {...toneStyle(tone, false)}>{glyph.gaugeFilled.repeat(cells.filled)}</Text>
      <Text dimColor>{glyph.gaugeEmpty.repeat(cells.empty)}</Text>
    </Text>
  );
};

/** 使用状況 1 行: `  Current session  ███░░░  42%  resets in 4h 45m`。 */
const UsageRow: FC<{ row: BannerUsageRow; gaugeWidth: number }> = ({ row, gaugeWidth }) => (
  <Text wrap="truncate-end">
    <Text dimColor>{`  ${row.label}  `}</Text>
    <UsageGauge percent={row.percent} tone={row.tone} width={gaugeWidth} />
    <Text
      {...toneStyle(row.tone, false)}
    >{`${gaugeWidth === 0 ? '' : ' '}${row.percentText}`}</Text>
    {row.detail ? <Text dimColor>{`  ${row.detail}`}</Text> : null}
  </Text>
);

/**
 * claude.ai の使用リミット（見出し + 枠ごとのゲージ行）。枠が無い環境
 * （API キー / Bedrock / Vertex）では何も描かない。
 *
 * `PrivacySection` と同じく **選択可能なテキスト塊（textRef）の外**に描く。ゲージの記号は
 * `theme.ts` が持つもので、純粋な `bannerLines` に持ち込みたくないうえ、ヘッダのドラッグ
 * 選択の用途は cwd の取り出しなのでコピー対象にする必要がない。塊の外なので `marginTop`
 * で空けても「行 index = 表示行」（`bannerCaretAt`）は揺らがない。
 */
const UsageSection: FC<{ windows: readonly RateLimitWindow[]; now: number }> = ({
  windows,
  now,
}) => {
  const m = useMessages();
  const { columns } = useWindowSize();
  const rows = bannerUsageRows(m, windows, now);
  if (rows.length === 0) {
    return null;
  }
  // ゲージ幅は端末幅で決める（純粋な判定は core/layout.ts）。ここを固定幅にすると
  // 狭い端末でヘッダ全体が縮められ、マスコットが折り返して崩れる。
  const gaugeWidth = bannerGaugeWidth(columns);
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text dimColor>{m.banner.usage.heading}</Text>
      {rows.map((row) => (
        <UsageRow key={row.type} row={row} gaugeWidth={gaugeWidth} />
      ))}
    </Box>
  );
};

/**
 * 学習データ利用（claude.ai の「Help improve our AI models」）が ON と分かったときだけ
 * 出す注意セクション。`'off'` / `'unknown'`（未ログイン・API キー利用・取得失敗）では
 * 何も描かないので、判定できない環境ではバナーの見た目が変わらない。
 *
 * `bannerLines` の行としてではなく **選択可能なテキスト塊（textRef）の外**に描く。
 * 理由は 2 つ: (1) 警告はドラッグでコピーする対象ではない（ヘッダ選択の用途は cwd の
 * 取り出し）、(2) `⚠` は `theme.ts` が持つ記号で、純粋な core に持ち込みたくない。
 * 外に置くので `bannerCaretAt` の「行 index = 表示行」も揺らさない。
 */
const PrivacySection: FC<{ optIn?: TrainingOptIn }> = ({ optIn }) => {
  const m = useMessages();
  if (!shouldWarnTraining(optIn)) {
    return null;
  }
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color={statusColor.awaitingPermission}>
        {`${glyph.warning} ${m.banner.privacy.warning}`}
      </Text>
      <Text dimColor>{`  ${m.banner.privacy.hint}`}</Text>
    </Box>
  );
};

/**
 * Borderless startup header echoing Claude Code's banner: the mascot on the left
 * and identity / plan + model / cwd on the right (vertically centered against it),
 * with the claude.ai usage gauges below. Purely presentational — the text is
 * composed by `bannerLines` / `bannerUsageRows` in core, and the owning view
 * supplies the mouse selection (drag to copy the repo path).
 */
export const Banner: FC<{
  /** 表示行（`bannerLines`）。1 要素 = 1 表示行。 */
  lines: readonly BannerLine[];
  /** Highlighted mouse-selection range over `bannerText(lines)`. */
  selection?: SelectionRange;
  /** 使用リミット枠（`rate_limit_event` + `/usage` ポーリングの統合結果）。 */
  usage?: readonly RateLimitWindow[];
  /** リセットまでの残り時間を算出する基準時刻（ms）。省略時は現在時刻。 */
  now?: number;
  /**
   * テキスト欄の左上を実測するための ref。マウス座標 → 文字位置の逆算に使うので、
   * **行だけを包む内側の Box** に付ける（中央寄せの外側 Box だと centering のぶん
   * ずれて、クリック位置が 1〜2 行手前の行に当たる）。
   */
  textRef?: RefObject<DOMElement | null>;
  /**
   * 学習データ利用の状態（`utils/privacy.ts` 由来）。`'on'` のときだけ注意行を出す。
   * 未解決・判定不能は undefined / `'unknown'` で、その場合は何も描かない。
   */
  trainingOptIn?: TrainingOptIn;
}> = ({ lines, selection, usage = [], now, textRef, trainingOptIn }) => {
  const value = selection ? bannerText(lines) : undefined;
  const rows = lines.map((line, row) => ({
    key: `banner-line-${row}-${bannerLineText(line).slice(0, 8)}`,
    line,
    sel: value !== undefined && selection ? lineSelection(value, selection, row) : undefined,
  }));
  return (
    // ここで flexShrink を止めないこと: 低い端末ではヘッダも縮んで場所を譲る（コマンド
    // パレット等の下段 UI が潰れる）。**行 Box も縮ませる**のが重要で、内側だけ
    // flexShrink={0} にすると中央寄せ（justifyContent="center"）が負のオフセットを返し、
    // ヘッダのテキストが一覧の先頭行に重なって描かれてしまう。
    // ただし縦に潰れたときに落ちるのは**上端の行から**（中央寄せが負のオフセットになる）で、
    // 「行 index = 表示行」は保たれない。そのため `SessionList` は実測高さが行数より小さい
    // 間はヘッダの当たり判定をやめる（`headerCaretAt`）。重なりが起きた場合の優先順位も
    // `SessionList` 側（一覧の行を優先）で決める。
    <Box>
      {/* マスコットは**横方向に縮ませない**（`flexShrink={0}`）。行は truncate を持たない
          アスキーアートなので、幅が足りなくなると折り返して 6 行の絵が崩れる。右のテキスト
          欄は各行が `wrap="truncate-end"` なので、縮小はすべてそちらに寄せて末尾を切る。
          縦方向の縮小（低い端末でヘッダが場所を譲る）はこの指定では止まらない — main axis が
          横の行なので、ここでの flexShrink は横幅だけに効く。 */}
      <Box flexDirection="column" flexShrink={0} marginRight={2}>
        {LOGO_ROWS.map((r) => (
          <Text key={r.key}>
            {r.cells.map((c) => (
              <Text key={c.key} color={paint(c.row, c.col)}>
                {c.ch}
              </Text>
            ))}
          </Text>
        ))}
      </Box>
      <Box flexDirection="column" justifyContent="center">
        <Box ref={textRef} flexDirection="column">
          {rows.map((r) => (
            <BannerRow key={r.key} line={r.line} sel={r.sel} />
          ))}
        </Box>
        <UsageSection windows={usage} now={now ?? Date.now()} />
        <PrivacySection optIn={trainingOptIn} />
      </Box>
    </Box>
  );
};
