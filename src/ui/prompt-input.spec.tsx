import { EventEmitter } from 'node:events';
import { render as inkRender } from 'ink';
import type { ReactElement } from 'react';
import { describe, expect, it } from 'vitest';
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

/** Last cursor placement column (1-based) from `\x1b[<n>G\x1b[?25h`. */
const ESC = String.fromCharCode(27);

function lastCursorColumn(output: string): number | undefined {
  const cursorShow = new RegExp(`${ESC}\\[(\\d+)G${ESC}\\[\\?25h`, 'g');
  const matches = [...output.matchAll(cursorShow)];
  const last = matches.at(-1);
  return last ? Number(last[1]) : undefined;
}

describe('PromptInput cursor anchoring (IME)', () => {
  it('places the terminal cursor after the buffer, counting CJK as 2 cells', async () => {
    const { app, output } = renderInteractive(<PromptInput value="こんにちは" focused />);
    await flush();
    // `❯ ` (2) + こんにちは (10) = 12 → 1-based column 13
    expect(lastCursorColumn(output())).toBe(13);
    app.unmount();
  });

  it('places the cursor right after the prompt on an empty buffer', async () => {
    const { app, output } = renderInteractive(<PromptInput value="" focused placeholder="hint" />);
    await flush();
    expect(lastCursorColumn(output())).toBe(3);
    app.unmount();
  });

  it('keeps the cursor hidden when not focused', async () => {
    const { app, output } = renderInteractive(<PromptInput value="abc" focused={false} />);
    await flush();
    expect(output()).not.toContain('[?25h');
    app.unmount();
  });
});
