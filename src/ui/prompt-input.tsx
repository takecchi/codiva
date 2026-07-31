import { Box, type DOMElement, Text, useCursor } from 'ink';
import { type FC, useRef } from 'react';
import stringWidth from 'string-width';
import {
  composerLayout,
  INPUT_MAX_ROWS,
  isEmptyBuffer,
  rowSelection,
  type SelectionRange,
  type TextBuffer,
  visibleLineRange,
} from '@/core';
import { useAbsolutePosition, useComposerWidth } from './hooks';
import { glyph, theme } from './theme';

/**
 * Column (0-based, in terminal cells) of the caret within a row: the 2-cell
 * `❯ `／`  ` prefix plus the display width of the text before the caret on that
 * line. CJK/絵文字は2セル幅なので string-width で数える（.length だと日本語入力で
 * カーソルと IME preedit の位置がズレる）。Glyph-coupled, so it lives with the
 * component that draws the caret rather than in a pure core module.
 */
function promptCaretColumn(textBeforeCaret: string): number {
  return stringWidth(`${glyph.caret} ${textBeforeCaret}`);
}

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

/** Render one line with the `[from, to)` char range highlighted (mouse selection). */
const SelectionLine: FC<{ line: string; from: number; to: number }> = ({ line, from, to }) => (
  <Text wrap="truncate-end">
    {line.slice(0, from)}
    <Text inverse>{line.slice(from, to)}</Text>
    {line.slice(to)}
  </Text>
);

/**
 * Claude-Code-style composer: a full-width horizontal rule above and below the
 * input (no side borders). Purely presentational — key handling lives in the
 * owning view (a single useInput per screen). Multi-line aware: the box grows with
 * the content up to `maxRows` display rows, then scrolls internally to keep the
 * caret in view (`visibleLineRange`). Empty/single-line input stays one row tall.
 *
 * Text longer than the input is **soft-wrapped** onto the next display row rather
 * than truncated: with `wrap="truncate-end"` alone, typing past the right edge hid
 * both the text and the caret behind a `…`. The wrap geometry is computed by the
 * pure `composerLayout` from the box's measured width, which is also what the
 * owning views hit-test clicks against — one geometry, no drift.
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
  /** Highlighted mouse-selection range (for copy). Suppresses the block caret. */
  selection?: SelectionRange;
}> = ({ buffer, focused, placeholder = '', maxRows = INPUT_MAX_ROWS, selection }) => {
  const boxRef = useRef<DOMElement>(null);
  const box = useAbsolutePosition(boxRef);
  // 折り返し幅は実測（ダイアログ内では端末幅と一致しないため）。初回描画までは
  // undefined = 折り返さない（1フレームだけ従来通り truncate される）。
  const width = useComposerWidth(boxRef);
  const { setCursorPosition } = useCursor();

  const { rows, caret } = composerLayout(buffer, width);
  const { row, col } = caret;
  const { start, end } = visibleLineRange(rows.length, row, maxRows);

  if (focused && box) {
    // y: 上ボーダー1行 + 表示ウィンドウ内でのキャレット行。x: プレフィックス
    // 2セル + キャレット手前のテキストの表示幅（空バッファは行 '' で列2になる）。
    setCursorPosition({
      x: box.left + promptCaretColumn((rows[row]?.text ?? '').slice(0, col)),
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
    // 幅は必ず「使える幅いっぱい」に固定する。row 方向の親（`PermissionDialog` の
    // 一行 Box など）に置かれると Box の幅は**中身の幅**になり、それを測って
    // 折り返すと「折り返す→中身が細くなる→さらに折り返す」の自己参照になる。
    width: '100%' as const,
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
      {rows.slice(start, end).map((r, i) => {
        const rowIndex = start + i;
        const sel = selection ? rowSelection(selection, r) : undefined;
        // While a selection is shown, suppress the block caret so the highlight
        // reads cleanly (the real terminal cursor still marks the focus end).
        const isCaretRow = focused && !selection && rowIndex === row;
        return (
          // Row index is a stable key within a single render's window.
          <Box key={rowIndex}>
            <Text color={theme.accent}>{i === 0 ? `${glyph.caret} ` : '  '}</Text>
            {sel ? (
              <SelectionLine line={r.text} from={sel.from} to={sel.to} />
            ) : isCaretRow ? (
              <CaretLine line={r.text} col={col} />
            ) : (
              // 幅は composerLayout が合わせているので truncate は保険（未実測の1フレーム）。
              <Text wrap="truncate-end">{r.text}</Text>
            )}
          </Box>
        );
      })}
    </Box>
  );
};
