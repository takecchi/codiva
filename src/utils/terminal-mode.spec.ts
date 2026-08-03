import { describe, expect, it } from 'vitest';
import { resetTerminalModes, wrapForTmux } from './terminal-mode';

function fakeStream(): { writes: string[]; stream: { write(text: string): void } } {
  const writes: string[] = [];
  return { writes, stream: { write: (text: string) => writes.push(text) } };
}

describe('resetTerminalModes', () => {
  it('マウス捕捉・bracketed paste・カーソル・alt screen をまとめて戻す', () => {
    const { writes, stream } = fakeStream();
    resetTerminalModes(stream);
    const written = writes.join('');
    // 強制終了で残り得るモードを全部消す（スクロールが文字入力に化ける原因）。
    for (const mode of ['?1000l', '?1002l', '?1003l', '?1006l', '?1015l']) {
      expect(written).toContain(mode);
    }
    expect(written).toContain('?2004l'); // bracketed paste
    expect(written).toContain('?25h'); // カーソル表示
    expect(written).toContain('?1049l'); // alt screen 退出
  });

  it('1 回の write で送る（部分適用で終わらないように）', () => {
    const { writes, stream } = fakeStream();
    resetTerminalModes(stream);
    expect(writes).toHaveLength(1);
  });
});

describe('wrapForTmux', () => {
  it('DCS パススルーで包み、内側の ESC を二重化する', () => {
    expect(wrapForTmux('\x1b]52;c;AA\x07')).toBe('\x1bPtmux;\x1b\x1b]52;c;AA\x07\x1b\\');
  });
});
