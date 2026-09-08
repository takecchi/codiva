import { Box, useInput } from 'ink';
import type { FC } from 'react';
import { describe, expect, it } from 'vitest';
import { type LogEntry, logViewportRows } from '@/core';
import { LogPane, useLogPane } from '@/ui/log-pane';
import { renderFullscreen, settle } from '../../tests/helpers';

const WIDTH = 80;
const ROWS = 20;
/** PgUp（Ink はこのエスケープを `key.pageUp` として渡す）。 */
const PAGE_UP = '[5~';

function entry(seq: number, text: string, kind: LogEntry['kind'] = 'system'): LogEntry {
  return { seq, kind, text };
}

/** 連番のログ（`line-1` … `line-n`）。1 件 = 1 物理行になる短さにしてある。 */
function manyEntries(n: number): LogEntry[] {
  return Array.from({ length: n }, (_, i) => entry(i + 1, `line-${i + 1}`));
}

/**
 * `useLogPane` + `<LogPane>` を実際の Ink で描くハーネス。高さを固定した親に入れるのは、
 * このコンポーネントが `flexGrow` で残りを占める設計だから（親が無いと内容分だけ伸びる）。
 * キーは 1 つの `useInput` から `handleScrollKey` に渡す（view と同じ形）。
 */
const Harness: FC<{ entries: readonly LogEntry[]; streamingText?: string }> = ({
  entries,
  streamingText,
}) => {
  const pane = useLogPane({
    entries,
    streamingText,
    width: WIDTH,
    fallbackRows: logViewportRows,
  });
  useInput((_input, key) => {
    pane.handleScrollKey(key);
  });
  return (
    <Box flexDirection="column" height={ROWS} overflow="hidden">
      <LogPane pane={pane} statusHint={(n) => `MORE:${n}`} />
    </Box>
  );
};

const linesOf = (frame: string): string[] => frame.split('\n');

describe('LogPane', () => {
  it('可視域より多いログでも描画行数が高さを超えない（虫食い落ちの番人）', async () => {
    const { lastFrame, app } = renderFullscreen(<Harness entries={manyEntries(100)} />, ROWS, 100);
    await settle(lastFrame);
    const frame = lastFrame();
    // Yoga は溢れた子を「上でクリップ」せず「縮小」するので、1 行でも多く描くと
    // ログの途中が虫食いで消える。行数が高さに収まっていることが唯一の防波堤。
    expect(linesOf(frame).length).toBeLessThanOrEqual(ROWS);
    // 末尾追従（アンカー 'bottom'）なので最新が見えて最古は落ちている。
    expect(frame).toContain('line-100');
    expect(frame).not.toContain('line-1\n');
    app.unmount();
  });

  it('状態行は idle でも scrollback でも 1 行 = 全体の高さが変わらない', async () => {
    const { lastFrame, stdin, app } = renderFullscreen(
      <Harness entries={manyEntries(100)} />,
      ROWS,
      100,
    );
    await settle(lastFrame);
    const atBottom = lastFrame();
    // 末尾では案内を出さない（空行が 1 行ぶんの場所を取る）。
    expect(atBottom).not.toContain('MORE:');
    const heightAtBottom = linesOf(atBottom).length;

    stdin.write(PAGE_UP);
    await settle(lastFrame);
    const scrolled = lastFrame();
    // 過去ログへ移ったので案内が出る…
    expect(scrolled).toContain('MORE:');
    // …が、**行数は 1 行も変わらない**。ここが変わると、ログの可視域が跳ねて
    // 「↑ を押しても上端が動かない」「ターンごとに画面が揺れる」に戻る。
    expect(linesOf(scrolled).length).toBe(heightAtBottom);
    app.unmount();
  });

  it('ログの空行が 1 行ぶんの高さを保つ（measureText("") = 0 の穴埋め）', async () => {
    // 段落の間の空行。`BLANK_ROW` に置き換えないと高さ 0 になり、スクロール計算が
    // 数えた物理行が画面から消える（末尾寄せのビューポートの上端に隙間が残る）。
    const { lastFrame, app } = renderFullscreen(
      <Harness entries={[entry(1, 'alpha\n\nbravo')]} />,
      ROWS,
      100,
    );
    await settle(lastFrame);
    const rows = linesOf(lastFrame());
    const alpha = rows.findIndex((r) => r.includes('alpha'));
    const bravo = rows.findIndex((r) => r.includes('bravo'));
    expect(alpha).toBeGreaterThanOrEqual(0);
    // 間に空行が 1 行あるので index の差はちょうど 2。
    expect(bravo - alpha).toBe(2);
    app.unmount();
  });

  it('ストリーミング中の本文を確定ログの後ろの行として描く', async () => {
    const { lastFrame, app } = renderFullscreen(
      <Harness entries={[entry(1, 'settled')]} streamingText={'live-one\nlive-two'} />,
      ROWS,
      100,
    );
    await settle(lastFrame);
    const rows = linesOf(lastFrame());
    const settled = rows.findIndex((r) => r.includes('settled'));
    const one = rows.findIndex((r) => r.includes('live-one'));
    const two = rows.findIndex((r) => r.includes('live-two'));
    // 確定 → ライブの順に下へ伸びる（末尾の 1 行だけを書き換えるのではない）。
    expect(settled).toBeLessThan(one);
    expect(one).toBeLessThan(two);
    app.unmount();
  });
});
