import { Box, type DOMElement, Text } from 'ink';
import type { FC, RefObject } from 'react';
import type { ChoiceRowItem, ChoiceView } from '@/core';
import { ChoiceRow } from './choice-row';
import { DialogBox } from './dialog-box';
import { useMessages } from './i18n-context';
import { statusColor } from './theme';

/**
 * サブエージェントが複数あるときの選択ダイアログ。
 *
 * **自分の `useInput` は持たない**（アクションパネルと同じ presentational）。キーは
 * 詳細ビューの単一ハンドラが処理する — キーを持つモーダルを増やすと「背後の view が
 * 表示中に全キーを飲む」ガードを増やすことになり、そのガードを 1 つ忘れるだけで
 * 入力が二重に効く（規約: `.claude/rules/ink-components.md`）。
 *
 * **表示ウィンドウ（`view`）は親が計算して渡す。** ここで組み直すと「描画に使った
 * 折返し幅・配列」とクリック位置の逆算が食い違い、押した行と別の選択肢に当たる。
 * 溢れは黙って切らずに隠れている件数をインジケータに出す（許可ダイアログと同じ）。
 */
export const SubagentPicker: FC<{
  /** 描画と当たり判定で**同じ配列**（`core/subagent-row.ts` の `subagentChoices`）。 */
  items: readonly ChoiceRowItem[];
  /** 親が `choiceView(heights, cursor, cap)` で出した表示ウィンドウ。 */
  view: ChoiceView;
  /** カーソルの位置（`items` に対する index）。 */
  cursor: number;
  /** 折返し幅（`dialogContentWidth(columns)`）。当たり判定と必ず同じ値。 */
  width: number;
  /** 選択肢ブロックの上端を親が実測するための ref（クリック位置の逆算用）。 */
  listRef?: RefObject<DOMElement | null>;
}> = ({ items, view, cursor, width, listRef }) => {
  const m = useMessages();
  const visible = items.slice(view.start, view.end);
  return (
    <DialogBox flexDirection="column">
      <Text color={statusColor.running} bold>
        {m.subagent.pickerTitle}
      </Text>
      {/* `ref` の Box の上端が「インジケータ／選択肢の 1 行目」。親はここから
          描いたウィンドウで逆算する（インジケータ 1 行ぶんのずれに注意）。 */}
      <Box ref={listRef} flexDirection="column" marginTop={1}>
        {view.showAbove ? <Text dimColor>{m.permission.moreAbove(view.hiddenAbove)}</Text> : null}
        {visible.map((item, i) => (
          <ChoiceRow
            key={`${String(view.start + i)}:${item.choice.label}`}
            prefix={item.prefix}
            label={item.choice.label}
            description={item.choice.description}
            active={cursor === view.start + i}
            width={width}
          />
        ))}
        {view.showBelow ? <Text dimColor>{m.permission.moreBelow(view.hiddenBelow)}</Text> : null}
      </Box>
      <Text dimColor>{m.subagent.pickerHelp}</Text>
    </DialogBox>
  );
};
