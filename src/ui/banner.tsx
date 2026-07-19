import { Box, Text } from 'ink';
import type { FC } from 'react';
import { formatUsd } from '@/core';
import { useMessages } from './i18n-context';
import { palette } from './theme';

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

function paint(ch: string, row: number, col: number): string | undefined {
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
 * Borderless startup header echoing Claude Code's banner: the mascot on the left
 * and identity / subtitle / cwd on the right (vertically centered against it).
 */
export const Banner: FC<{
  cwd?: string;
  model?: string;
  /** アプリのバージョン（package.json 由来）。ワードマークの右に `vX.Y.Z` で表示。 */
  version?: string;
  sessionCount: number;
  totalCostUsd?: number;
}> = ({ cwd, model, version, sessionCount, totalCostUsd = 0 }) => {
  const m = useMessages();
  return (
    <Box>
      <Box flexDirection="column" marginRight={2}>
        {LOGO_ROWS.map((r) => (
          <Text key={r.key}>
            {r.cells.map((c) => (
              <Text key={c.key} color={paint(c.ch, c.row, c.col)}>
                {c.ch}
              </Text>
            ))}
          </Text>
        ))}
      </Box>
      <Box flexDirection="column" justifyContent="center">
        <Text>
          {/* ワードマークは通常色（セッション一覧のタイトルと同じ）+ Bold。
              すぐ右に model 行と同じ dim 色でバージョンを添える。 */}
          <Text bold>Codiva</Text>
          {version ? <Text dimColor>{` v${version}`}</Text> : null}
          <Text dimColor>
            {'   '}
            {m.list.sessionCount(sessionCount)}
            {totalCostUsd > 0 ? `   ${m.list.totalCost(formatUsd(totalCostUsd))}` : ''}
          </Text>
        </Text>
        <Text dimColor>{m.banner.subtitle}</Text>
        <Text dimColor>{m.banner.model(model ?? m.banner.defaultModel)}</Text>
        {cwd ? <Text dimColor>{cwd}</Text> : null}
      </Box>
    </Box>
  );
};
