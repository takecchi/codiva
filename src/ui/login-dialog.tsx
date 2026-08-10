import { Box, Text, useInput } from 'ink';
import { type FC, useEffect, useRef, useState } from 'react';
import {
  type AgentLoginProcess,
  appendLoginLine,
  finishLogin,
  initialLoginState,
  type LoginState,
  osc8,
  parseSgrMouse,
} from '@/core';
import { DialogBox } from './dialog-box';
import { useMessages } from './i18n-context';
import { statusColor, theme } from './theme';

/**
 * `/login`（と `/agent` の `l`）で開く TUI 内ログイン。端末は明け渡さず、`<cli> login` を
 * 裏で起動して**出力の認証 URL をここに出す**（自動でブラウザも開く）。開いている間は
 * このダイアログがキーを持ち、Esc で中止 / 閉じる。
 *
 * 進行の解釈は純粋な `core/agent-login.ts`、プロセス起動は `utils/agent-login.ts`。
 */
export const LoginDialog: FC<{
  agentName: string;
  /** ログインプロセスを開始する（`manager.startLogin(id)`）。undefined なら未対応。 */
  start: () => AgentLoginProcess | undefined;
  /** 認証 URL をブラウザで開く（`main.tsx` が `openUrl` を注入）。 */
  onOpenUrl?: (url: string) => void;
  /** 閉じるときに呼ぶ。`succeeded` なら親が可用性を再検出する。 */
  onClose: (succeeded: boolean) => void;
}> = ({ agentName, start, onOpenUrl, onClose }) => {
  const m = useMessages();
  const [state, setState] = useState<LoginState>(initialLoginState);
  const procRef = useRef<AgentLoginProcess | undefined>(undefined);
  // 自動オープンは 1 回だけ（URL が確定したフレームで開く）。
  const openedRef = useRef(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: 起動は 1 回だけ（マウント時）。
  useEffect(() => {
    const proc = start();
    if (!proc) {
      // 未対応 provider（`login()` を持たない）。失敗表示にして閉じ待ちにする。
      setState((s) => finishLogin(s, 1));
      return;
    }
    procRef.current = proc;
    let live = true;
    (async () => {
      for await (const line of proc) {
        if (!live) {
          return;
        }
        setState((s) => appendLoginLine(s, line));
      }
      if (live) {
        setState((s) => finishLogin(s, proc.result().code));
      }
    })().catch(() => {
      if (live) {
        setState((s) => finishLogin(s, 1));
      }
    });
    return () => {
      live = false;
    };
  }, []);

  // URL が出たら 1 回だけブラウザで開く。
  useEffect(() => {
    if (state.url && !openedRef.current) {
      openedRef.current = true;
      onOpenUrl?.(state.url);
    }
  }, [state.url, onOpenUrl]);

  useInput((rawInput, key) => {
    // モーダルは自分の useInput を持つので、マウスレポートは先頭で握り潰す。
    if (parseSgrMouse(rawInput)) {
      return;
    }
    if (key.escape) {
      // 実行中なら中止（プロセスを殺す）、終わっていれば閉じる。
      procRef.current?.cancel();
      onClose(state.status === 'succeeded');
    }
  });

  const color =
    state.status === 'succeeded'
      ? statusColor.completed
      : state.status === 'failed'
        ? statusColor.failed
        : theme.accent;

  return (
    <DialogBox flexDirection="column">
      <Text color={theme.accent} bold>
        {m.login.title(agentName)}
      </Text>
      <Box flexDirection="column" marginTop={1}>
        {state.status === 'succeeded' ? (
          <Text color={color}>{m.login.succeeded(agentName)}</Text>
        ) : state.status === 'failed' ? (
          <>
            <Text color={color}>{m.login.failed(agentName)}</Text>
            {state.error ? <Text dimColor>{state.error}</Text> : null}
          </>
        ) : state.url ? (
          <>
            <Text>{m.login.openUrl}</Text>
            {/* OSC 8 で対応端末ではクリック可能に。自動オープンも走る。 */}
            <Text color={theme.accent}>{osc8(state.url, state.url)}</Text>
            {state.code ? <Text>{m.login.code(state.code)}</Text> : null}
            <Text dimColor>{m.login.waiting}</Text>
          </>
        ) : (
          <Text dimColor>{m.login.starting}</Text>
        )}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>{m.login.help}</Text>
      </Box>
    </DialogBox>
  );
};
