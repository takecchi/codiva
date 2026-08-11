import { describe, expect, it } from 'vitest';
import {
  codexRolloutModel,
  codexRolloutModelFromText,
  isCodexRolloutFile,
} from '@/core/codex-rollout';

const THREAD = '019ff155-b5c3-7380-87f1-02c13d2a66d4';

describe('isCodexRolloutFile', () => {
  it.each([
    // 実測のファイル名（codex-cli 0.147.0）。
    [`rollout-2026-08-11T23-59-13-${THREAD}.jsonl`, THREAD, true],
    // 別スレッドのファイル。
    ['rollout-2026-08-11T23-57-20-019ff153-f9a0-7083-8a9f-d909f5d73d2a.jsonl', THREAD, false],
    // id が接尾辞になっているだけ（区切りの `-` が無い）ものは拾わない。
    [`rollout-2026-08-11T23-59-13-x${THREAD}.jsonl`, THREAD, false],
    // rollout 以外のファイル。
    [`${THREAD}.jsonl`, THREAD, false],
    [`rollout-2026-08-11T23-59-13-${THREAD}.json`, THREAD, false],
    // 空の thread id で全部にマッチさせない。
    [`rollout-2026-08-11T23-59-13-${THREAD}.jsonl`, '', false],
  ])('%s for %s → %s', (name, threadId, expected) => {
    expect(isCodexRolloutFile(name, threadId)).toBe(expected);
  });
});

describe('codexRolloutModel', () => {
  it('reads turn_context.model (the only place the resolved model appears)', () => {
    expect(
      codexRolloutModel({
        type: 'turn_context',
        payload: { turn_id: 't1', cwd: '/tmp/wt', model: 'gpt-5.6-sol' },
      }),
    ).toBe('gpt-5.6-sol');
  });

  it.each([
    [
      'session_meta は model_provider しか持たない',
      { type: 'session_meta', payload: { model_provider: 'openai' } },
    ],
    ['他の行', { type: 'response_item', payload: { model: 'gpt-5.6-sol' } }],
    ['payload なし', { type: 'turn_context' }],
    ['model が文字列でない', { type: 'turn_context', payload: { model: 42 } }],
    ['model が空', { type: 'turn_context', payload: { model: '  ' } }],
    ['オブジェクトでない', 'turn_context'],
    ['null', null],
  ])('%s → undefined', (_label, value) => {
    expect(codexRolloutModel(value)).toBeUndefined();
  });
});

describe('codexRolloutModelFromText', () => {
  it('finds the model in a rollout head (session_meta first, turn_context after)', () => {
    const text = [
      JSON.stringify({ type: 'session_meta', payload: { model_provider: 'openai' } }),
      JSON.stringify({ type: 'event_msg', payload: { model_context_window: 258400 } }),
      JSON.stringify({ type: 'world_state', payload: {} }),
      JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.6-sol' } }),
      '',
    ].join('\n');
    expect(codexRolloutModelFromText(text)).toBe('gpt-5.6-sol');
  });

  it('prefers the last turn_context (resume appends further turns)', () => {
    const text = [
      JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.4-mini' } }),
      JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.6-sol' } }),
    ].join('\n');
    expect(codexRolloutModelFromText(text)).toBe('gpt-5.6-sol');
  });

  it('ignores a final line truncated by the read cap', () => {
    const text = [
      JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.6-sol' } }),
      '{"type":"response_item","payload":{"content":"cut off here',
    ].join('\n');
    expect(codexRolloutModelFromText(text)).toBe('gpt-5.6-sol');
  });

  it('returns undefined when no turn_context was read', () => {
    const text = JSON.stringify({ type: 'session_meta', payload: { model_provider: 'openai' } });
    expect(codexRolloutModelFromText(text)).toBeUndefined();
    expect(codexRolloutModelFromText('')).toBeUndefined();
  });
});
