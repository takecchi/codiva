import { Box, Text } from 'ink';
import type { FC } from 'react';
import { formatUsd } from '@/core';
import { useMessages } from './i18n-context';
import { glyph, theme } from './theme';

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
function paint(ch: string, row: number, col: number): string | undefined {
  if (col === 0 || col === 1 || col === 13 || col === 14) return '#86cecb';
  if (row === 1 && (col === 5 || col === 7)) return '#c3e5e7';
  if (row === 0 && (col === 2 || col === 12)) return '#373b3e';
  if (row === 1 && (col === 2 || col === 12)) return '#e12885';
  if (row === 2 && (col === 2 || col === 12)) return '#373b3e';
  if (row === 3 && (col === 5 || col === 9)) return '#137a7f';
  if (row === 4 && (col === 3 || col === 11)) return '#137a7f';
  if (row === 5 && 4 <= col && col <= 10) return '#137a7f';
  return '#86cecb';
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
export const Banner: FC<{ cwd?: string; sessionCount: number; totalCostUsd?: number }> = ({
  cwd,
  sessionCount,
  totalCostUsd = 0,
}) => {
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
          <Text color={theme.accent} bold>
            {glyph.star} codiva
          </Text>
          <Text dimColor>
            {'   '}
            {m.list.sessionCount(sessionCount)}
            {totalCostUsd > 0 ? `   ${m.list.totalCost(formatUsd(totalCostUsd))}` : ''}
          </Text>
        </Text>
        <Text dimColor>{m.banner.subtitle}</Text>
        {cwd ? <Text dimColor>{cwd}</Text> : null}
      </Box>
    </Box>
  );
};
