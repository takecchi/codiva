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
    case 'rate_limited':
      return { label: b.rateLimited, color: statusColor.rateLimited };
    case 'needs_login':
      return { label: b.needsLogin, color: statusColor.needsLogin };
    case 'failed':
      return { label: b.failed, color: statusColor.failed };
    case 'conflict':
      return { label: b.conflict, color: statusColor.conflict };
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
    // **`truncate-end` は必須**（`PrCell` と同じ理由）。一覧の列は固定幅（12 セル）で、
    // 折り返すと 1 セッションが 2 行になり「1 セッション = 1 行」を前提にした
    // `rowLineAtPoint` 以降のクリックが全部ズレる（英語の `Awaiting permission` は
    // 19 セルあるので実際に溢れる。日本語は 12 セルに収まっていたので気付けなかった）。
    <Text color={color} bold wrap="truncate-end">
      {label}
    </Text>
  );
};
