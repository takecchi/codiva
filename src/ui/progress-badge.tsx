import { Text } from 'ink';
import type { FC } from 'react';
import type { Messages, SessionState } from '@/core';
import { useMessages } from './i18n-context';

type Color = 'gray' | 'cyan' | 'yellow' | 'magenta' | 'green' | 'red';

/** ステータス → 表示ラベル + 色。ラベルは言語カタログから引く（純関数）。 */
export function badgeFor(state: SessionState, m: Messages): { label: string; color: Color } {
  const b = m.badge;
  switch (state.status) {
    case 'creating':
      return { label: b.creating, color: 'gray' };
    case 'running':
      return state.progress
        ? { label: b.step(state.progress.done, state.progress.total), color: 'cyan' }
        : { label: b.running, color: 'cyan' };
    case 'awaiting_permission':
      return { label: b.awaitingPermission, color: 'yellow' };
    case 'awaiting_input':
      return { label: b.awaitingInput, color: 'magenta' };
    case 'completed':
      return { label: b.completed, color: 'green' };
    case 'failed':
      return { label: b.failed, color: 'red' };
    case 'archived':
      return { label: b.archived, color: 'gray' };
    default:
      return { label: state.status, color: 'gray' };
  }
}

export const ProgressBadge: FC<{ state: SessionState }> = ({ state }) => {
  const m = useMessages();
  const { label, color } = badgeFor(state, m);
  return (
    <Text color={color} bold>
      {label}
    </Text>
  );
};
