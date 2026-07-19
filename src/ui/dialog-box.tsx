import { Box } from 'ink';
import type { FC, ReactNode } from 'react';
import { theme } from './theme';

/**
 * The shared modal frame: a round border with horizontal padding. Used by every
 * overlay (command palette, permission/model dialogs, the merge/discard confirm
 * and actions panel) so they all read as one surface. `borderColor` defaults to
 * the brand accent; pass a column layout for stacked content.
 */
export const DialogBox: FC<{
  borderColor?: string;
  flexDirection?: 'row' | 'column';
  children: ReactNode;
}> = ({ borderColor = theme.accent, flexDirection, children }) => (
  <Box borderStyle="round" borderColor={borderColor} paddingX={1} flexDirection={flexDirection}>
    {children}
  </Box>
);
