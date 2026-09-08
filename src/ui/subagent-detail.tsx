import { Box, Text, useInput, useWindowSize } from 'ink';
import { type FC, useMemo } from 'react';
import {
  formatDuration,
  parseSgrMouse,
  type SessionManager,
  type SubagentRun,
  subagentElapsedMs,
  wrapDisplayLines,
} from '@/core';
import { useRunMode, useSessions } from './hooks';
import { useMessages } from './i18n-context';
import { BLANK_ROW } from './log-line';
import { LogPane, useLogPane } from './log-pane';
import { StatusFooter } from './status-footer';
import { statusColor } from './theme';

/**
 * この画面でログ以外に消費される固定の縦幅: 上下パディング 2 + ヘッダ 2
 * （見出し + 説明。**常に 2 行**）+ 状態行 1（`LogPane` が持つ）+ フッタ 1。
 *
 * セッション詳細の `DETAIL_CHROME_ROWS` と同じ理由でどの行も条件付きにしない
 * （出し入れするとログの可視域が変わって画面が跳ねる）。実測できる場合は
 * `useBoxHeight` を優先し、これは初回描画までのフォールバック。
 */
const CHROME_ROWS = 6;

function subagentViewportRows(rows: number): number {
  return Math.max(1, rows - CHROME_ROWS);
}

function statusColorOf(status: SubagentRun['status']): string {
  switch (status) {
    case 'running':
      return statusColor.running;
    case 'completed':
      return statusColor.completed;
    case 'failed':
      return statusColor.failed;
    default:
      return statusColor.interrupted;
  }
}

/**
 * 1 つのサブエージェントの専用ログ（詳細ビューの下段の行 / `/subagents` から開く）。
 *
 * **入力欄は持たない** — サブエージェントに直接指示は送れないので、あるように見せない。
 * ログの機械（実測・スクロール・範囲選択・URL クリック・端の自動スクロール）は
 * セッション詳細と**同じ** `useLogPane` を通すので、片方だけ挙動が食い違うことがない。
 *
 * 出口は Esc 一本（コマンドも `/exit` も置かない）。`Ctrl+C` は**親セッションの**
 * ターンを中断する — 暴走したサブエージェントを止めたいのはまさにこの画面なので、
 * chord の意味を詳細ビューと揃えておく。
 */
export const SubagentDetail: FC<{
  manager: SessionManager;
  /** 親セッションの id。 */
  id: string;
  /** 見ているサブエージェントの task id。 */
  taskId: string;
  /** 詳細ビューへ戻る（Esc）。 */
  onBack: () => void;
  onCopy?: (text: string) => void;
  onOpenUrl?: (url: string) => void;
}> = ({ manager, id, taskId, onBack, onCopy, onOpenUrl }) => {
  const m = useMessages();
  const mode = useRunMode(manager);
  const sessions = useSessions(manager);
  const { columns } = useWindowSize();
  const session = sessions.find((s) => s.id === id);
  const run = session?.subagents?.find((candidate) => candidate.id === taskId);
  const width = Math.max(1, columns - 2);

  const pane = useLogPane({
    entries: run?.messages,
    width,
    fallbackRows: subagentViewportRows,
    onCopy,
    onOpenUrl,
  });

  useInput((rawInput, key) => {
    // マウスレポートはキーより先に解釈する（レポート断片が生テキストとして流れ込むのを防ぐ）。
    const mouse = parseSgrMouse(rawInput);
    if (mouse) {
      pane.handleMouse(mouse);
      return;
    }
    // 何かキーが来たら選択のハイライトを消す（自動スクロールも止める）。
    pane.clearSelection();
    pane.clearPendingLink();
    if (key.escape) {
      onBack();
      return;
    }
    if (key.tab && key.shift) {
      manager.cycleMode();
      return;
    }
    if (key.ctrl && (rawInput === 'c' || rawInput === 'C')) {
      // 親セッションのターンを中断する。SDK の control request は reject し得るので
      // 裸で投げない（unhandled rejection = TUI の死）。
      void manager.interrupt(id).catch(() => undefined);
      return;
    }
    // ↑↓ / PgUp / PgDn。入力欄が無いので矢印はいつでもスクロール。
    pane.handleScrollKey(key);
  });

  // ヘッダは**常に 2 行**（内容で行数を変えない = ログの可視域を揺らさない）。
  // どちらも表示幅に切ってから `<Text>` へ渡す — 説明は進捗ごとに、経過は毎秒
  // 変わるので、切らずに渡すと Ink の上限なしキャッシュに積まれ続ける。
  const header = useMemo(() => {
    if (!run) {
      return { title: m.subagent.title(taskId), description: undefined, color: undefined };
    }
    const elapsed = subagentElapsedMs(run, Date.now());
    const status =
      run.status === 'running'
        ? m.subagent.statusRunning
        : run.status === 'completed'
          ? m.subagent.statusDone
          : run.status === 'failed'
            ? m.subagent.statusFailed
            : m.subagent.statusStopped;
    const parts = [
      m.subagent.title(run.kind ?? run.description ?? run.id),
      status,
      elapsed === undefined ? undefined : formatDuration(elapsed),
    ].filter((part): part is string => part !== undefined);
    return {
      title: wrapDisplayLines(parts.join(' · '), width)[0] ?? '',
      description:
        run.description === undefined
          ? undefined
          : (wrapDisplayLines(run.description, width)[0] ?? ''),
      color: statusColorOf(run.status),
    };
  }, [run, m, taskId, width]);

  return (
    <Box flexDirection="column" flexGrow={1} padding={1}>
      {/* ヘッダ 2 行（flexShrink={0}: 縮む役は内部スクロールを持つログ領域に寄せる）。 */}
      <Box flexDirection="column" flexShrink={0}>
        <Text color={header.color} bold wrap="truncate-end">
          {header.title}
        </Text>
        <Text dimColor wrap="truncate-end">
          {header.description !== undefined && header.description.length > 0
            ? header.description
            : BLANK_ROW}
        </Text>
      </Box>

      {run === undefined ? (
        // 記録が残っていない（transient なので復元セッション / 上限で落ちた）。
        // **自動で戻さない** — 画面が勝手に変わるほうが分かりにくい。
        <Box flexGrow={1} marginTop={1}>
          <Text dimColor>{m.subagent.gone}</Text>
        </Box>
      ) : run.messages.length === 0 ? (
        <Box flexGrow={1} marginTop={1}>
          <Text dimColor>{m.subagent.emptyLog}</Text>
        </Box>
      ) : (
        <LogPane pane={pane} statusHint={m.detail.scrollHint} />
      )}

      <StatusFooter mode={mode} hint={m.subagent.help} />
    </Box>
  );
};
