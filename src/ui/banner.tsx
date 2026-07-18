import { Box, Text } from 'ink';
import type { FC } from 'react';
import { useMessages } from './i18n-context';
import { glyph, theme } from './theme';

// codiva mascot. Each glyph is rendered in its own <Text>, so you can paint it
// one character at a time via paint() below.
const LOGO = [
  ' ▄  ▄▄▄▄▄▄▄  ▄',
  ' █▒██▓▓█████▒█',
  '██▒▓▓▀▓▓▓▀▓▓▒██',
  '██ ▓ █ ▀ █ ▓ ██',
  '██ ▓▒▒   ▒▒▓ ██',
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
  if (row === 3 && (col === 5 || col === 9)) return 'cyan'; // eyes
  if (ch === '█') return '#ff7847';
  if (ch === '▓') return '#ff9d5c';
  if (ch === '▒') return '#ffd7a8';
  if (ch === '▄' || ch === '▀') return '#e85d2f';
  return undefined; // spaces
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
export const Banner: FC<{ cwd?: string; sessionCount: number }> = ({ cwd, sessionCount }) => {
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
          </Text>
        </Text>
        <Text dimColor>{m.banner.subtitle}</Text>
        {cwd ? <Text dimColor>{cwd}</Text> : null}
      </Box>
    </Box>
  );
};
