import { Box, Text } from 'ink';
import type { FC } from 'react';
import type { RunMode } from '@/core';
import { useMessages } from './i18n-context';
import { glyph, theme } from './theme';

/**
 * The mode + hint line under the input, echoing Claude Code's
 * "⏵⏵ auto mode on (shift+tab to cycle)" footer. `mode` is the live tool-approval
 * mode (toggled with shift+tab); `hint` is the screen's context text (already
 * localized by the caller). Mode labels come from the message catalog.
 *
 * プラン / 使用状況は**ヘッダ（`Banner`）の担当**でここには出さない。1行のフッタに
 * 詰め込むと幅ごとの縮退（枠を減らす → ゲージを落とす → …）が必要になり、モードと
 * ヒントというフッタ本来の情報が読みづらくなっていた。
 *
 * **The footer is exactly one line at any width.** モード表示は縮まず（ツールが
 * 自動実行かどうかは常に読めるべき）、ヒントだけが末尾で切り詰められる。
 */
export const StatusFooter: FC<{
  mode: RunMode;
  hint?: string;
}> = ({ mode, hint }) => {
  const m = useMessages();
  const auto = mode === 'auto';
  return (
    <Box marginLeft={2}>
      {/* モード表示は縮まない（ツールが自動実行かどうかは常に読めるべき）。 */}
      <Box flexShrink={0}>
        <Text color={auto ? theme.auto : theme.confirm} bold>
          {auto ? glyph.auto : glyph.confirm} {auto ? m.footer.autoMode : m.footer.confirmMode}
        </Text>
      </Box>
      {/* ヒントだけが縮む枠（溢れは末尾で切り詰め、折り返さない）。 */}
      <Box flexGrow={0} flexShrink={1} overflowX="hidden">
        <Text dimColor wrap="truncate-end">
          {' '}
          {m.footer.cycleHint}
          {hint ? ` ${glyph.dot} ${hint}` : ''}
        </Text>
      </Box>
    </Box>
  );
};
