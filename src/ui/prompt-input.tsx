import { Box, type DOMElement, Text, useCursor } from 'ink';
import { type FC, useRef } from 'react';
import {
  bufferLines,
  cursorRowCol,
  INPUT_MAX_ROWS,
  isEmptyBuffer,
  type TextBuffer,
  visibleLineRange,
} from '@/core';
import { useAbsolutePosition } from './hooks';
import { promptCaretColumn } from './input';
import { glyph, theme } from './theme';

/** Render one line with a block caret drawn at `col` (inverse cell). Reads a full
 *  code point so an astral char under the caret isn't split into a lone surrogate. */
const CaretLine: FC<{ line: string; col: number }> = ({ line, col }) => {
  const cp = line.codePointAt(col);
  const ch = cp === undefined ? ' ' : String.fromCodePoint(cp);
  return (
    <Text wrap="truncate-end">
      {line.slice(0, col)}
      <Text inverse>{ch}</Text>
      {line.slice(col + ch.length)}
    </Text>
  );
};

/**
 * Claude-Code-style composer: a full-width horizontal rule above and below the
 * input (no side borders). Purely presentational — key handling lives in the
 * owning view (a single useInput per screen). Multi-line aware: the box grows with
 * the content up to `maxRows` lines, then scrolls internally to keep the caret in
 * view (`visibleLineRange`). Empty/single-line input stays exactly one row tall.
 *
 * The real terminal cursor is anchored on the caret cell while focused. IME の
 * 未確定文字列（日本語変換中のプレビュー）は端末がカーソル位置に描画するため、
 * カーソルを隠したままだと変換中の文字がどこにも見えず「日本語が打てない」状態
 * になる。フォーカスが外れたら明示的に隠す（モーダル表示中など）。
 */
export const PromptInput: FC<{
  buffer: TextBuffer;
  focused: boolean;
  placeholder?: string;
  maxRows?: number;
}> = ({ buffer, focused, placeholder = '', maxRows = INPUT_MAX_ROWS }) => {
  const boxRef = useRef<DOMElement>(null);
  const box = useAbsolutePosition(boxRef);
  const { setCursorPosition } = useCursor();

  const lines = bufferLines(buffer.value);
  const { row, col } = cursorRowCol(buffer);
  const { start, end } = visibleLineRange(lines.length, row, maxRows);

  if (focused && box) {
    // y: 上ボーダー1行 + 表示ウィンドウ内でのキャレット行。x: プレフィックス
    // 2セル + キャレット手前のテキストの表示幅（空バッファは行 '' で列2になる）。
    setCursorPosition({
      x: box.left + promptCaretColumn((lines[row] ?? '').slice(0, col)),
      y: box.top + 1 + (row - start),
    });
  } else {
    setCursorPosition(undefined);
  }

  const frame = {
    borderStyle: 'single' as const,
    borderColor: theme.dim,
    borderTop: true,
    borderBottom: true,
    borderLeft: false,
    borderRight: false,
  };

  if (isEmptyBuffer(buffer)) {
    return (
      <Box ref={boxRef} {...frame}>
        <Text color={theme.accent}>{glyph.caret} </Text>
        <Text>
          {focused ? <Text inverse> </Text> : null}
          <Text dimColor>{placeholder}</Text>
        </Text>
      </Box>
    );
  }

  return (
    <Box ref={boxRef} {...frame} flexDirection="column">
      {lines.slice(start, end).map((line, i) => {
        const lineIndex = start + i;
        const isCaretLine = focused && lineIndex === row;
        return (
          // Line index is a stable key within a single render's window.
          <Box key={lineIndex}>
            <Text color={theme.accent}>{i === 0 ? `${glyph.caret} ` : '  '}</Text>
            {isCaretLine ? (
              <CaretLine line={line} col={col} />
            ) : (
              <Text wrap="truncate-end">{line}</Text>
            )}
          </Box>
        );
      })}
    </Box>
  );
};
