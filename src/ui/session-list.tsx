import { Box, Text, useInput } from 'ink';
import { type FC, useState } from 'react';
import type { SessionManager } from '@/core';
import { Banner } from './banner';
import { useClock, useRunMode, useSessions } from './hooks';
import { useMessages } from './i18n-context';
import { editBuffer, formatElapsed } from './input';
import { ProgressBadge } from './progress-badge';
import { PromptInput } from './prompt-input';
import { StatusFooter } from './status-footer';
import { glyph, theme } from './theme';

export const SessionList: FC<{
  manager: SessionManager;
  onOpen: (id: string) => void;
  onQuit: () => void;
  cwd?: string;
}> = ({ manager, onOpen, onQuit, cwd }) => {
  const m = useMessages();
  const sessions = useSessions(manager);
  const mode = useRunMode(manager);
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
    if (key.tab && key.shift) {
      manager.cycleMode();
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
      <Banner cwd={cwd} sessionCount={sessions.length} />

      <Box flexDirection="column" marginY={1}>
        {sorted.length === 0 ? (
          <Text dimColor>{m.list.emptyHint}</Text>
        ) : (
          sorted.map((s, i) => {
            const attention = s.status === 'awaiting_input' || s.status === 'awaiting_permission';
            const archived = s.status === 'archived';
            const isSel = i === selected;
            return (
              <Box key={s.id}>
                <Text color={isSel ? theme.accent : undefined}>
                  {isSel ? `${glyph.caret} ` : '  '}
                </Text>
                <Box width={2}>
                  <Text color={s.status === 'awaiting_input' ? 'magenta' : 'yellow'}>
                    {attention ? glyph.attention : ' '}
                  </Text>
                </Box>
                <Box width={30}>
                  <Text bold={isSel || attention} dimColor={archived} wrap="truncate-end">
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
          })
        )}
      </Box>

      <PromptInput value={buffer} focused placeholder={m.list.promptPlaceholder} />
      <StatusFooter mode={mode} hint={m.list.help} />
    </Box>
  );
};
