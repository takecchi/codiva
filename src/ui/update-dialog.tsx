import { Box, Text } from 'ink';
import type { FC } from 'react';
import { canSelfUpdate, type UpdateViewState, updateCommandLine } from '@/core';
import { DialogBox } from './dialog-box';
import { useMessages } from './i18n-context';
import { statusColor, theme } from './theme';

/**
 * `/update` の表示。**presentational のみ**（`useInput` を持たない）— キーは
 * 一覧ビューの単一ハンドラが処理する（規約: ink-components.md「1画面 1 useInput」）。
 * これは y/n の確認とほぼ同じ操作なので、モーダル用の独立 useInput を増やすより
 * `confirm` / `confirmResumeAll` と同じ扱いに揃えている。
 *
 * 状態は `UpdateViewState`（core の union）をそのまま分岐するだけ。「更新がある」
 * ときの文言は 3 通りに分かれる:
 *   - 実行できる経路（`canSelfUpdate` = グローバルインストール）→ y/n で確認して実行
 *   - npx → インストールが無いので次回起動でそのまま最新になる（何もしない）
 *   - それ以外（ローカル依存・判定不能・Windows）→ 手動で実行するコマンドだけ提示する
 */
export const UpdateDialog: FC<{ state: UpdateViewState; activeSessions?: number }> = ({
  state,
  activeSessions = 0,
}) => {
  const m = useMessages();
  return (
    <DialogBox flexDirection="column">
      <Text bold color={theme.accent}>
        {m.update.title}
      </Text>
      <Body state={state} activeSessions={activeSessions} />
    </DialogBox>
  );
};

const Body: FC<{ state: UpdateViewState; activeSessions: number }> = ({
  state,
  activeSessions,
}) => {
  const m = useMessages();
  switch (state.kind) {
    case 'checking':
      return <Text dimColor>{m.update.checking}</Text>;
    case 'installing':
      return (
        <Box flexDirection="column">
          <Text color={statusColor.running}>{m.update.installing}</Text>
          <Text dimColor>{m.update.installingHint}</Text>
        </Box>
      );
    case 'installed':
      return (
        <Box flexDirection="column">
          <Text color={statusColor.completed}>{m.update.installed(state.info.latest)}</Text>
          <Text dimColor>{m.update.dismiss}</Text>
        </Box>
      );
    case 'failed':
      return (
        <Box flexDirection="column">
          <Text color={statusColor.failed}>
            {state.detail ? m.update.failed(state.detail) : m.update.failedUnknown}
          </Text>
          <Text dimColor>{m.update.dismiss}</Text>
        </Box>
      );
    case 'result':
      return <Result state={state} activeSessions={activeSessions} />;
  }
};

const Result: FC<{
  state: Extract<UpdateViewState, { kind: 'result' }>;
  activeSessions: number;
}> = ({ state, activeSessions }) => {
  const m = useMessages();
  const check = state.check;
  if (check.kind === 'unavailable') {
    return (
      <Box flexDirection="column">
        <Text color={statusColor.interrupted}>{m.update.unavailable}</Text>
        <Text dimColor>{m.update.dismiss}</Text>
      </Box>
    );
  }
  if (check.kind === 'up-to-date') {
    return (
      <Box flexDirection="column">
        <Text color={statusColor.completed}>{m.update.upToDate(check.current)}</Text>
        <Text dimColor>{m.update.dismiss}</Text>
      </Box>
    );
  }
  const { info } = check;
  const command = updateCommandLine(info.install, info.pkg);
  // npx は更新コマンドが存在しない（毎回最新を取る）ので、案内だけ出して終わる。
  if (info.install === 'npx' || command === undefined) {
    return (
      <Box flexDirection="column">
        <Text>{m.update.npx(info.latest)}</Text>
        <Text dimColor>{m.update.dismiss}</Text>
      </Box>
    );
  }
  if (!canSelfUpdate(info.install)) {
    return (
      <Box flexDirection="column">
        <Text>{m.update.manual(info.latest, command)}</Text>
        <Text dimColor>{m.update.dismiss}</Text>
      </Box>
    );
  }
  return (
    <Box flexDirection="column">
      <Text>{m.update.confirm(info.latest, command)}</Text>
      {/* 更新は codiva 自身のファイル（と同梱 SDK）を置き換えるので、稼働中の
          セッションがあるなら先に終わらせるよう促す。ブロックはしない。 */}
      {activeSessions > 0 ? (
        <Text color={statusColor.awaitingPermission}>{m.update.activeWarning(activeSessions)}</Text>
      ) : null}
      <Text>
        {m.action.confirmRun} <Text color={theme.yes}>y</Text> / <Text color={theme.no}>n</Text>
      </Text>
    </Box>
  );
};
