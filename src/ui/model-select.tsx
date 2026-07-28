import { Box, Text, useInput } from 'ink';
import { type FC, useState } from 'react';
import { currentModelIndex, isCurrentModel, type ModelOption, toConfigModel } from '@/core';
import { useMessages } from './i18n-context';
import { glyph, theme } from './theme';

/**
 * Model picker shown in place of the composer when the user runs `/model`.
 * Single-select list (mirrors PermissionDialog's QuestionDialog): ↑↓ move,
 * Enter confirms, Esc cancels. The pick becomes the default for new sessions.
 * This owns the active key handler while it's open (the SessionList's own
 * useInput yields to it, like it does for a pending permission dialog).
 *
 * The rows come from Claude Code's own catalog (`models`), so names, versions and
 * descriptions are never hardcoded here — see core/models.ts.
 */
export const ModelSelect: FC<{
  /** Currently active model (undefined → CLI default); marked with a check. */
  current: string | undefined;
  /**
   * Selectable models from Claude Code's catalog. `undefined` means the fetch is
   * still in flight — we show a loading line instead of a list that would shift
   * under the cursor when the real catalog lands.
   */
  models: readonly ModelOption[] | undefined;
  onSelect: (model: string | undefined) => void;
  onCancel: () => void;
}> = ({ current, models, onSelect, onCancel }) => {
  const m = useMessages();
  // The cursor is *derived* from the catalog until the user actually moves it.
  // A `useState` initializer would only run at mount, and the dialog can open
  // while the catalog is still loading (`models === undefined`) — the cursor
  // would then stay pinned to row 0 once the rows arrive, so Enter would switch
  // the user to "Default" instead of confirming their current model.
  const [moved, setMoved] = useState<number | undefined>(undefined);
  const rows = models ?? [];
  // Clamp: the catalog can arrive (or change) after the user has moved.
  const cursor =
    moved === undefined
      ? currentModelIndex(rows, current)
      : Math.min(moved, Math.max(0, rows.length - 1));

  useInput((_input, key) => {
    if (key.escape) {
      onCancel();
      return;
    }
    // While loading there is nothing to move over or confirm; Esc still cancels.
    if (rows.length === 0) {
      return;
    }
    if (key.upArrow) {
      setMoved(Math.max(0, cursor - 1));
      return;
    }
    if (key.downArrow) {
      setMoved(Math.min(rows.length - 1, cursor + 1));
      return;
    }
    if (key.return) {
      const choice = rows[cursor];
      if (choice) {
        onSelect(toConfigModel(choice.value));
      }
    }
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={1}>
      <Text color={theme.accent} bold>
        {m.model.title}
      </Text>
      <Box flexDirection="column" marginTop={1}>
        {models === undefined ? (
          <Text dimColor>{m.model.loading}</Text>
        ) : (
          rows.map((choice, i) => {
            const active = i === cursor;
            return (
              <Box key={choice.value}>
                <Text color={active ? 'cyan' : undefined}>
                  {active ? glyph.caret : ' '} {choice.displayName}
                  {isCurrentModel(choice, current) ? ' ✔' : ''}
                </Text>
                {choice.description ? <Text dimColor> — {choice.description}</Text> : null}
              </Box>
            );
          })
        )}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>{m.model.help}</Text>
      </Box>
    </Box>
  );
};
