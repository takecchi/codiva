import { Text } from 'ink';
import type { FC } from 'react';
import {
  type DisplayLine,
  type LogEntry,
  type RichSpan,
  type RowSelection,
  selectionSlices,
} from '@/core';
import { glyph, logColor, markdownColor } from './theme';

/** Prefix/indent for each log kind — echoes Claude Code's transcript. Colors live in `logColor`. */
export const LOG_PREFIX: Record<LogEntry['kind'], string> = {
  assistant_text: '',
  tool_use: `${glyph.bullet} `,
  tool_result: `  ${glyph.branch} `,
  result: '',
  user: '> ',
  system: '',
  error: '✗ ',
};

/** Kinds rendered dimmed (secondary transcript lines). */
const LOG_DIM: Partial<Record<LogEntry['kind'], boolean>> = { tool_result: true };

// Styled Markdown row: assistant text is rendered to per-span styling in core
// (bold/italic/code/heading color …). Each span becomes a nested <Text>; the
// `tone` maps to a theme color, everything else is a boolean Ink text prop.
// 選択範囲はスパンの境界と一致しないので、純粋な `selectionSlices` でスパンを選択境界で
// 切り直してから描く（ヘッダの `rowPieces` と同じ仕組み）。反転する片では dim を落とす
// — 反転 + dim は読めなくなる。
const RichLogLine: FC<{ spans: RichSpan[]; sel?: RowSelection }> = ({ spans, sel }) => (
  <Text wrap="truncate-end">
    {selectionSlices(
      spans.map((s) => s.text),
      sel,
    ).map((piece) => {
      const s = spans[piece.index];
      return (
        <Text
          key={`${piece.index}:${piece.offset}`}
          color={s?.tone ? markdownColor[s.tone] : undefined}
          bold={s?.bold}
          italic={s?.italic}
          dimColor={piece.inverse ? false : s?.dim}
          underline={s?.underline}
          strikethrough={s?.strikethrough}
          inverse={piece.inverse}
        >
          {piece.text}
        </Text>
      );
    })}
  </Text>
);

/**
 * 空行を描くための最小の中身。Ink の `measureText('')` は **高さ 0** を返すため、
 * 空文字の `<Text>` は行として一切場所を取らない。ログの空行（Markdown の段落間・
 * コードブロック内の空行など）がこれに当たり、そのままだと
 *
 * 1. 段落の区切りが消えて行が詰まって見える
 * 2. スクロール計算（`core/scroll.ts` は空行も 1 物理行として数える）が確保した高さ
 *    より実際の描画が短くなり、末尾寄せ（justifyContent="flex-end"）の分だけ
 *    **可視域の上端に隙間が生まれる**（表示できる行があるのに空白のままになる）
 *
 * という不具合になる。半角スペース 1 つを描いて必ず 1 行ぶんの高さを確保する。
 */
const BLANK_ROW = ' ';

/**
 * One physical row of the detail-view log. `line.text` already carries the kind's
 * prefix / continuation indent (built by core's `logLines`); truncate is only a
 * safety net against width drift — wrapping happened in core at the exact content
 * width. Markdown-rendered rows carry `spans` and take the styled path instead.
 * 空行（`text` が空）はどちらの経路でも高さ 0 になるので BLANK_ROW で埋める。
 *
 * `sel` はマウスのドラッグ選択がこの行に掛かっている範囲（`logRowSelection` の結果）。
 * 掛かっていない行は従来どおり 1 つの `<Text>` で描く（余計な入れ子を作らない）。
 */
export const LogLine: FC<{ line: DisplayLine; sel?: RowSelection }> = ({ line, sel }) => {
  if (line.text.length === 0) {
    return <Text>{BLANK_ROW}</Text>;
  }
  if (line.spans && line.spans.length > 0) {
    return <RichLogLine spans={line.spans} sel={sel} />;
  }
  const dim = LOG_DIM[line.kind];
  if (!sel) {
    return (
      <Text color={logColor[line.kind]} dimColor={dim} wrap="truncate-end">
        {line.text}
      </Text>
    );
  }
  return (
    <Text color={logColor[line.kind]} wrap="truncate-end">
      {selectionSlices([line.text], sel).map((piece) => (
        <Text
          key={`${piece.index}:${piece.offset}`}
          inverse={piece.inverse}
          dimColor={piece.inverse ? false : dim}
        >
          {piece.text}
        </Text>
      ))}
    </Text>
  );
};
