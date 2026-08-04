import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MAX_LOG_ENTRIES, MAX_LOG_ENTRY_CHARS } from './log-buffer';
import { transcriptLogEntries, transcriptProjectDir } from './transcript';

// Real transcript lines collected from ~/.claude/projects/ (Phase 1 rule:
// test against captured data, not imagined message shapes).
const fixture = readFileSync(
  fileURLToPath(new URL('./__fixtures__/transcript-restore.jsonl', import.meta.url)),
  'utf8',
);

describe('transcriptProjectDir', () => {
  it('munges every non-alphanumeric character to "-" (matches real CLI dirs)', () => {
    expect(
      transcriptProjectDir('/Users/takecchi/RustroverProjects/codiva/.codiva/worktrees/pr-2'),
    ).toBe('-Users-takecchi-RustroverProjects-codiva--codiva-worktrees-pr-2');
  });

  it('also folds dots and underscores', () => {
    expect(transcriptProjectDir('/tmp/my_app.v2')).toBe('-tmp-my-app-v2');
  });
});

describe('transcriptLogEntries (real fixture)', () => {
  const entries = transcriptLogEntries(fixture);

  it('rebuilds the visible conversation: user → assistant → tool_use → tool_result', () => {
    expect(entries.map((e) => e.kind)).toEqual([
      'user',
      'assistant_text',
      'tool_use',
      'tool_result',
    ]);
  });

  it('numbers entries seq 1..n like the live reducer', () => {
    expect(entries.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
  });

  it('keeps the user prompt text', () => {
    expect(entries[0]?.text).toContain('現在何のモデルを使う設定になっているのか');
  });

  it('summarizes tool_use blocks the same way as the live log', () => {
    expect(entries[2]?.text).toMatch(/^Bash git status/);
  });

  it('summarizes tool_result to its first line, capped at 200 chars', () => {
    expect(entries[3]?.text).toBe('On branch codiva/pr-2');
  });

  it('parses ISO timestamps to epoch millis', () => {
    expect(entries[3]?.timestamp).toBe(Date.parse('2026-07-19T07:31:40.788Z'));
  });

  it('skips thinking blocks and non-message records (queue-operation, attachment, ai-title, …)', () => {
    // The fixture contains 10 lines; only the 4 visible entries survive.
    expect(entries).toHaveLength(4);
  });
});

describe('transcriptLogEntries (edge cases)', () => {
  it('skips meta and sidechain lines', () => {
    const jsonl = [
      JSON.stringify({ type: 'user', isMeta: true, message: { role: 'user', content: 'meta' } }),
      JSON.stringify({
        type: 'assistant',
        isSidechain: true,
        message: { content: [{ type: 'text', text: 'side' }] },
      }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'real' } }),
    ].join('\n');
    expect(transcriptLogEntries(jsonl)).toEqual([{ seq: 1, kind: 'user', text: 'real' }]);
  });

  it('ignores malformed lines instead of throwing', () => {
    const jsonl = ['not json', '42', '"str"', '', '{}'].join('\n');
    expect(transcriptLogEntries(jsonl)).toEqual([]);
  });

  it('handles typed user text blocks (follow-up turns)', () => {
    const jsonl = JSON.stringify({
      type: 'user',
      timestamp: '2026-07-19T00:00:00.000Z',
      message: { role: 'user', content: [{ type: 'text', text: '  follow-up  ' }] },
    });
    expect(transcriptLogEntries(jsonl)).toEqual([
      {
        seq: 1,
        kind: 'user',
        text: 'follow-up',
        timestamp: Date.parse('2026-07-19T00:00:00.000Z'),
      },
    ]);
  });

  it('drops empty text and empty tool_result content', () => {
    const jsonl = [
      JSON.stringify({ type: 'user', message: { content: '   ' } }),
      JSON.stringify({
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'x', content: '' }] },
      }),
    ].join('\n');
    expect(transcriptLogEntries(jsonl)).toEqual([]);
  });

  // 長寿セッションのトランスクリプトは数 MB あり、復元時にそれを丸ごとヒープへ戻していた。
  it('keeps only the newest MAX_LOG_ENTRIES entries (seq は振り直さない)', () => {
    const jsonl = Array.from({ length: MAX_LOG_ENTRIES + 5 }, (_, i) =>
      JSON.stringify({ type: 'user', message: { role: 'user', content: `line ${i}` } }),
    ).join('\n');
    const entries = transcriptLogEntries(jsonl);
    expect(entries).toHaveLength(MAX_LOG_ENTRIES);
    expect(entries.at(-1)).toMatchObject({
      seq: MAX_LOG_ENTRIES + 5,
      text: `line ${MAX_LOG_ENTRIES + 4}`,
    });
    expect(entries[0]?.seq).toBe(6);
  });

  it('trims while reading (巨大なトランスクリプトを丸ごと積まない)', () => {
    // 上限の 3 倍のラインを流し込む。読み終えてから捨てるのではなく読みながら畳むので、
    // 途中の保持量も上限（の 2 倍）で止まる。
    const lines = MAX_LOG_ENTRIES * 3;
    const jsonl = Array.from({ length: lines }, (_, i) =>
      JSON.stringify({ type: 'user', message: { role: 'user', content: `line ${i}` } }),
    ).join('\n');
    const entries = transcriptLogEntries(jsonl);
    expect(entries).toHaveLength(MAX_LOG_ENTRIES);
    expect(entries.at(-1)).toMatchObject({ seq: lines, text: `line ${lines - 1}` });
  });

  it('clips an oversized restored entry', () => {
    const jsonl = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: 'p'.repeat(MAX_LOG_ENTRY_CHARS + 100) },
    });
    expect(transcriptLogEntries(jsonl)[0]?.text.endsWith('…')).toBe(true);
  });
});
