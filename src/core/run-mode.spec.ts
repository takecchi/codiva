import { describe, expect, it } from 'vitest';
import { createModePolicy, nextRunMode, type RunMode } from './run-mode';

describe('createModePolicy', () => {
  it('always escalates AskUserQuestion regardless of mode', () => {
    expect(createModePolicy(() => 'auto')('AskUserQuestion', {})).toBe('ask');
    expect(createModePolicy(() => 'smart')('AskUserQuestion', {})).toBe('ask');
    expect(createModePolicy(() => 'confirm')('AskUserQuestion', {})).toBe('ask');
  });

  // `smart` は**同期では決めない**。ネットワーク I/O を伴う判定を同期ポリシーに
  // 押し込むと全 provider の経路が async 化するので、保留の値を返して
  // `Session` が非同期の評価器へ降りる。
  it('defers to the async evaluator in smart mode', () => {
    expect(createModePolicy(() => 'smart')('Bash', { command: 'rm -rf /' })).toBe('evaluate');
    // 質問だけは保留せず必ず上げる（上のテストと対）。
    expect(createModePolicy(() => 'smart')('whatever', {}, 'question')).toBe('ask');
  });

  // 質問の見分けは**種別**（アダプタが正規化した `kind`）で行う。ツール名は provider
  // ごとに違い、Claude の `AskUserQuestion` だけを見ていたので Grok の
  // `_x.ai/ask_user_question` は既定（auto）モードで自動 allow され、**空の回答で
  // 「承諾した」と返して質問が一度もダイアログに出ていなかった**。
  it('escalates any question kind, whatever the provider calls the tool', () => {
    expect(createModePolicy(() => 'auto')('ask_user_question', {}, 'question')).toBe('ask');
    expect(createModePolicy(() => 'auto')('whatever', {}, 'question')).toBe('ask');
    // ツール実行の許可はモードどおり。
    expect(createModePolicy(() => 'auto')('ask_user_question', {}, 'tool')).toBe('allow');
  });

  it('auto-allows other tools in auto mode, asks in confirm mode', () => {
    expect(createModePolicy(() => 'auto')('Bash', {})).toBe('allow');
    expect(createModePolicy(() => 'confirm')('Bash', {})).toBe('ask');
  });

  it('reads the mode live at call time (toggles affect running sessions)', () => {
    let mode: RunMode = 'auto';
    const policy = createModePolicy(() => mode);
    expect(policy('Write', {})).toBe('allow');
    mode = 'confirm';
    expect(policy('Write', {})).toBe('ask');
  });
});

describe('nextRunMode', () => {
  // 評価器が配線されていないユーザーには `smart` が**輪に入らない**
  // （issue #139「Jev 未設定時は現在の挙動を変えない」）。
  it.each<[RunMode, boolean, RunMode]>([
    ['auto', false, 'confirm'],
    ['confirm', false, 'auto'],
    ['auto', true, 'smart'],
    ['smart', true, 'confirm'],
    ['confirm', true, 'auto'],
    // 評価器を外して再起動しても輪から抜けられる（宙に浮かせない）。
    ['smart', false, 'confirm'],
  ])('%s + smartAvailable=%s -> %s', (mode, available, expected) => {
    expect(nextRunMode(mode, available)).toBe(expected);
  });

  it('returns to the starting mode after a full cycle', () => {
    let mode: RunMode = 'auto';
    for (let i = 0; i < 3; i += 1) {
      mode = nextRunMode(mode, true);
    }
    expect(mode).toBe('auto');
  });
});
