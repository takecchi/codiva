import { Box, type DOMElement, Text } from 'ink';
import type { FC, RefObject } from 'react';
import {
  type BannerLine,
  type BannerTone,
  bannerLineText,
  bannerText,
  lineSelection,
  type SelectionRange,
} from '@/core';
import { palette, statusColor } from './theme';

// codiva mascot. Each glyph is rendered in its own <Text>, so you can paint it
// one character at a time via paint() below.
const LOGO = [
  ' ▄▄ ▄▄▄▄▄▄▄ ▄▄',
  ' █████████████',
  '██▀██▀███▀██▀██',
  '██ █ █ ▀ █ █ ██',
  '██ █       █ ██',
  '▀   ▀▀▀▀▀▀▀   ▀',
];

/**
 * Per-character painter — return an Ink color (named / '#hex' / 'rgb(r,g,b)') for
 * the glyph at (row, col), or undefined for the terminal default. Paint however
 * you like; the example below shades by glyph and tints the two eyes:
 *   - by position (a single cell): `if (row === 3 && col === 5) return 'cyan'`
 *   - by glyph/shade: switch on `ch` ('█' darkest → '▒' lightest)
 *   - by line: switch on `row`
 */
// One-off eye glint — a lighter aqua tint used nowhere else, so it stays local
// rather than expanding the brand palette.
const GLINT = '#c3e5e7';

function paint(row: number, col: number): string | undefined {
  if (col === 0 || col === 1 || col === 13 || col === 14) return palette.aqua;
  if (row === 1 && (col === 5 || col === 7)) return GLINT;
  if (row === 0 && (col === 2 || col === 12)) return palette.ink;
  if (row === 1 && (col === 2 || col === 12)) return palette.pink;
  if (row === 2 && (col === 2 || col === 12)) return palette.ink;
  if (row === 3 && (col === 5 || col === 9)) return palette.teal;
  if (row === 4 && (col === 3 || col === 11)) return palette.teal;
  if (row === 5 && 4 <= col && col <= 10) return palette.teal;
  return palette.aqua;
}

// Precompute cells with stable keys (so JSX keys aren't raw array indices).
const LOGO_ROWS = LOGO.map((line, row) => ({
  key: `logo-row-${row}`,
  cells: [...line].map((ch, col) => ({ key: `${row}:${col}`, ch, row, col })),
}));

/**
 * Map a semantic tone to Ink text props. Colors live only here (`theme.ts`) — the
 * text itself is composed by the pure `bannerLines` in core. A highlighted
 * (inverse) piece drops `dimColor` so the selection stays legible.
 */
function toneStyle(tone: BannerTone, inverse: boolean): { color?: string; dimColor?: boolean } {
  switch (tone) {
    case 'warn':
      return { color: statusColor.awaitingPermission };
    case 'error':
      return { color: statusColor.failed };
    case 'dim':
      return inverse ? {} : { dimColor: true };
    default:
      return {};
  }
}

interface RowPiece {
  key: string;
  text: string;
  tone: BannerTone;
  bold?: boolean;
  /** Part of the mouse selection → drawn as an inverse (highlighted) cell run. */
  inverse: boolean;
}

/**
 * Split one header line's segments into styled pieces, cutting each segment at the
 * selection boundaries so the highlight can span a run that crosses segments (the
 * wordmark line is several segments: bold name, dim version, dim counters).
 * `sel` offsets are char indices within this line (see `lineSelection`).
 */
