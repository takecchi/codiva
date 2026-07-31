import { EventEmitter } from 'node:events';
import { Box, render as inkRender } from 'ink';
import { render } from 'ink-testing-library';
import type { ReactElement } from 'react';
import { describe, expect, it } from 'vitest';
import { bufferOf, emptyBuffer } from '@/core';
import { PromptInput } from './prompt-input';

const flush = () => new Promise((r) => setTimeout(r, 120));

// カーソル制御（\x1b[?25h と位置移動）は interactive（非 debug）レンダリング
// でしか書き出されないため、ink-testing-library ではなく本体 render を使う。
class FakeStdout extends EventEmitter {
  readonly columns = 80;
  readonly rows = 20;
  readonly chunks: string[] = [];
  write = (chunk: string) => {
    this.chunks.push(chunk);
    return true;
  };
}

function renderInteractive(element: ReactElement) {
  const stdout = new FakeStdout();
  const app = inkRender(element, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    interactive: true,
    patchConsole: false,
    exitOnCtrlC: false,
  });
  return { app, output: () => stdout.chunks.join('') };
}

const ESC = String.fromCharCode(27);

/** Last cursor placement from `ESC[<up>A ESC[<col>G ESC[?25h` (col is 1-based). */
function lastCursor(output: string): { up: number; column: number } | undefined {
  const cursorShow = new RegExp(`${ESC}\\[(\\d+)A${ESC}\\[(\\d+)G${ESC}\\[\\?25h`, 'g');
  const matches = [...output.matchAll(cursorShow)];
  const last = matches.at(-1);
  return last ? { up: Number(last[1]), column: Number(last[2]) } : undefined;
}

describe('PromptInput cursor anchoring (IME)', () => {
  it('places the terminal cursor after the buffer, counting CJK as 2 cells', async () => {
    const { app, output } = renderInteractive(
      <PromptInput buffer={bufferOf('こんにちは')} focused />,
    );
    await flush();
    // `❯ ` (2) + こんにちは (10) = 12 → 1-based column 13
    expect(lastCursor(output())?.column).toBe(13);
    app.unmount();
  });

  it('follows a caret moved into the middle of the text', async () => {
    // 日本|です — キャレット手前は `日本`（4セル）だけ
    const { app, output } = renderInteractive(
      <PromptInput buffer={bufferOf('日本です', 2)} focused />,
    );
    await flush();
    expect(lastCursor(output())?.column).toBe(7); // 2 (prefix) + 4 + 1-based
    app.unmount();
  });

  it('places the cursor right after the prompt on an empty buffer', async () => {
    const { app, output } = renderInteractive(
      <PromptInput buffer={emptyBuffer()} focused placeholder="hint" />,
    );
    await flush();
    expect(lastCursor(output())?.column).toBe(3);
    app.unmount();
  });

  it('anchors on the caret line of a multi-line buffer', async () => {
    // 2行目末尾にキャレット: 枠 = 上ボーダー + 2行 + 下ボーダー（4行）。
    // 下端からの上移動は 4 - (1 + 1) = 2、列は 2 + width('かな')=4 → 1-based 7。
    const { app, output } = renderInteractive(
      <PromptInput buffer={bufferOf('abc\nかな')} focused />,
    );
    await flush();
    expect(lastCursor(output())).toEqual({ up: 2, column: 7 });
    app.unmount();
  });

  it('follows the caret onto a soft-wrapped row', async () => {
    // 端末 80 桁 → テキスト幅 78。100 文字は 78 + 22 に折り返り、キャレットは 2 行目の
    // 22 文字目（列 = プレフィックス2 + 22 → 1-based 25）。折り返さず truncate して
    // いた頃はここでキャレットが画面外に消えていた。
    const { app, output } = renderInteractive(
      <PromptInput buffer={bufferOf('a'.repeat(100))} focused />,
    );
    await flush();
    expect(lastCursor(output())).toEqual({ up: 2, column: 25 });
    app.unmount();
  });

  it('keeps the cursor hidden when not focused', async () => {
    const { app, output } = renderInteractive(
      <PromptInput buffer={bufferOf('abc')} focused={false} />,
    );
    await flush();
    expect(output()).not.toContain('[?25h');
    app.unmount();
  });
});

describe('PromptInput soft wrapping', () => {
  it('wraps a long line instead of truncating it', async () => {
    // ink-testing-library の端末は 100 桁。200 文字は複数行に折り返り、**全文字**が
    // 描かれる（以前は幅を超えたぶんが `…` で切り捨てられ、何を打ったか読めなかった）。
    const { lastFrame, unmount } = render(
      <PromptInput buffer={bufferOf('a'.repeat(200))} focused={false} />,
    );
    await flush();
    const frame = lastFrame() ?? '';
    expect(frame).not.toContain('…');
    expect((frame.match(/a/g) ?? []).length).toBe(200);
    expect(frame.split('\n').filter((l) => l.includes('aaa')).length).toBeGreaterThan(1);
    unmount();
  });

  it('uses the full available width inside a row-direction parent', async () => {
    // row 方向の親（`PermissionDialog` の 1 行 Box が該当）では Box の幅が**中身の幅**
    // になる。短いテキストを描いたあとの実測値をそのまま折り返し幅にすると、以降は
    // その幅より広がれず（測る→狭い→狭く折り返す→狭いまま）1行に数文字しか入らない。
    // `width: 100%` で幅を中身から切り離しているので、伸びたテキストも1行に収まる。
    const { lastFrame, rerender, unmount } = render(
      <Box>
        <PromptInput buffer={bufferOf('a'.repeat(10))} focused={false} />
      </Box>,
    );
    await flush();
    rerender(
      <Box>
        <PromptInput buffer={bufferOf('a'.repeat(40))} focused={false} />
      </Box>,
    );
    await flush();
    const rows = (lastFrame() ?? '').split('\n').filter((l) => l.includes('aaa'));
    expect(rows.length).toBe(1); // 端末 100 桁なので 40 文字は折り返さない
    unmount();
  });

  it('wraps at word boundaries when there is one', async () => {
    // テキスト幅 98 をまたぐ位置に空白がある → 単語の途中で切らず次の行へ送る。
    const words = `${'x'.repeat(96)} tail`;
    const { lastFrame, unmount } = render(<PromptInput buffer={bufferOf(words)} focused={false} />);
    await flush();
    const rows = (lastFrame() ?? '').split('\n').map((l) => l.trim());
    expect(rows.some((l) => l === 'tail')).toBe(true);
    unmount();
  });
});
