import { EventEmitter } from 'node:events';
import { render as inkRender } from 'ink';
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

  it('keeps the cursor hidden when not focused', async () => {
    const { app, output } = renderInteractive(
      <PromptInput buffer={bufferOf('abc')} focused={false} />,
    );
    await flush();
    expect(output()).not.toContain('[?25h');
    app.unmount();
  });
});
