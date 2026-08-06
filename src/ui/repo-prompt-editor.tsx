import { Box, Text, useInput } from 'ink';
import type { FC } from 'react';
import { bufferOf, parseSgrMouse } from '@/core';
import { Composer, useComposer } from './composer';
import { DialogBox } from './dialog-box';
import { useMessages } from './i18n-context';
import { normalizeChord } from './input';
import { theme } from './theme';

/**
 * Multi-line editor for the repository instructions (`.codiva/prompt.md`), shown in
 * place of the composer when the user runs `/prompt`. Seeded with the current
 * prompt so it doubles as a viewer. Enter saves (submits), Shift+Enter (or a
 * trailing backslash) inserts a newline, Esc cancels — the same chord model as the
 * composers, because it *is* the same composer: the shared `useComposer` owns the
 * buffer, the wrap geometry, the mouse hit-testing and the key mapping. Saving
 * empty clears it.
 *
 * This owns the active key handler while open (SessionList's own useInput yields to
 * it, like it does for ModelSelect). Because the composer is unmounted while this is
 * shown, it is the only PromptInput on screen, so its `useCursor` (IME caret) is
 * unambiguous — see .claude/rules/ink-components.md.
 *
 * Mouse drag selects a range and copies it on release, exactly like the composers —
 * the editor doubles as the viewer for `.codiva/prompt.md`, so reading the saved
 * instructions and copying a line out of them is the same operation as in the input
 * box. A plain click (press+release, no drag) just moves the caret. SessionList
 * swallows mouse reports while this is open so a drag in here doesn't also move the
 * list selection underneath.
 */
export const RepoPromptEditor: FC<{
  /** Current repo prompt (undefined → none); the editor opens on it. */
  initial: string | undefined;
  /** Called with the edited text on Enter (empty string clears the prompt). */
  onSave: (text: string) => void;
  onCancel: () => void;
  /** Clipboard sink for a mouse selection (OSC 52), injected from the root. */
  onCopy?: (text: string) => void;
}> = ({ initial, onSave, onCancel, onCopy }) => {
  const m = useMessages();
  const composer = useComposer({ initial: bufferOf(initial ?? ''), onCopy });

  useInput((rawInput, rawKey) => {
    // SGR マウスレポートはキー入力より先に解釈する（エスケープ列が生テキストとして
    // バッファへ混入しないように）。press → drag → release で範囲選択し、離した
    // 時点で 1 回だけコピーする（ドラッグごとには送らない）。
    const mouse = parseSgrMouse(rawInput);
    if (mouse) {
      composer.handleMouse(mouse);
      return;
    }
    const { input, key } = normalizeChord(rawInput, rawKey);
    // 何かキーが来たらハイライトは消す（タイピング / キャレット移動で解除）。
    composer.clearSelection();
    if (key.escape) {
      onCancel();
      return;
    }
    // Enter は保存（改行は Shift+Enter / 末尾バックスラッシュ）。↑↓ は他のコンポーザと
    // 同じく折り返し後の表示行で動く — ここは行を選ぶ一覧ではなく文書エディタなので、
    // 矢印はすべてキャレット移動に使ってよい。
    const result = composer.handleKey(input, key);
    if (result.kind === 'submit') {
      onSave(result.text);
    }
  });

  return (
    <DialogBox flexDirection="column">
      <Text color={theme.accent} bold>
        {m.prompt.title}
      </Text>
      <Box marginTop={1} flexDirection="column">
        <Composer composer={composer} focused placeholder={m.prompt.placeholder} />
      </Box>
      <Box marginTop={1}>
        <Text dimColor>{m.prompt.help}</Text>
      </Box>
    </DialogBox>
  );
};
