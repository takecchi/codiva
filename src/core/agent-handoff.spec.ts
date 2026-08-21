import { describe, expect, it } from 'vitest';
import {
  attachHandoff,
  fitHandoff,
  handoffInstruction,
  handoffTranscript,
  lastUserInstruction,
  MAX_HANDOFF_FIELD_CHARS,
  MAX_HANDOFF_TRANSCRIPT_BYTES,
  stripHandoff,
} from './agent-handoff';
import { MAX_LOG_ENTRY_CHARS } from './log-buffer';
import type { AgentId, LogEntry } from './types';

const entry = (seq: number, kind: LogEntry['kind'], text: string, agent?: AgentId): LogEntry => ({
  seq,
  kind,
  text,
  ...(agent ? { agent } : {}),
});

/** UTF-8 のバイト長（引き継ぎの予算はこの単位で測る）。 */
const bytes = (text: string): number => new TextEncoder().encode(text).length;

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

  // 会話が無いのに「下に会話を写した」と名乗ると嘘になる（復元に失敗した復元セッション等）。
  it('会話が無いときは「文脈は渡せない」と正直に言う', () => {
    const withoutLog = handoffInstruction({ from: 'Claude', task: 'ログイン画面を作る' });
    expect(withoutLog).toContain('history is NOT available to you');
    expect(withoutLog).not.toContain('Conversation before the switch');

    const withLog = handoffInstruction({
      from: 'Claude',
      task: 'ログイン画面を作る',
      messages: [entry(1, 'user', 'ログイン画面を作る')],
    });
    expect(withLog).toContain('copied the user/assistant conversation below');
    expect(withLog).toContain('Conversation before the switch');
  });

  it('長い指示は 1 行に畳んで切る（概要が会話本体より大きくならないように）', () => {
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

  it('会話が 1 件も無ければ undefined', () => {
    expect(handoffTranscript([])).toBeUndefined();
    // 本文が空白だけの行は「発言」ではないので落とす。
    expect(handoffTranscript([entry(1, 'user', '   \n  ')])).toBeUndefined();
  });

  // 帰属が入るのは**切替後のエージェントの発言だけ**（ユーザーの指示は誰が受けても
  // 「ユーザー」なので `LogEntry.agent` は付かない）。境目はこの印で読める。
  it('切替後のエージェント発言には名前を添える（LogEntry.agent）', () => {
    const text = handoffTranscript([
      entry(1, 'user', '最初の指示'),
      entry(2, 'assistant_text', 'claude の回答'),
      entry(3, 'user', 'codex への指示'),
      entry(4, 'assistant_text', 'codex の回答', 'codex'),
    ]);
    expect(text).toBe(
      'User:\n最初の指示\n\nAssistant:\nclaude の回答\n\nUser:\ncodex への指示\n\nAssistant (codex):\ncodex の回答',
    );
  });

  it('上限を超えたら新しい会話を優先して省略を明示する', () => {
    const text = handoffTranscript([
      entry(1, 'user', 'o'.repeat(MAX_HANDOFF_TRANSCRIPT_BYTES)),
      entry(2, 'assistant_text', 'm'.repeat(MAX_HANDOFF_TRANSCRIPT_BYTES)),
      entry(3, 'user', 'latest'),
    ]);
    expect(text).toContain('Older conversation omitted');
    expect(text).toContain('User:\nlatest');
    expect(text).not.toContain('ooo');
    expect(text).not.toContain('mmm');
  });

  // 予算は **UTF-8 バイト**で測る。文字数で測ると日本語（1 文字 3 バイト）の会話が
  // 実サイズで 3 倍になり、指示文を argv で渡す `codex exec` が Linux の
  // MAX_ARG_STRLEN（131,072 バイト）に当たって起動できなくなる。
  it('日本語でも予算を UTF-8 バイトで守る', () => {
    const messages = Array.from({ length: 40 }, (_, i) =>
      entry(i + 1, i % 2 === 0 ? 'user' : 'assistant_text', 'あ'.repeat(MAX_LOG_ENTRY_CHARS)),
    );
    const text = handoffTranscript(messages);
    expect(text).toBeDefined();
    expect(bytes(text ?? '')).toBeLessThanOrEqual(MAX_HANDOFF_TRANSCRIPT_BYTES);
  });

  // ログの 1 件は MAX_LOG_ENTRY_CHARS で切られている（最悪 3 バイト/文字）。予算が
  // それを上回っている限り「直近の 1 ターンは必ず入る」が保証できる。
  it('直近の 1 ターンは必ず入る（予算 > 1 件の上限）', () => {
    expect(MAX_HANDOFF_TRANSCRIPT_BYTES).toBeGreaterThan(MAX_LOG_ENTRY_CHARS * 3);
    const text = handoffTranscript([
      entry(1, 'user', 'い'.repeat(MAX_LOG_ENTRY_CHARS)),
      entry(2, 'assistant_text', 'あ'.repeat(MAX_LOG_ENTRY_CHARS)),
    ]);
    // 古い方は落ちるが、最大サイズの 1 件でも直近は丸ごと残る。
    expect(text).toContain('Older conversation omitted');
    expect(text).not.toContain('いい');
    expect(text).toContain('あ'.repeat(MAX_LOG_ENTRY_CHARS));
    expect(bytes(text ?? '')).toBeLessThanOrEqual(MAX_HANDOFF_TRANSCRIPT_BYTES);
  });
});

