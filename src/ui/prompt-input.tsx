import { Box, Text } from 'ink';
import type { FC } from 'react';

/**
 * Presentational one-line input. Key handling lives in the owning view (so there
 * is a single useInput per screen); this just renders the buffer and a caret.
 */
export const PromptInput: FC<{
  value: string;
  focused: boolean;
  placeholder?: string;
  label?: string;
}> = ({ value, focused, placeholder = '', label = '›' }) => {
  const showPlaceholder = value.length === 0 && !focused;
  return (
    <Box>
      <Text color="cyan">{label} </Text>
      {showPlaceholder ? (
        <Text dimColor>{placeholder}</Text>
      ) : (
        <Text>
          {value}
          {focused ? <Text inverse> </Text> : null}
        </Text>
      )}
    </Box>
  );
};
