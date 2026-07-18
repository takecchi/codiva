import { Box, Text } from 'ink';
import type { FC } from 'react';
import type { RunMode } from '@/core';
import { useMessages } from './i18n-context';
import { glyph, theme } from './theme';

/**
 * The mode + hint line under the input, echoing Claude Code's
 * "⏵⏵ auto mode on (shift+tab to cycle)" footer. `mode` is the live tool-approval
 * mode (toggled with shift+tab); `hint` is the screen's context text (already
 * localized by the caller). Mode labels come from the message catalog.
 */
export const StatusFooter: FC<{ mode: RunMode; hint?: string }> = ({ mode, hint }) => {
  const m = useMessages();
  const auto = mode === 'auto';
  return (
    <Box marginLeft={2}>
      <Text color={auto ? theme.auto : theme.confirm} bold>
        {auto ? glyph.auto : glyph.confirm} {auto ? m.footer.autoMode : m.footer.confirmMode}
      </Text>
      <Text dimColor>
        {' '}
        {m.footer.cycleHint}
        {hint ? ` ${glyph.dot} ${hint}` : ''}
      </Text>
    </Box>
  );
};
