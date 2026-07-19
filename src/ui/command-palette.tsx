import { Box, Text } from 'ink';
import type { FC } from 'react';
import type { CommandSpec } from '@/core';
import { useMessages } from './i18n-context';
import { glyph, theme } from './theme';

/**
 * Presentational list of slash commands shown above the composer while the user
 * is typing a `/command` (and as the full list for `/help`). No key handling —
 * the owning view's single useInput drives editing; this only reflects state.
 * Empty `commands` renders a "no match" hint so a typo is visible.
 */
export const CommandPalette: FC<{
  title: string;
  commands: readonly CommandSpec[];
}> = ({ title, commands }) => {
  const m = useMessages();
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.dim} paddingX={1}>
      <Text color={theme.accent} bold>
        {glyph.star} {title}
      </Text>
      {commands.length === 0 ? (
        <Text dimColor>{m.command.paletteEmpty}</Text>
      ) : (
        commands.map((c) => (
          <Box key={c.name}>
            <Box width={12}>
              <Text color={theme.accent}>/{c.name}</Text>
            </Box>
            <Text dimColor>{c.describe(m)}</Text>
          </Box>
        ))
      )}
    </Box>
  );
};
