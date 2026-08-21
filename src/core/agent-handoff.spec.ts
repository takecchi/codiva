import { describe, expect, it } from 'vitest';
import {
  handoffInstruction,
  handoffTranscript,
  lastUserInstruction,
  MAX_HANDOFF_FIELD_CHARS,
  MAX_HANDOFF_TRANSCRIPT_CHARS,
} from './agent-handoff';
import type { LogEntry } from './types';

const entry = (seq: number, kind: LogEntry['kind'], text: string): LogEntry => ({
  seq,
  kind,
  text,
});

describe('lastUserInstruction', () => {
  it('最後のユーザー行を返す', () => {
    const messages = [
      entry(1, 'user', 'まず調べて'),
      entry(2, 'assistant_text', '調べました'),
      entry(3, 'user', '次はテストを書いて'),
      entry(4, 'tool_use', 'Edit(src/a.ts)'),
    ];
    expect(lastUserInstruction(messages)).toBe('次はテストを書いて');
  });

  it('ユーザー行が無ければ undefined', () => {
    expect(lastUserInstruction([entry(1, 'system', 'started')])).toBeUndefined();
    expect(lastUserInstruction([])).toBeUndefined();
  });
});

describe('handoffInstruction', () => {
  it('材料が無ければ何も足さない', () => {
    expect(handoffInstruction({ from: 'Claude' })).toBeUndefined();
    expect(handoffInstruction({ from: 'Claude', task: '   ', branch: '' })).toBeUndefined();
  });

  it('引き継ぎ元・ブランチ・指示を載せる', () => {
    const text = handoffInstruction({
      from: 'Claude',
      branch: 'codiva/add-login',
      task: 'ログイン画面を作る',
      lastInstruction: 'テストも書いて',
      messages: [
        entry(1, 'user', 'HogeHoge'),
        entry(2, 'assistant_text', 'HogeHoge への回答'),
        entry(3, 'user', 'FugaFuga'),
        entry(4, 'assistant_text', 'FugaFuga への回答'),
      ],
    });
    expect(text).toContain('taking over this session from Claude');
    expect(text).toContain('- Branch: codiva/add-login');
    expect(text).toContain('- Original task: ログイン画面を作る');
    expect(text).toContain('- Most recent instruction: テストも書いて');
    expect(text).toContain('User:\nHogeHoge');
    expect(text).toContain('Assistant:\nHogeHoge への回答');
    expect(text).toContain('User:\nFugaFuga');
    expect(text).toContain('Assistant:\nFugaFuga への回答');
    // 作業ツリーを自分で確かめてから続けさせる（要約を信じさせない）。
    expect(text).toContain('git status');
  });

  it('直前の指示が最初の指示と同じなら重ねない', () => {
    const text = handoffInstruction({
      from: 'Codex',
      task: 'ログイン画面を作る',
      lastInstruction: 'ログイン画面を作る',
    });
    expect(text).toContain('- Original task: ログイン画面を作る');
    expect(text).not.toContain('Most recent instruction');
  });

  it('長い指示は 1 行に畳んで切る（systemPrompt が本文より大きくならないように）', () => {
    const text = handoffInstruction({
      from: 'Claude',
      task: `${'あ'.repeat(MAX_HANDOFF_FIELD_CHARS + 50)}`,
      lastInstruction: '複数\n行の\n指示',
    });
    expect(text).toContain(`- Original task: ${'あ'.repeat(MAX_HANDOFF_FIELD_CHARS)}…`);
    expect(text).toContain('- Most recent instruction: 複数 行の 指示');
  });
});

describe('handoffTranscript', () => {
  it('会話以外のログ行を含めない', () => {
    const text = handoffTranscript([
      entry(1, 'user', '依頼'),
      entry(2, 'tool_use', 'Bash(git status)'),
      entry(3, 'tool_result', 'large output'),
      entry(4, 'assistant_text', '回答'),
      entry(5, 'system', 'completed'),
    ]);
    expect(text).toBe('User:\n依頼\n\nAssistant:\n回答');
  });

  it('上限を超えたら新しい会話を優先して省略を明示する', () => {
    const text = handoffTranscript([
      entry(1, 'user', 'old'.repeat(MAX_HANDOFF_TRANSCRIPT_CHARS / 3)),
      entry(2, 'assistant_text', 'middle'.repeat(MAX_HANDOFF_TRANSCRIPT_CHARS / 3)),
      entry(3, 'user', 'latest'),
    ]);
    expect(text).toContain('Earlier conversation omitted');
    expect(text).toContain('User:\nlatest');
    expect(text).not.toContain('oldoldold');
  });
});
