import { Box, Text, useInput } from 'ink';
import { type FC, useState } from 'react';
import type { SessionManager } from '@/core';
import { useClock, useSessions } from './hooks';
import { editBuffer, formatElapsed } from './input';
import { ProgressBadge } from './progress-badge';
import { PromptInput } from './prompt-input';

export const SessionList: FC<{
  manager: SessionManager;
  onOpen: (id: string) => void;
  onQuit: () => void;
}> = ({ manager, onOpen, onQuit }) => {
  const sessions = useSessions(manager);
  const now = useClock(1000);
  const [buffer, setBuffer] = useState('');
  const [sel, setSel] = useState(0);
  // Archived sessions sink to the bottom; Array.sort is stable so the rest keep
  // their creation order.
  const sorted = [...sessions].sort(
    (a, b) => (a.status === 'archived' ? 1 : 0) - (b.status === 'archived' ? 1 : 0),
  );
  const selected = Math.min(sel, Math.max(0, sorted.length - 1));

  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      onQuit();
      return;
    }
    if (key.upArrow) {
      setSel((s) => Math.max(0, s - 1));
      return;
    }
    if (key.downArrow) {
      setSel((s) => Math.min(sorted.length - 1, s + 1));
      return;
    }
    if (key.rightArrow || (key.return && buffer.trim() === '')) {
      const target = sorted[selected];
      if (target) {
        onOpen(target.id);
      }
      return;
    }
    if (key.return) {
      const prompt = buffer.trim();
      if (prompt) {
        manager.create(prompt);
        setBuffer('');
      }
      return;
    }
    const edit = editBuffer(buffer, input, key);
    if (edit.changed) {
      setBuffer(edit.value);
    }
  });

  return (
    <Box flexDirection="column" padding={1}>
      <Box marginBottom={1}>
        <Text bold color="cyan">
          codiva{' '}
        </Text>
        <Text dimColor>
          {sessions.length} session{sessions.length === 1 ? '' : 's'}
        </Text>
      </Box>

      {sorted.length === 0 ? (
        <Box marginBottom={1}>
          <Text dimColor>指示を入力して Enter を押すと最初のセッションが始まります。</Text>
        </Box>
      ) : (
        <Box flexDirection="column" marginBottom={1}>
          {sorted.map((s, i) => {
            const attention = s.status === 'awaiting_input' || s.status === 'awaiting_permission';
            const archived = s.status === 'archived';
            return (
              <Box key={s.id}>
                <Text color={i === selected ? 'cyan' : undefined}>
                  {i === selected ? '❯ ' : '  '}
                </Text>
                <Box width={2}>
                  <Text color={s.status === 'awaiting_input' ? 'magenta' : 'yellow'}>
                    {attention ? '●' : ' '}
                  </Text>
                </Box>
                <Box width={30}>
                  <Text bold={i === selected || attention} dimColor={archived} wrap="truncate-end">
                    {s.title}
                  </Text>
                </Box>
                <Box width={12}>
                  <ProgressBadge state={s} />
                </Box>
                <Box width={22}>
                  <Text dimColor wrap="truncate-end">
                    {s.branch}
                  </Text>
                </Box>
                <Text dimColor>{formatElapsed(s.startedAt, s.finishedAt ?? now)}</Text>
              </Box>
            );
          })}
        </Box>
      )}

      <PromptInput value={buffer} focused placeholder="実装してほしいことを入力…" />

      <Box marginTop={1}>
        <Text dimColor>Enter: 投入 ・ ↑↓: 選択 ・ →: 詳細 ・ Ctrl+C: 終了</Text>
      </Box>
    </Box>
  );
};
