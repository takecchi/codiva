import { Box, type DOMElement, Text, useInput } from 'ink';
import { type FC, useRef } from 'react';
import { bufferOf, parseSgrMouse } from '@/core';
import { DialogBox } from './dialog-box';
import { useComposerWidth, useTextBufferRef } from './hooks';
import { useMessages } from './i18n-context';
import { editText, normalizeChord, resolveEnter } from './input';
import { PromptInput } from './prompt-input';
import { theme } from './theme';

/**
 * Multi-line editor for the repository instructions (`.codiva/prompt.md`), shown in
 * place of the composer when the user runs `/prompt`. Seeded with the current
 * prompt so it doubles as a viewer. Enter saves (submits), Shift+Enter (or a
 * trailing backslash) inserts a newline, Esc cancels — the same chord model as the
 * composers, so the shared `input.ts` helpers drive it. Saving empty clears it.
 *
 * This owns the active key handler while open (SessionList's own useInput yields to
 * it, like it does for ModelSelect). Because the composer is unmounted while this is
 * shown, it is the only PromptInput on screen, so its `useCursor` (IME caret) is
 * unambiguous — see .claude/rules/ink-components.md.
 */
export const RepoPromptEditor: FC<{
  /** Current repo prompt (undefined → none); the editor opens on it. */
  initial: string | undefined;
  /** Called with the edited text on Enter (empty string clears the prompt). */
  onSave: (text: string) => void;
  onCancel: () => void;
}> = ({ initial, onSave, onCancel }) => {
  const m = useMessages();
  const { buffer, bufferRef, updateBuffer } = useTextBufferRef(bufferOf(initial ?? ''));
  // 折り返し幅（実測）。ダイアログ内なので端末幅からは求まらない。
  const editorRef = useRef<DOMElement>(null);
  const wrapWidth = useComposerWidth(editorRef);

  useInput((rawInput, rawKey) => {
    // Swallow SGR mouse reports first so wheel/click escape sequences never leak
    // into the buffer as text (the composer views do the same before editing).
    if (parseSgrMouse(rawInput)) {
      return;
    }
    const { input, key } = normalizeChord(rawInput, rawKey);
    if (key.escape) {
      onCancel();
      return;
    }
    if (key.return) {
      const enter = resolveEnter(bufferRef.current, key);
      if (enter.kind === 'newline') {
        updateBuffer(enter.buffer);
        return;
      }
      onSave(enter.text);
      return;
    }
    // Full caret movement (arrows + vertical) — this is a document editor, not a
    // list where arrows navigate rows. ↑↓ は折り返し後の表示行で動かす。
    const edit = editText(bufferRef.current, input, key, {
      arrows: true,
      vertical: true,
      wrapWidth,
    });
    if (edit.changed) {
      updateBuffer(edit.buffer);
    }
  });

  return (
    <DialogBox flexDirection="column">
      <Text color={theme.accent} bold>
        {m.prompt.title}
      </Text>
      <Box ref={editorRef} marginTop={1} flexDirection="column">
        <PromptInput buffer={buffer} focused placeholder={m.prompt.placeholder} />
      </Box>
      <Box marginTop={1}>
        <Text dimColor>{m.prompt.help}</Text>
      </Box>
    </DialogBox>
  );
};
