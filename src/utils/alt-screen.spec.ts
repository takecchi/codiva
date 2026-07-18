import { describe, expect, it } from 'vitest';
import { enterAltScreen } from './alt-screen';

const ENTER = '\x1b[?1049h';
const LEAVE = '\x1b[?1049l';

function fakeStream(): { writes: string[]; stream: { write(text: string): void } } {
  const writes: string[] = [];
  return { writes, stream: { write: (text: string) => writes.push(text) } };
}

describe('enterAltScreen', () => {
  it('enter で ?1049h を書き、leave で ?1049l を書く', () => {
    const { writes, stream } = fakeStream();
    const leave = enterAltScreen(stream);
    expect(writes).toEqual([ENTER]);
    leave();
    expect(writes).toEqual([ENTER, LEAVE]);
  });

  it('leave は冪等（2回呼んでも ?1049l は1回だけ）', () => {
    const { writes, stream } = fakeStream();
    const leave = enterAltScreen(stream);
    leave();
    leave();
    expect(writes).toEqual([ENTER, LEAVE]);
  });

  it('クラッシュ保険の exit フックを登録し、leave で解除する', () => {
    const before = process.listenerCount('exit');
    const { stream } = fakeStream();
    const leave = enterAltScreen(stream);
    expect(process.listenerCount('exit')).toBe(before + 1);
    leave();
    expect(process.listenerCount('exit')).toBe(before);
  });

  it('process の exit イベントで leave される（明示 leave を忘れても復元）', () => {
    const { writes, stream } = fakeStream();
    enterAltScreen(stream);
    process.emit('exit', 0);
    expect(writes).toEqual([ENTER, LEAVE]);
    // exit フック経由でも解除・冪等化されている
    process.emit('exit', 0);
    expect(writes).toEqual([ENTER, LEAVE]);
  });
});
