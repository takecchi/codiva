import { Box } from 'ink';
import type { FC, ReactNode } from 'react';
import { theme } from './theme';

/**
 * The shared modal frame: a round border with horizontal padding. Used by every
 * overlay (command palette, permission/model dialogs, the merge/discard confirm
 * and actions panel) so they all read as one surface. `borderColor` defaults to
 * the brand accent; pass a column layout for stacked content.
 *
 * `flexShrink={0}`: Ink/Yoga *shrinks* overflowing children instead of clipping
 * them, so in a short terminal the frame lost rows out of its middle — the dialog
 * silently dropped lines (and mouse hit-testing over it pointed at the wrong text).
 * The role of giving up space belongs to the regions that scroll internally (the
 * session list, the detail log), not to a modal — see .claude/rules/ink-components.md.
 */
export const DialogBox: FC<{
  borderColor?: string;
  flexDirection?: 'row' | 'column';
  children: ReactNode;
}> = ({ borderColor = theme.accent, flexDirection, children }) => (
  <Box
    borderStyle="round"
    borderColor={borderColor}
    paddingX={1}
    flexDirection={flexDirection}
    flexShrink={0}
  >
    {children}
  </Box>
);
