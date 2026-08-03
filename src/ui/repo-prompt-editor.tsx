import { Box, type DOMElement, Text, useInput } from 'ink';
import { type FC, useRef } from 'react';
import {
  bufferOf,
  COMPOSER_PREFIX_CELLS,
  caretIndexAtClick,
  composerRowCount,
  INPUT_MAX_ROWS,
  parseSgrMouse,
} from '@/core';
import { DialogBox } from './dialog-box';
import {
  useAbsolutePosition,
  useBoxHeight,
  useComposerWidth,
  useDragSelection,
  useTextBufferRef,
} from './hooks';
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
 *
 * Mouse drag selects a range and copies it on release, exactly like the composers
 * (`useDragSelection`) — the editor doubles as the viewer for `.codiva/prompt.md`,
 * so reading the saved instructions and copying a line out of them is the same
 * operation as in the input box. A plain click (press+release, no drag) just moves
 * the caret. SessionList swallows mouse reports while this is open so a drag in here
 * doesn't also move the list selection underneath.
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
  const { buffer, bufferRef, updateBuffer } = useTextBufferRef(bufferOf(initial ?? ''));
  // 折り返し幅と左上位置（実測）。ダイアログ内なので端末幅からは求まらない。位置は
  // マウス座標 → キャレット index の逆算に使う（描画と同じ幅・同じ関数を通す）。
  const editorRef = useRef<DOMElement>(null);
  const wrapWidth = useComposerWidth(editorRef);
  const editorBox = useAbsolutePosition(editorRef);
  const editorHeight = useBoxHeight(editorRef);
  const sel = useDragSelection(onCopy);
  // 押した位置（キャレットを置く候補）。ドラッグにならずに離したときだけ使う。
  const pressedRef = useRef<number | undefined>(undefined);
  // 最後にドラッグで拾った位置。press と違えばドラッグ、同じなら単なるクリック。
  const focusedRef = useRef<number | undefined>(undefined);

  // 実際に描かれる行数（内部スクロールの窓 + 上下の罫線）。実測高さがこれより小さい
  // = ダイアログが縦に潰されて行が抜けている状態なので、当たり判定そのものをやめる
  // （黙って別の行の文字を選ぶより選べないほうがよい。ヘッダと同じ方針）。
  const drawnRows = Math.min(composerRowCount(buffer.value, wrapWidth), INPUT_MAX_ROWS) + 2;

  /**
   * Caret index for a mouse point inside the editor, or undefined when outside (or
   * when the geometry can't be trusted yet). `+ 1` skips the top border rule; the
   * prefix width drops the `❯ ` glyph so `x` becomes the display column in the text.
   */
  const caretAt = (x: number, y: number): number | undefined =>
    editorBox === undefined || (editorHeight !== undefined && editorHeight < drawnRows)
      ? undefined
      : caretIndexAtClick(
          bufferRef.current,
          y - (editorBox.top + 1),
          x - editorBox.left - COMPOSER_PREFIX_CELLS,
          INPUT_MAX_ROWS,
          wrapWidth,
        );

  useInput((rawInput, rawKey) => {
    // SGR マウスレポートはキー入力より先に解釈する（エスケープ列が生テキストとして
    // バッファへ混入しないように）。press → drag → release で範囲選択し、離した
    // 時点で 1 回だけコピーする（ドラッグごとには送らない）。
    const mouse = parseSgrMouse(rawInput);
    if (mouse) {
      if (mouse.kind === 'press') {
        const index = caretAt(mouse.x, mouse.y);
        pressedRef.current = index;
        focusedRef.current = index;
        if (index === undefined) {
          sel.clear();
          return;
        }
        sel.begin(index);
      } else if (mouse.kind === 'drag') {
        if (!sel.dragging()) {
          return;
        }
        const index = caretAt(mouse.x, mouse.y);
        if (index !== undefined) {
          focusedRef.current = index;
          sel.extend(index);
        }
      } else if (mouse.kind === 'release') {
        sel.end(bufferRef.current.value);
        // **選択中はキャレットを動かさない。** 表示ウィンドウ（`visibleLineRange`）は
        // キャレット行から決まるので、押した/ドラッグした時点で動かすと 8 行を超える
        // 指示文では画面がその場でスクロールし、描かれている行と当たり判定が食い違って
        // 「触っていない行」がコピーされる。キャレットを置くのはドラッグにならずに
        // 離したとき（= 単なるクリック）だけにする。
        const pressed = pressedRef.current;
        if (pressed !== undefined && focusedRef.current === pressed) {
          updateBuffer(bufferOf(bufferRef.current.value, pressed));
        }
        pressedRef.current = undefined;
        focusedRef.current = undefined;
      }
      return;
    }
    const { input, key } = normalizeChord(rawInput, rawKey);
    // 何かキーが来たらハイライトは消す（タイピング / キャレット移動で解除）。
    sel.clear();
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
        <PromptInput
          buffer={buffer}
          focused
          placeholder={m.prompt.placeholder}
          selection={sel.selection}
        />
      </Box>
      <Box marginTop={1}>
        <Text dimColor>{m.prompt.help}</Text>
      </Box>
    </DialogBox>
  );
};
