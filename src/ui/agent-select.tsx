import { Box, Text, useInput, useWindowSize } from 'ink';
import { type FC, useState } from 'react';
import { type AgentId, dialogContentWidth, parseSgrMouse } from '@/core';
import { ChoiceRow } from './choice-row';
import { useMessages } from './i18n-context';
import { glyph, theme } from './theme';

/**
 * `/agent` で開くエージェント選択。`ModelSelect` と同じ単一選択リストで、
 * ↑↓ で移動・Enter で決定・Esc でキャンセル。開いている間はこのダイアログが
 * キーを持つ（背後の view は自分の `useInput` の先頭でガードする）。
 *
 * 表示名は固有名詞なので翻訳しない（`AgentAdapter.displayName` をそのまま出す）。
 * codiva 自身の文言（見出し・注意書き・「使用中」）はカタログから引く。
 */
export interface AgentChoice {
  id: AgentId;
  /** 画面に出す名前（'Claude' / 'Codex'）。アダプタ由来の固有名詞。 */
  displayName: string;
  /** そのエージェントの説明（できないことの注記など）。省略可。 */
  description?: string;
}

export const AgentSelect: FC<{
  /** 今このセッションを駆動しているエージェント。 */
  current: AgentId | undefined;
  agents: readonly AgentChoice[];
  onSelect: (agent: AgentId) => void;
  onCancel: () => void;
}> = ({ current, agents, onSelect, onCancel }) => {
  const m = useMessages();
  const { columns } = useWindowSize();
  const width = dialogContentWidth(columns);
  // カーソルは「今のエージェント」から始める。動かすまでは派生値のままにして、
  // 一覧が入れ替わっても行 0 に貼り付かないようにする（ModelSelect と同じ理由）。
  const [moved, setMoved] = useState<number | undefined>(undefined);
  const currentIndex = Math.max(
    0,
    agents.findIndex((a) => a.id === current),
  );
  const cursor =
    moved === undefined ? currentIndex : Math.min(moved, Math.max(0, agents.length - 1));

  useInput((rawInput, key) => {
    // モーダルは自分の useInput を持つので、マウスレポートは先頭で握り潰す。
    if (parseSgrMouse(rawInput)) {
      return;
    }
    if (key.escape) {
      onCancel();
      return;
    }
    if (agents.length === 0) {
      return;
    }
    if (key.upArrow) {
      setMoved(Math.max(0, cursor - 1));
      return;
    }
    if (key.downArrow) {
      setMoved(Math.min(agents.length - 1, cursor + 1));
      return;
    }
    if (key.return) {
      const choice = agents[cursor];
      if (choice) {
        onSelect(choice.id);
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
        {m.agent.title}
      </Text>
      <Box flexDirection="column" marginTop={1}>
        {agents.map((choice, i) => {
          const active = i === cursor;
          return (
            <ChoiceRow
              key={choice.id}
              prefix={`${active ? glyph.caret : ' '} `}
              label={`${choice.displayName}${choice.id === current ? ` (${m.agent.current})` : ''}`}
              description={choice.description}
              active={active}
              width={width}
            />
          );
        })}
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text dimColor>{m.agent.warning}</Text>
        <Text dimColor>{m.agent.help}</Text>
      </Box>
    </Box>
  );
};