function rowPieces(line: BannerLine, sel?: { from: number; to: number }): RowPiece[] {
  const pieces: RowPiece[] = [];
  let offset = 0;
  for (const [i, seg] of line.segments.entries()) {
    const start = offset;
    offset += seg.text.length;
    const from = sel ? Math.max(0, Math.min(seg.text.length, sel.from - start)) : 0;
    const to = sel ? Math.max(0, Math.min(seg.text.length, sel.to - start)) : 0;
    const slices: [string, boolean][] =
      to > from
        ? [
            [seg.text.slice(0, from), false],
            [seg.text.slice(from, to), true],
            [seg.text.slice(to), false],
          ]
        : [[seg.text, false]];
    for (const [text, inverse] of slices) {
      if (text.length > 0) {
        pieces.push({
          key: `${i}:${pieces.length}`,
          text,
          inverse,
          tone: seg.tone,
          bold: seg.bold,
        });
      }
    }
  }
  return pieces;
}

/**
 * One header row. `wrap="truncate-end"` is required, not cosmetic: mouse
 * hit-testing maps a terminal row straight to a line index (`bannerCaretAt`), so a
 * line that soft-wrapped into two rows would shift every line below it.
 */
const BannerRow: FC<{ line: BannerLine; sel?: { from: number; to: number } }> = ({ line, sel }) => {
  const pieces = rowPieces(line, sel);
  if (pieces.length === 0) {
    // 空行（使用状況節の前のスペーサ）。高さ 1 を保つためスペースを 1 つ描く。
    return <Text> </Text>;
  }
  return (
    <Text wrap="truncate-end">
      {pieces.map((p) => (
        <Text key={p.key} bold={p.bold} inverse={p.inverse} {...toneStyle(p.tone, p.inverse)}>
          {p.text}
        </Text>
      ))}
    </Text>
  );
};

/**
 * Borderless startup header echoing Claude Code's banner: the mascot on the left
 * and identity / subtitle / model / cwd on the right (vertically centered against
 * it). Purely presentational — the text is composed by `bannerLines` in core, and
 * the owning view supplies the mouse selection (drag to copy the repo path).
 */
export const Banner: FC<{
  /** 表示行（`bannerLines`）。1 要素 = 1 表示行。 */
  lines: readonly BannerLine[];
  /** Highlighted mouse-selection range over `bannerText(lines)`. */
  selection?: SelectionRange;
  /**
   * テキスト欄の左上を実測するための ref。マウス座標 → 文字位置の逆算に使うので、
   * **行だけを包む内側の Box** に付ける（中央寄せの外側 Box だと centering のぶん
   * ずれて、クリック位置が 1〜2 行手前の行に当たる）。
   */
  textRef?: RefObject<DOMElement | null>;
}> = ({ lines, selection, textRef }) => {
  const value = selection ? bannerText(lines) : undefined;
  const rows = lines.map((line, row) => ({
    key: `banner-line-${row}-${bannerLineText(line).slice(0, 8)}`,
    line,
    sel: value !== undefined && selection ? lineSelection(value, selection, row) : undefined,
  }));
  return (
    // ここで flexShrink を止めないこと: 低い端末ではヘッダも縮んで場所を譲る（コマンド
    // パレット等の下段 UI が潰れる）。**行 Box も縮ませる**のが重要で、内側だけ
    // flexShrink={0} にすると中央寄せ（justifyContent="center"）が負のオフセットを返し、
    // ヘッダのテキストが一覧の先頭行に重なって描かれてしまう。潰れたときは末尾の行が
    // クリップされるだけなので「行 index = 表示行」は可視域では保たれる。重なりが
    // 起きた場合の当たり判定の優先順位は SessionList 側（一覧の行を優先）で決める。
    <Box>
      <Box flexDirection="column" marginRight={2}>
        {LOGO_ROWS.map((r) => (
          <Text key={r.key}>
            {r.cells.map((c) => (
              <Text key={c.key} color={paint(c.row, c.col)}>
                {c.ch}
              </Text>
            ))}
          </Text>
        ))}
      </Box>
      <Box flexDirection="column" justifyContent="center">
        <Box ref={textRef} flexDirection="column">
          {rows.map((r) => (
            <BannerRow key={r.key} line={r.line} sel={r.sel} />
          ))}
        </Box>
      </Box>
    </Box>
  );
};
