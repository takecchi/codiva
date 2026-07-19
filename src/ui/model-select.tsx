import { Box, Text, useInput } from 'ink';
import { type FC, useState } from 'react';
import { MODELS } from '@/core';
import { useMessages } from './i18n-context';
import { glyph, theme } from './theme';

/**
 * Model picker shown in place of the composer when the user runs `/model`.
 * Single-select list (mirrors PermissionDialog's QuestionDialog): ↑↓ move,
 * Enter confirms, Esc cancels. The pick becomes the default for new sessions.
 * This owns the active key handler while it's open (the SessionList's own
 * useInput yields to it, like it does for a pending permission dialog).
 */
export const ModelSelect: FC<{
  /** Currently active model (undefined → CLI default); marked with a check. */
  current: string | undefined;
  onSelect: (model: string | undefined) => void;
  onCancel: () => void;
}> = ({ current, onSelect, onCancel }) => {
  const m = useMessages();
  // Start the cursor on the active model so Enter without moving is a no-op.
  const currentIndex = MODELS.findIndex((c) => c.model === current);
  const [cursor, setCursor] = useState(currentIndex < 0 ? 0 : currentIndex);

  useInput((_input, key) => {
    if (key.upArrow) {
      setCursor((c) => Math.max(0, c - 1));
      return;
    }
    if (key.downArrow) {
      setCursor((c) => Math.min(MODELS.length - 1, c + 1));
      return;
    }
    if (key.escape) {
      onCancel();
      return;
    }
    if (key.return) {
      const choice = MODELS[cursor];
      if (choice) {
        onSelect(choice.model);
      }
    }
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={1}>
      <Text color={theme.accent} bold>
        {m.model.title}
      </Text>
      <Box flexDirection="column" marginTop={1}>
        {MODELS.map((choice, i) => {
          const active = i === cursor;
          const isCurrent = choice.model === current;
          const name = m.model.names[choice.id];
          const label = choice.id === 'default' ? `${name} (${m.model.recommended})` : name;
          return (
            <Box key={choice.id}>
              <Text color={active ? 'cyan' : undefined}>
                {active ? glyph.caret : ' '} {label}
                {isCurrent ? ' ✔' : ''}
              </Text>
              <Text dimColor> — {m.model.descriptions[choice.id]}</Text>
            </Box>
          );
        })}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>{m.model.help}</Text>
      </Box>
    </Box>
  );
};
