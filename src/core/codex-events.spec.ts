import { describe, expect, it } from 'vitest';
import { toCodexEvent } from '@/core/codex-events';
import { createJsonlSplitter } from '@/core/jsonl';

/**
 * `codex exec` の stdout は行区切りの JSON だが、チャンクは行の途中で切れるし、
 * `command_execution` は出力を丸ごと 1 行で運ぶので巨大にもなる。プロセスの扱いから
 * 切り離した純粋な枠切りをここで固定する（`utils/codex.ts` はこれを呼ぶだけ）。
 */
describe('createJsonlSplitter', () => {
  const big = 1024 * 1024;

  it('emits one value per complete line', () => {
    const s = createJsonlSplitter(big);
    expect(s.push('{"a":1}\n{"a":2}\n')).toEqual([{ a: 1 }, { a: 2 }]);
    expect(s.flush()).toEqual([]);
  });

  it('joins a line split across chunks', () => {
    const s = createJsonlSplitter(big);
    // 1 行が 3 チャンクに割れて届く（実際の stdout ではごく普通）。
    expect(s.push('{"ty')).toEqual([]);
    expect(s.push('pe":"turn.st')).toEqual([]);
    expect(s.push('arted"}\n')).toEqual([{ type: 'turn.started' }]);
  });

  it('emits a trailing line that never got its newline', () => {
    const s = createJsonlSplitter(big);
    expect(s.push('{"a":1}')).toEqual([]);
    // プロセスが改行を出さずに終わっても最後のイベントを取りこぼさない。
    expect(s.flush()).toEqual([{ a: 1 }]);
  });

  it('handles CRLF and blank lines', () => {
    const s = createJsonlSplitter(big);
    expect(s.push('{"a":1}\r\n\n   \n{"a":2}\r\n')).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it('drops lines that are not JSON without killing the stream', () => {
    const s = createJsonlSplitter(big);
    // 想定外の出力が 1 行混ざっても、後続のイベントは流れ続ける。
    expect(s.push('not json\n{"a":1}\n')).toEqual([{ a: 1 }]);
  });

  it('is reusable after flush', () => {
    const s = createJsonlSplitter(big);
    s.push('{"a":1}');
    expect(s.flush()).toEqual([{ a: 1 }]);
    expect(s.flush()).toEqual([]);
  });

  /**
   * 上限超過は**その行だけ**捨てて次の改行から復帰する。溜め切ってから `JSON.parse`
   * するとヒープに 2 部載るため、1 イベントを失うほうを選ぶ（OOM 対策）。
   */
  it('drops an over-long line and resumes at the next newline', () => {
    const s = createJsonlSplitter(32);
    expect(s.push(`{"big":"${'x'.repeat(100)}`)).toEqual([]);
    // 行の残り + 次の行。捨てられるのは長すぎた行だけ。
    expect(s.push('more"}\n{"a":1}\n')).toEqual([{ a: 1 }]);
  });

  it('does not emit an over-long trailing line on flush', () => {
    const s = createJsonlSplitter(8);
    s.push('{"big":"xxxxxxxxxxxxxxxxxxxx');
    expect(s.flush()).toEqual([]);
  });
});

/**
 * 受理ガード。ここを通った行は `parseCodexEvent` が中身を**無条件に**読むので、
 * 欠けたものを通すと TypeError がアダプタの generator を突き抜けてターンごと死ぬ
 * （そのうえ `codex exec` が孤児として残る）。
 */
describe('toCodexEvent', () => {
  it.each([
    [{ type: 'thread.started', thread_id: 'th-1' }],
    [{ type: 'turn.started' }],
    [{ type: 'turn.completed' }],
    [{ type: 'turn.failed', error: { message: 'boom' } }],
    [{ type: 'error', message: 'boom' }],
    [{ type: 'item.completed', item: { id: 'i0', type: 'agent_message', text: 'hi' } }],
    [{ type: 'item.started', item: { id: 'i0', type: 'file_change', changes: [] } }],
    [{ type: 'item.updated', item: { id: 'i0', type: 'todo_list', items: [] } }],
  ])('accepts %j', (value) => {
    expect(toCodexEvent(value)).toBe(value);
  });

  it.each([
    [null],
    [undefined],
    ['a string'],
    [42],
    [{}],
    [{ type: 123 }],
    [{ type: 'unknown.kind' }],
    // 必須フィールドが欠けているもの。
    [{ type: 'thread.started' }],
    [{ type: 'turn.failed' }],
    [{ type: 'turn.failed', error: {} }],
    [{ type: 'error' }],
    [{ type: 'item.completed' }],
    [{ type: 'item.completed', item: {} }],
    // parse 側が無条件に配列として触るフィールドが無いもの。
    [{ type: 'item.started', item: { id: 'i0', type: 'file_change' } }],
    [{ type: 'item.completed', item: { id: 'i0', type: 'todo_list' } }],
  ])('rejects %j', (value) => {
    expect(toCodexEvent(value)).toBeUndefined();
  });
});
