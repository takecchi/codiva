import { Box, Text } from 'ink';
import type { FC } from 'react';
import {
  bufferLines,
  cursorRowCol,
  INPUT_MAX_ROWS,
  isEmptyBuffer,
  type TextBuffer,
  visibleLineRange,
} from '@/core';
import { glyph, theme } from './theme';

/** Render one line with a block caret drawn at `col` (inverse cell). Reads a full
 *  code point so an astral char under the caret isn't split into a lone surrogate. */
const CaretLine: FC<{ line: string; col: number }> = ({ line, col }) => {
  const cp = line.codePointAt(col);
  const ch = cp === undefined ? ' ' : String.fromCodePoint(cp);
  return (
    <Text wrap="truncate-end">
      {line.slice(0, col)}
      <Text inverse>{ch}</Text>
      {line.slice(col + ch.length)}
    </Text>
  );
};

/**
 * Claude-Code-style composer: a full-width horizontal rule above and below the
 * input (no side borders). Purely presentational — key handling lives in the
 * owning view (a single useInput per screen). Multi-line aware: the box grows with
 * the content up to `maxRows` lines, then scrolls internally to keep the caret in
 * view (`visibleLineRange`). Empty/single-line input stays exactly one row tall.
 */
export const PromptInput: FC<{
  buffer: TextBuffer;
  focused: boolean;
  placeholder?: string;
  maxRows?: number;
}> = ({ buffer, focused, placeholder = '', maxRows = INPUT_MAX_ROWS }) => {
  const frame = {
    borderStyle: 'single' as const,
    borderColor: theme.dim,
    borderTop: true,
    borderBottom: true,
    borderLeft: false,
    borderRight: false,
  };

  if (isEmptyBuffer(buffer)) {
    return (
      <Box {...frame}>
        <Text color={theme.accent}>{glyph.caret} </Text>
        <Text>
          {focused ? <Text inverse> </Text> : null}
          <Text dimColor>{placeholder}</Text>
        </Text>
      </Box>
    );
  }

  const lines = bufferLines(buffer.value);
  const { row, col } = cursorRowCol(buffer);
  const { start, end } = visibleLineRange(lines.length, row, maxRows);

  return (
    <Box {...frame} flexDirection="column">
      {lines.slice(start, end).map((line, i) => {
        const lineIndex = start + i;
        const isCaretLine = focused && lineIndex === row;
        return (
          // Line index is a stable key within a single render's window.
          <Box key={lineIndex}>
            <Text color={theme.accent}>{i === 0 ? `${glyph.caret} ` : '  '}</Text>
            {isCaretLine ? (
              <CaretLine line={line} col={col} />
            ) : (
              <Text wrap="truncate-end">{line}</Text>
            )}
          </Box>
        );
      })}
    </Box>
  );
};
