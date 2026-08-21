import { Box, Text, useInput, useWindowSize } from 'ink';
import { type FC, useState } from 'react';
import { type AgentAvailability, type AgentId, dialogContentWidth, parseSgrMouse } from '@/core';
import { ChoiceRow } from './choice-row';
import { useMessages } from './i18n-context';
import { glyph, theme } from './theme';

/**
 * `/agent` で開くエージェント選択。`ModelSelect` と同じ単一選択リストで、
 * ↑↓ で移動・Enter で決定・Esc でキャンセル。開いている間はこのダイアログが
 * キーを持つ（背後の view は自分の `useInput` の先頭でガードする）。
 *
 * 2 つのモードで使う:
 * - `'session'`（詳細ビュー）: このセッションを駆動する provider を切り替える。
 * - `'default'`（一覧ビュー）: 新規セッションの既定 provider を選ぶ（config に永続化）。
 *
 * 各行に導入・ログイン状態を出す（`AgentAvailability`）。表示名・コマンド名は固有名詞
 * なので翻訳せず、状態の文言だけカタログから引く。
 */
export interface AgentChoice {
  id: AgentId;
  /** 画面に出す名前（'Claude' / 'Codex'）。アダプタ由来の固有名詞。 */
  displayName: string;
  /** ログイン / インストール案内に差し込む CLI コマンド名（`claude` / `codex`）。 */
  command: string;
  /** 導入・ログイン状態（未検出なら undefined = 確認中）。 */
  availability?: AgentAvailability;
}

export const AgentSelect: FC<{
  mode: 'session' | 'default';
  /** session: 今このセッションを駆動している provider / default: 現在の既定 provider。 */
  current: AgentId | undefined;
  agents: readonly AgentChoice[];
  onSelect: (agent: AgentId) => void;
  /** `l` でハイライト中のエージェントに codiva 内ログインを開始する（省略可）。 */
  onLogin?: (agent: AgentId) => void;
  onCancel: () => void;
}> = ({ mode, current, agents, onSelect, onLogin, onCancel }) => {
  const m = useMessages();
  const { columns } = useWindowSize();
  const width = dialogContentWidth(columns);
  // カーソルは「今の provider」から始める。動かすまでは派生値のままにして、
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
      return;
    }
    // `l` = ハイライト中のエージェントに codiva 内ログイン（`onLogin` があるときだけ）。
    if (onLogin && (rawInput === 'l' || rawInput === 'L')) {
      const choice = agents[cursor];
      if (choice) {
        onLogin(choice.id);
      }
    }
  });

  /** 1 行ぶんの状態説明（導入・ログイン）。未検出は「確認中」。 */
  const describe = (choice: AgentChoice): string => {
    const a = choice.availability;
    if (!a) {
      return m.agent.checking;
    }
    if (!a.installed) {
      return m.agent.notInstalled(choice.command);
    }
    if (a.loggedIn === false) {
      return m.agent.notLoggedIn(choice.command);
    }
    return a.loggedIn === true ? m.agent.ready : m.agent.loginUnknown;
  };

  const marker = mode === 'session' ? m.agent.current : m.agent.currentDefault;

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
              label={`${choice.displayName}${choice.id === current ? ` (${marker})` : ''}`}
              description={describe(choice)}
              active={active}
              width={width}
            />
          );
        })}
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text dimColor>{mode === 'session' ? m.agent.warning : m.agent.defaultHint}</Text>
        {/* 区切りは `theme.ts` の記号を使う（全角の `・` を直書きすると英語 UI に
            混ざる。ヒント行の区切りは他の画面と同じ `·`）。 */}
        <Text dimColor>
          {onLogin ? `${m.agent.help} ${glyph.dot} ${m.agent.loginKey}` : m.agent.help}
        </Text>
      </Box>
    </Box>
  );
};
