import { Box, Text } from 'ink';
import type { FC } from 'react';
import { glyph, theme } from './theme';

/**
 * Claude-Code-style input: a full-width horizontal rule above and below a single
 * `❯` prompt line (no side borders / corners). Purely presentational — key
 * handling lives in the owning view (a single useInput per screen); this just
 * renders the buffer and a block caret.
 */
export const PromptInput: FC<{
  value: string;
  focused: boolean;
  placeholder?: string;
}> = ({ value, focused, placeholder = '' }) => {
  const empty = value.length === 0;
  const caret = focused ? <Text inverse> </Text> : null;
  return (
    <Box
      borderStyle="single"
      borderColor={theme.dim}
      borderTop
      borderBottom
      borderLeft={false}
      borderRight={false}
    >
      <Text color={theme.accent}>{glyph.caret} </Text>
      {empty ? (
        <Text>
          {caret}
          <Text dimColor>{placeholder}</Text>
        </Text>
      ) : (
        <Text>
          {value}
          {caret}
        </Text>
      )}
    </Box>
  );
};
