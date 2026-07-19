import { Text } from 'ink';
import type { FC } from 'react';
import type { Messages, SessionState } from '@/core';
import { useMessages } from './i18n-context';
import { statusColor } from './theme';

/** ステータス → 表示ラベル + 色。ラベルは言語カタログ、色は状態色セットから引く（純関数）。 */
export function badgeFor(state: SessionState, m: Messages): { label: string; color: string } {
  const b = m.badge;
  switch (state.status) {
    case 'creating':
      return { label: b.creating, color: statusColor.creating };
    case 'running':
      return state.progress
        ? { label: b.step(state.progress.done, state.progress.total), color: statusColor.running }
        : { label: b.running, color: statusColor.running };
    case 'awaiting_permission':
      return { label: b.awaitingPermission, color: statusColor.awaitingPermission };
    case 'awaiting_input':
      return { label: b.awaitingInput, color: statusColor.awaitingInput };
    case 'completed':
      return { label: b.completed, color: statusColor.completed };
    case 'interrupted':
      return { label: b.interrupted, color: statusColor.interrupted };
    case 'failed':
      return { label: b.failed, color: statusColor.failed };
    case 'archived':
      return { label: b.archived, color: statusColor.archived };
    default:
      return { label: state.status, color: statusColor.archived };
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
