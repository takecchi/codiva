import { Box, Text } from 'ink';
import type { FC } from 'react';
import type { CommandSpec } from '@/core';
import { useMessages } from './i18n-context';
import { glyph, theme } from './theme';

/**
 * Presentational list of slash commands shown above the composer while the user
 * is typing a `/command` (and as the full list for `/help`). No key handling —
 * the owning view's single useInput drives editing; this only reflects state.
 * Empty `commands` renders a "no match" hint so a typo is visible.
 */
export const CommandPalette: FC<{
  title: string;
  commands: readonly CommandSpec[];
  /**
   * ビュー固有の説明文（キーはコマンド名）。同じコマンドが画面によって違う意味を
   * 持つ場合に使う（詳細ビューの `/exit` は終了ではなく一覧へ戻る）。文字列は
   * 呼び出し側がカタログから引いて渡す（i18n 規約: .tsx に直書きしない）。
   */
  describeOverrides?: Readonly<Record<string, string>>;
}> = ({ title, commands, describeOverrides }) => {
  const m = useMessages();
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.dim} paddingX={1}>
      <Text color={theme.accent} bold>
        {glyph.star} {title}
      </Text>
      {commands.length === 0 ? (
        <Text dimColor>{m.command.paletteEmpty}</Text>
      ) : (
        commands.map((c) => (
          <Box key={c.name}>
            <Box width={12}>
              <Text color={theme.accent}>/{c.name}</Text>
            </Box>
            <Text dimColor>{describeOverrides?.[c.name] ?? c.describe(m)}</Text>
          </Box>
        ))
      )}
    </Box>
  );
};
