import { Box, Text, useInput, useWindowSize } from 'ink';
import { type FC, useState } from 'react';
import {
  type ConfigToggleId,
  type ConfigToggleRow,
  dialogContentWidth,
  parseSgrMouse,
} from '@/core';
import { ChoiceRow } from './choice-row';
import { useMessages } from './i18n-context';
import { glyph, theme } from './theme';

/**
 * `/config` で開く設定画面。`AgentSelect` と同じ単一リストだが、Enter は「決定して
 * 閉じる」ではなく **その行の ON/OFF を反転**する（続けて何項目でも切り替えられる）。
 * 変更は 1 回ごとに親が保存するので、Esc は「キャンセル」ではなく「閉じる」。
 *
 * 行は 1 行に保ち、説明は**リストの下の固定 1 行**（選択中の項目のもの）に出す。
 * 行ごとに説明を折り返すと 11 項目で 20 行を超え、低い端末でダイアログが潰れる
 * （枠は `flexShrink={0}` なので、潰れる役は上の一覧に回ってしまう）。カーソル移動で
 * 高さが変わらないので、リストが上下に揺れることもない。
 */
export const ConfigSelect: FC<{
  rows: readonly ConfigToggleRow[];
  /** 1 項目の ON/OFF を反転する（保存は親の責務）。 */
  onToggle: (id: ConfigToggleId) => void;
  onClose: () => void;
}> = ({ rows, onToggle, onClose }) => {
  const m = useMessages();
  const { columns } = useWindowSize();
  const width = dialogContentWidth(columns);
  const [cursor, setCursor] = useState(0);
  const active = Math.min(cursor, Math.max(0, rows.length - 1));

  useInput((rawInput, key) => {
    // モーダルは自分の useInput を持つので、マウスレポートは先頭で握り潰す。
    if (parseSgrMouse(rawInput)) {
      return;
    }
    if (key.escape) {
      onClose();
      return;
    }
    if (rows.length === 0) {
      return;
    }
    if (key.upArrow) {
      setCursor(Math.max(0, active - 1));
      return;
    }
    if (key.downArrow) {
      setCursor(Math.min(rows.length - 1, active + 1));
      return;
    }
    // Enter と Space のどちらでも切り替えられるようにする（チェックリストの慣習が
    // 端末によって違うため）。Space は印字キーなので rawInput で見る。
    if (key.return || rawInput === ' ') {
      const row = rows[active];
      if (row) {
        onToggle(row.id);
      }
    }
  });

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.accent}
      paddingX={1}
      flexShrink={0}
    >
      <Text color={theme.accent} bold>
        {m.config.title}
      </Text>
      <Box flexDirection="column" marginTop={1}>
        {rows.map((row, i) => (
          <ChoiceRow
            key={row.id}
            // `[x]` / `[ ]` は記号なので翻訳しない（許可ダイアログの選択肢と同じ形）。
            prefix={`${i === active ? glyph.caret : ' '} [${row.on ? 'x' : ' '}] `}
            label={row.label}
            active={i === active}
            width={width}
          />
        ))}
      </Box>
      <Box marginTop={1} flexDirection="column">
        {/* 説明は常に 1 行（`truncate-end`）。行数を選択位置で変えないため。 */}
        <Text dimColor wrap="truncate-end">
          {rows[active]?.description ?? ' '}
        </Text>
        <Text dimColor>{m.config.restartHint}</Text>
        <Text dimColor>{m.config.help}</Text>
      </Box>
    </Box>
  );
};
