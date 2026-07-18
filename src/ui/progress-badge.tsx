import { Text } from 'ink';
import type { FC } from 'react';
import type { SessionState } from '@/core';

type Color = 'gray' | 'cyan' | 'yellow' | 'magenta' | 'green' | 'red';

export function badgeFor(state: SessionState): { label: string; color: Color } {
  switch (state.status) {
    case 'creating':
      return { label: '準備中', color: 'gray' };
    case 'running':
      return state.progress
        ? { label: `Step ${state.progress.done}/${state.progress.total}`, color: 'cyan' }
        : { label: '実行中', color: 'cyan' };
    case 'awaiting_permission':
      return { label: '許可待ち', color: 'yellow' };
    case 'awaiting_input':
      return { label: '質問あり', color: 'magenta' };
    case 'completed':
      return { label: '完了', color: 'green' };
    case 'failed':
      return { label: '失敗', color: 'red' };
    case 'archived':
      return { label: '保管済み', color: 'gray' };
    default:
      return { label: state.status, color: 'gray' };
  }
}

export const ProgressBadge: FC<{ state: SessionState }> = ({ state }) => {
  const { label, color } = badgeFor(state);
  return (
    <Text color={color} bold>
      {label}
    </Text>
  );
};
