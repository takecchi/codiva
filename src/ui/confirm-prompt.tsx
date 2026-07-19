import { Text } from 'ink';
import type { FC } from 'react';
import { useMessages } from './i18n-context';
import { theme } from './theme';

/**
 * The merge/discard confirm line — `<prompt> Proceed? y / n [busy]`. Just the text
 * row (no frame); the caller wraps it in a DialogBox. Shared by the list (its own
 * confirm box) and the detail view (inside its actions panel) so the two never
 * drift in wording or color.
 */
export const ConfirmPrompt: FC<{ kind: 'merge' | 'discard'; busy: boolean }> = ({ kind, busy }) => {
  const m = useMessages();
  return (
    <Text>
      {kind === 'merge' ? m.action.mergePrompt : m.action.discardPrompt} {m.action.confirmRun}{' '}
      <Text color={theme.yes}>y</Text> / <Text color={theme.no}>n</Text>
      {busy ? <Text dimColor> {m.action.busySuffix}</Text> : null}
    </Text>
  );
};