describe('fitHandoff', () => {
  /** 会話をたっぷり載せた引き継ぎ（Codex の argv 上限の検証用）。 */
  const briefing = (): string => {
    const messages = Array.from({ length: 30 }, (_, i) =>
      entry(i + 1, i % 2 === 0 ? 'user' : 'assistant_text', `turn${i} ${'x'.repeat(3000)}`),
    );
    const text = handoffInstruction({ from: 'Claude', branch: 'codiva/t', messages });
    if (!text) {
      throw new Error('fixture');
    }
    return text;
  };

  it('予算に収まっているものはそのまま返す', () => {
    const text = briefing();
    expect(fitHandoff(text, bytes(text))).toBe(text);
  });

  // Codex は systemPrompt（`.codiva/prompt.md` は無制限）とユーザーの指示文まで
  // **同じ argv 1 本**に載せる。合計が MAX_ARG_STRLEN を超えると spawn が E2BIG で
  // 落ち、`thread.started` が来ないので引き継ぎが解除されず**毎ターン落ち続ける**。
  it('予算を超えたら会話の古い側から削って収める', () => {
    const text = briefing();
    const budget = Math.floor(bytes(text) / 2);
    const fitted = fitHandoff(text, budget);
    expect(fitted).toBeDefined();
    expect(bytes(fitted ?? '')).toBeLessThanOrEqual(budget);
    // 見出し・箇条書き・続け方の指示は残す。
    expect(fitted).toContain('# Session handover (codiva)');
    expect(fitted).toContain('- Branch: codiva/t');
    expect(fitted).toContain('inspect the working tree yourself');
    // 直近の会話は残り、古い会話は落ちて省略が明示される。
    expect(fitted).toContain('turn29');
    expect(fitted).not.toContain('turn0 ');
    expect(fitted).toContain('Older conversation omitted');
  });

  it('会話を 1 ターンも載せられなければ諦める（undefined）', () => {
    expect(fitHandoff(briefing(), 100)).toBeUndefined();
  });

  it('会話ブロックの無い引き継ぎは削りようがない（undefined）', () => {
    const text = handoffInstruction({ from: 'Claude', branch: 'codiva/t' });
    expect(text).toBeDefined();
    expect(fitHandoff(text ?? '', 10)).toBeUndefined();
  });
});

describe('attachHandoff / stripHandoff', () => {
  it('引き継ぎが無ければ素通し', () => {
    expect(attachHandoff('やって', undefined)).toBe('やって');
    expect(stripHandoff('やって')).toBe('やって');
  });

  // 引き継ぎは provider にはユーザーメッセージとして届くので、CLI のトランスクリプトにも
  // そう残る。復元でそのまま積むと、詳細ビューにも `lastUserInstruction` にも漏れる。
  it('前置した指示から元の入力だけを取り出せる（復元の入口で使う）', () => {
    const handoff = handoffInstruction({
      from: 'Claude',
      branch: 'codiva/t',
      task: '最初の指示',
      messages: [entry(1, 'user', '最初の指示')],
    });
    const sent = attachHandoff('次はこれ', handoff);
    expect(sent).toContain('# Session handover (codiva)');
    expect(sent.endsWith('# Current instruction after the switch\n\n次はこれ')).toBe(true);
    expect(stripHandoff(sent)).toBe('次はこれ');
    // 剥がしたあとの行は「直前の指示」としても正しく拾える。
    expect(lastUserInstruction([entry(1, 'user', stripHandoff(sent))])).toBe('次はこれ');
  });

  it('見出しで始まらない入力は触らない（ユーザーの本文を削らない）', () => {
    const text = '# Current instruction after the switch\n\nこれは普通の指示';
    expect(stripHandoff(text)).toBe(text);
  });

  // 引き継ぎの本文には会話ログがそのまま入るので、境目の見出しと同じ行が**中に**
  // 現れうる。最初の一致で切ると引き継ぎの残骸がユーザー発言として復元され、
  // それが `lastUserInstruction` に拾われて次の切替で入れ子に写る。
  it('会話ログの中に境目と同じ行があっても、最後の境目で切る', () => {
    const handoff = handoffInstruction({
      from: 'Claude',
      task: '最初の指示',
      messages: [
        entry(1, 'user', '最初の指示'),
        // エージェントが見出しをそのまま書き写した（引用した）ケース。
        entry(
          2,
          'assistant_text',
          'こう書きました:\n\n# Current instruction after the switch\n\nおわり',
        ),
      ],
    });
    const sent = attachHandoff('次はこれ', handoff);
    expect(stripHandoff(sent)).toBe('次はこれ');
  });
});
