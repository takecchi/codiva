import { Text } from 'ink';
import type { FC } from 'react';
import {
  canHyperlink,
  type DisplayLine,
  type LinkPiece,
  type LogEntry,
  linkPieces,
  osc8,
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

/**
 * リンクの片を OSC 8 で包む（対応端末ではこれで Cmd/Ctrl+click がネイティブに効く）。
 * 主経路はあくまで codiva 自身がクリックを取って開く方 — 主端末の Ghostty は
 * マウス捕捉中にリンク検出を止めるので、OSC 8 だけでは開けない。
 *
 * ここ（**描画時**）で初めてエスケープを混ぜるのが要点。`DisplayLine.text` に
 * 入れると `wrapDisplayLines` がエスケープを可視幅として数えて折り返しが壊れる。
 */
function linkedText(piece: LinkPiece): string {
  return canHyperlink(piece.url) ? osc8(piece.url, piece.text) : piece.text;
}

// Styled Markdown row: assistant text is rendered to per-span styling in core
// (bold/italic/code/heading color …). Each span becomes a nested <Text>; the
// `tone` maps to a theme color, everything else is a boolean Ink text prop.
// 選択範囲とリンク範囲はどちらもスパンの境界と一致しないので、純粋な関数で 2 段に
// 切り直してから描く: まず `linkPieces`（リンク境界）、次に `selectionSlices`（選択境界）。
// 反転する片では dim を落とす — 反転 + dim は読めなくなる。
const RichLogLine: FC<{ line: DisplayLine; sel?: RowSelection }> = ({ line, sel }) => {
  const spans: readonly RichSpan[] = line.spans ?? [];
  const parts = linkPieces(
    spans.map((s) => s.text),
    line.links,
  );
  return (
    <Text wrap="truncate-end">
      {selectionSlices(
        parts.map((p) => p.text),
        sel,
      ).map((slice) => {
        const part = parts[slice.index];
        const s = part ? spans[part.index] : undefined;
        const piece: LinkPiece = { text: slice.text, index: slice.index, url: part?.url };
        return (
          <Text
            key={`${slice.index}:${slice.offset}`}
            color={s?.tone ? markdownColor[s.tone] : undefined}
            bold={s?.bold}
            italic={s?.italic}
            dimColor={slice.inverse ? false : s?.dim}
            // リンクは下線で「押せる」ことを示す（Markdown の link tone は元々下線付き）。
            underline={s?.underline || part?.url !== undefined}
            strikethrough={s?.strikethrough}
            inverse={slice.inverse}
          >
            {linkedText(piece)}
          </Text>
        );
      })}
    </Text>
  );
};

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
 *
 * ログの外でも、**常に 1 行を占めたい行**（`SessionDetail` の状態行・操作ヒント行。
 * 出し入れするとログの高さが変わってスクロールが跳ねる）はこれを描く。
 */
export const BLANK_ROW = ' ';

/**
 * One physical row of the detail-view log. `line.text` already carries the kind's
 * prefix / continuation indent (built by core's `logLines`); truncate is only a
 * safety net against width drift — wrapping happened in core at the exact content
 * width. Markdown-rendered rows carry `spans` and take the styled path instead.
 * 空行（`text` が空）はどちらの経路でも高さ 0 になるので BLANK_ROW で埋める。
 *
 * `sel` はマウスのドラッグ選択がこの行に掛かっている範囲（`logRowSelection` の結果）。
 * `line.links` はクリックできる URL の範囲（`core/url.ts`）。どちらも無い行は従来どおり
 * 1 つの `<Text>` で描く（余計な入れ子を作らない）。
 */
export const LogLine: FC<{ line: DisplayLine; sel?: RowSelection }> = ({ line, sel }) => {
  if (line.text.length === 0) {
    return <Text>{BLANK_ROW}</Text>;
  }
  if (line.spans && line.spans.length > 0) {
    return <RichLogLine line={line} sel={sel} />;
  }
  const dim = LOG_DIM[line.kind];
  if (!sel && !line.links) {
    return (
      <Text color={logColor[line.kind]} dimColor={dim} wrap="truncate-end">
        {line.text}
      </Text>
    );
  }
  const parts = linkPieces([line.text], line.links);
  return (
    <Text color={logColor[line.kind]} wrap="truncate-end">
      {selectionSlices(
        parts.map((p) => p.text),
        sel,
      ).map((slice) => {
        const url = parts[slice.index]?.url;
        return (
          <Text
            key={`${slice.index}:${slice.offset}`}
            inverse={slice.inverse}
            dimColor={slice.inverse ? false : dim}
            underline={url !== undefined}
          >
            {linkedText({ text: slice.text, index: slice.index, url })}
          </Text>
        );
      })}
    </Text>
  );
};
