import { Box, type DOMElement, Text, useCursor } from 'ink';
import { type FC, useRef } from 'react';
import { useAbsolutePosition } from './hooks';
import { promptCaretColumn } from './input';
import { glyph, theme } from './theme';

/**
 * Claude-Code-style input: a full-width horizontal rule above and below a single
 * `❯` prompt line (no side borders / corners). Purely presentational — key
 * handling lives in the owning view (a single useInput per screen); this just
 * renders the buffer and a block caret.
 *
 * The real terminal cursor is anchored on the caret cell while focused. IME の
 * 未確定文字列（日本語変換中のプレビュー）は端末がカーソル位置に描画するため、
 * カーソルを隠したままだと変換中の文字がどこにも見えず「日本語が打てない」状態
 * になる。フォーカスが外れたら明示的に隠す（モーダル表示中など）。
 */
export const PromptInput: FC<{
  value: string;
  focused: boolean;
  placeholder?: string;
}> = ({ value, focused, placeholder = '' }) => {
  const boxRef = useRef<DOMElement>(null);
  const box = useAbsolutePosition(boxRef);
  const { setCursorPosition } = useCursor();
  if (focused && box) {
    // +1 行は上ボーダーぶん。列は `❯ ` + バッファの表示幅（CJK は2セル）。
    setCursorPosition({ x: box.left + promptCaretColumn(value), y: box.top + 1 });
  } else {
    setCursorPosition(undefined);
  }

  const empty = value.length === 0;
  const caret = focused ? <Text inverse> </Text> : null;
  return (
    <Box
      ref={boxRef}
      borderStyle="single"
      borderColor={theme.dim}
      borderTop
      borderBottom
      borderLeft={false}
      borderRight={false}
    >
      <Text color={theme.accent}>{glyph.caret} </Text>
      {empty ? (
        <Text>
          {caret}
          <Text dimColor>{placeholder}</Text>
        </Text>
      ) : (
        <Text>
          {value}
          {caret}
        </Text>
      )}
    </Box>
  );
};
