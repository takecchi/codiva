import { Box, Text } from 'ink';
import type { FC } from 'react';
import type { CommandSpec } from '@/core';
import { useMessages } from './i18n-context';
import { glyph, theme } from './theme';

/** `maxRows` に収まる行と、畳んだ件数（純粋な切り出し）。 */
function fitRows(
  commands: readonly CommandSpec[],
  maxRows: number | undefined,
): { rows: readonly CommandSpec[]; hidden: number } {
  if (maxRows === undefined || commands.length <= maxRows) {
    return { rows: commands, hidden: 0 };
  }
  // 溢れたら「他 N 件」の 1 行を枠内に取る（総行数を maxRows に保つ）。
  const shown = Math.max(1, maxRows - 1);
  return { rows: commands.slice(0, shown), hidden: commands.length - shown };
}

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
  /**
   * 描いてよいコマンド行数（`core/layout.ts` の `paletteMaxRows`）。溢れた分は
   * 最終行の「他 N 件」に畳む。省略すると全件描く（低い端末では枠が潰れる）。
   */
  maxRows?: number;
}> = ({ title, commands, describeOverrides, maxRows }) => {
  const m = useMessages();
  const { rows, hidden } = fitRows(commands, maxRows);
  return (
    // `flexShrink={0}`: コマンドが増えて縦に入り切らなくなると Yoga はこの枠を
    // **縮める**（クリップではなく行が潰れて混ざる）ため、`/help` の一覧が
    // 「/diffpt」のような読めない行になる。縮む役は内部スクロールを持つ一覧側に寄せる
    // （規約: ink-components.md）。
    <Box
      flexDirection="column"
      flexShrink={0}
      borderStyle="round"
      borderColor={theme.dim}
      paddingX={1}
    >
      <Text color={theme.accent} bold>
        {glyph.star} {title}
      </Text>
      {commands.length === 0 ? (
        <Text dimColor>{m.command.paletteEmpty}</Text>
      ) : (
        rows.map((c) => (
          <Box key={c.name}>
            <Box width={12}>
              <Text color={theme.accent}>/{c.name}</Text>
            </Box>
            <Text dimColor>{describeOverrides?.[c.name] ?? c.describe(m)}</Text>
          </Box>
        ))
      )}
      {/* 黙って切らない: 絞り込めば出てくることが分かるように件数を出す。 */}
      {hidden > 0 ? <Text dimColor>{m.command.paletteMore(hidden)}</Text> : null}
    </Box>
  );
};
