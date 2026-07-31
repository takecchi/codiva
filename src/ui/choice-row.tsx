import { Box, Text } from 'ink';
import type { FC } from 'react';
import { choiceLines } from '@/core';
import { theme } from './theme';

/**
 * 選択リスト（AskUserQuestion の選択肢 / `/model` のモデル行）の 1 件。
 * ラベルを 1 行目に、説明をその下に**折返して全文**描く。
 *
 * ラベルと説明を横に並べない（= 同じ Box に 2 つの `<Text>` を置かない）のが要点。
 * 横に並べると Yoga が両方を縮めるため、長いラベルも長い説明も途中で切れて読めなく
 * なる。折返し位置の計算は純粋な `choiceLines` に委譲し、ここは色分けだけを担う。
 */
export const ChoiceRow: FC<{
  /** 1 行目の行頭（`❯ `, `❯ [x] ` 等）。継続行はこの表示幅ぶん字下げされる。 */
  prefix: string;
  label: string;
  description?: string;
  /** カーソル行（アクセント色で描く） */
  active?: boolean;
  /** 折返し幅（セル）。`dialogContentWidth(columns)` を渡す。 */
  width: number;
}> = ({ prefix, label, description, active = false, width }) => (
  <Box flexDirection="column" flexShrink={0}>
    {choiceLines({ label, description }, width, prefix).map((line) => (
      <Text
        key={line.key}
        color={!line.description && active ? theme.accent : undefined}
        dimColor={line.description}
      >
        {/* Ink の measureText('') は高さ 0 を返すので、空行は空白 1 つで高さを確保する。 */}
        {line.text.length > 0 ? line.text : ' '}
      </Text>
    ))}
  </Box>
);
