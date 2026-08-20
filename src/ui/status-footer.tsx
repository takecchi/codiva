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
 *
 * `confirmSupported={false}`（駆動中のエージェントが許可要求を上げられない =
 * `AgentCapabilities.permissions === false`）のときは、確認モードでも「非対応」と
 * 明示する。ツールは確認なしに実行されるので、`confirm mode on` をそのまま出すと
 * **待っていれば聞かれる**と読めてしまう（Codex セッションで実際にそうなっていた）。
 */
export const StatusFooter: FC<{
  mode: RunMode;
  hint?: string;
  /** 駆動中のエージェントが許可要求を上げられるか。省略 = 上げられる（一覧など対象が定まらない画面）。 */
  confirmSupported?: boolean;
}> = ({ mode, hint, confirmSupported = true }) => {
  const m = useMessages();
  const auto = mode === 'auto';
  const modeLabel = auto
    ? m.footer.autoMode
    : confirmSupported
      ? m.footer.confirmMode
      : m.footer.confirmModeUnsupported;
  return (
    <Box marginLeft={2}>
      {/* モード表示は縮まない（ツールが自動実行かどうかは常に読めるべき）。 */}
      <Box flexShrink={0}>
        <Text color={auto ? theme.auto : theme.confirm} bold>
          {auto ? glyph.auto : glyph.confirm} {modeLabel}
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
