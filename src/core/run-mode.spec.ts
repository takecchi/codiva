import { describe, expect, it } from 'vitest';
import { createModePolicy, type RunMode } from './run-mode';

describe('createModePolicy', () => {
  it('always escalates AskUserQuestion regardless of mode', () => {
    expect(createModePolicy(() => 'auto')('AskUserQuestion', {})).toBe('ask');
    expect(createModePolicy(() => 'confirm')('AskUserQuestion', {})).toBe('ask');
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
