import { describe, expect, it } from 'vitest';
import { MAX_LOG_CHARS, SUBAGENT_LOG_LIMITS } from './log-buffer';
import {
  activeSubagents,
  appendSubagentLog,
  findSubagentByRef,
  MAX_TRACKED_SUBAGENTS,
  progressSubagent,
  SUBAGENT_PROMPT_CHARS,
  type SubagentStart,
  sealSubagents,
  settleSubagent,
  startSubagent,
} from './subagents';
import type { LogEntry, SubagentRun } from './types';

const entry = (seq: number, text = `line ${seq}`): LogEntry => ({ seq, kind: 'system', text });

const start = (id: string, over: Partial<SubagentStart> = {}): SubagentStart => ({
  id,
  toolUseId: `tool-${id}`,
  ...over,
});

/** `ids` のサブエージェントを順に起動したリスト。 */
function listOf(...ids: string[]): readonly SubagentRun[] {
  let list: readonly SubagentRun[] | undefined;
  for (const [i, id] of ids.entries()) {
    list = startSubagent(list, start(id), i);
  }
  return list ?? [];
}

const idsOf = (list: readonly SubagentRun[] | undefined): string[] =>
  (list ?? []).map((run) => run.id);

describe('予算', () => {
  // 素朴に配列を N 本増やすと予算が N 倍になる。全本ぶん合計しても親ログの半分に
  // 収まっていることを数値で固定しておく（定数を触ったときにここで気付ける）。
  it('サブエージェント全本ぶんの合計が親ログの予算の半分に収まる', () => {
    expect(MAX_TRACKED_SUBAGENTS * SUBAGENT_LOG_LIMITS.maxChars).toBeLessThanOrEqual(
      MAX_LOG_CHARS / 2,
    );
  });
});

describe('startSubagent', () => {
  it('新しいサブエージェントを末尾に足す（running / 空ログ）', () => {
    const list = startSubagent(undefined, start('a', { description: 'work', kind: 'explore' }), 10);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      id: 'a',
      toolUseId: 'tool-a',
      description: 'work',
      kind: 'explore',
      status: 'running',
      startedAt: 10,
    });
    expect(list[0]?.messages).toEqual([]);
  });

  it('同じ id は増やさない（冪等）', () => {
    const first = startSubagent(undefined, start('a'), 1);
    const again = startSubagent(first, start('a'), 2);
    expect(again).toHaveLength(1);
    // 起動時刻も最初のものを保つ（経過時間が巻き戻らない）。
    expect(again[0]?.startedAt).toBe(1);
  });

  it('2 回目で欠けていたメタだけを埋める', () => {
    const first = startSubagent(undefined, { id: 'a' }, 1);
    const again = startSubagent(first, start('a', { description: 'later', kind: 'general' }), 2);
    expect(again[0]).toMatchObject({ toolUseId: 'tool-a', description: 'later', kind: 'general' });
  });

  it('既存の値を 2 回目の欠落で潰さない（進捗で更新された説明を巻き戻さない）', () => {
    const first = startSubagent(undefined, start('a', { description: 'first' }), 1);
    const progressed = progressSubagent(first, 'a', { description: 'writing' });
    const again = startSubagent(progressed, start('a'), 2);
    expect(again[0]?.description).toBe('writing');
  });

  it('何も変わらなければ同一参照を返す', () => {
    const first = startSubagent(undefined, start('a', { description: 'x' }), 1);
    expect(startSubagent(first, start('a', { description: 'x' }), 2)).toBe(first);
  });

  it('長い prompt は頭だけ残す', () => {
    const list = startSubagent(undefined, start('a', { prompt: 'p'.repeat(9_999) }), 1);
    // clipLogText の印（' …'）が付くので +2。
    expect(list[0]?.prompt).toHaveLength(SUBAGENT_PROMPT_CHARS + 2);
  });

  it('上限を超えたら決着済みのうち最も古いものを落とす', () => {
    let list = listOf(...Array.from({ length: MAX_TRACKED_SUBAGENTS }, (_, i) => `s${i}`));
    // 先頭ではなく 2 番目だけを決着させる → 落ちるのはそれ。
    list = settleSubagent(list, 's1', { outcome: 'completed' }, 100) ?? [];
    list = startSubagent(list, start('new'), 200);
    expect(list).toHaveLength(MAX_TRACKED_SUBAGENTS);
    expect(idsOf(list)).not.toContain('s1');
    expect(idsOf(list)).toContain('s0');
    expect(idsOf(list)).toContain('new');
  });

  it('全部走っているときだけ最古を落とす', () => {
    let list = listOf(...Array.from({ length: MAX_TRACKED_SUBAGENTS }, (_, i) => `s${i}`));
    list = startSubagent(list, start('new'), 200);
    expect(list).toHaveLength(MAX_TRACKED_SUBAGENTS);
    expect(idsOf(list)).not.toContain('s0');
    expect(idsOf(list)).toContain('new');
  });
});

describe('progressSubagent', () => {
  it('記録が無ければ何もしない（進捗を起点に追跡を始めない）', () => {
    expect(progressSubagent(undefined, 'a', { lastTool: 'Write' })).toBeUndefined();
    const list = listOf('a');
    expect(progressSubagent(list, 'unknown', { lastTool: 'Write' })).toBe(list);
  });

  it('説明・直近のツール・使用状況を更新する', () => {
    const list = progressSubagent(listOf('a'), 'a', {
      description: 'Writing report.txt',
      lastTool: 'Write',
      usage: { totalTokens: 10, toolUses: 1 },
    });
    expect(list?.[0]).toMatchObject({
      description: 'Writing report.txt',
      lastTool: 'Write',
      usage: { totalTokens: 10, toolUses: 1 },
    });
  });

  it('使用状況は欠けている項目を保って重ねる', () => {
    let list = progressSubagent(listOf('a'), 'a', { usage: { totalTokens: 10, toolUses: 1 } });
    list = progressSubagent(list, 'a', { usage: { durationMs: 500 } });
    expect(list?.[0]?.usage).toEqual({ totalTokens: 10, toolUses: 1, durationMs: 500 });
  });

  it('同じ値なら同一参照（再描画を増やさない）', () => {
    const list = progressSubagent(listOf('a'), 'a', { lastTool: 'Write' }) ?? [];
    expect(progressSubagent(list, 'a', { lastTool: 'Write' })).toBe(list);
  });

  // 遅れて届いた進捗で「終わったものが実行中に戻る」のを防ぐ。
  it('決着済みの記録は触らない', () => {
    const settled = settleSubagent(listOf('a'), 'a', { outcome: 'completed' }, 50) ?? [];
    expect(progressSubagent(settled, 'a', { lastTool: 'Write' })).toBe(settled);
  });
});

describe('settleSubagent', () => {
  it('決着の内容を書き込む', () => {
    const list = settleSubagent(
      listOf('a'),
      'a',
      { outcome: 'completed', summary: 'done', outputFile: '/tmp/a.output' },
      99,
    );
    expect(list?.[0]).toMatchObject({
      status: 'completed',
      summary: 'done',
      outputFile: '/tmp/a.output',
      finishedAt: 99,
    });
  });

  it('決着のしかたが無ければ stopped（終わったが結果が分からない）', () => {
    const list = settleSubagent(listOf('a'), 'a', {}, 99);
    expect(list?.[0]?.status).toBe('stopped');
  });

  // task_updated と task_notification の 2 経路から届く。
  it('最初の決着が勝ち、後続は欠けた項目だけを埋める', () => {
    let list = settleSubagent(listOf('a'), 'a', { outcome: 'failed' }, 10);
    list = settleSubagent(list, 'a', { outcome: 'completed', summary: 'late' }, 20);
    expect(list?.[0]).toMatchObject({ status: 'failed', summary: 'late', finishedAt: 10 });
  });

  it('誰の決着か分からないときは表示を触らない', () => {
    const list = listOf('a', 'b');
    expect(settleSubagent(list, undefined, { outcome: 'completed' }, 10)).toBe(list);
    expect(settleSubagent(list, 'unknown', { outcome: 'completed' }, 10)).toBe(list);
  });

  it('記録が無ければ undefined のまま', () => {
    expect(settleSubagent(undefined, 'a', { outcome: 'completed' }, 10)).toBeUndefined();
  });
});

describe('sealSubagents', () => {
  it('走っているものだけ stopped にし、記録は残す', () => {
    const list = settleSubagent(listOf('a', 'b'), 'a', { outcome: 'completed' }, 5) ?? [];
    const sealed = sealSubagents(list, 50) ?? [];
    expect(sealed).toHaveLength(2);
    expect(sealed[0]?.status).toBe('completed');
    expect(sealed[1]).toMatchObject({ status: 'stopped', finishedAt: 50 });
  });

  it('決着済みのオブジェクトは同じ参照を維持する', () => {
    const list = settleSubagent(listOf('a'), 'a', { outcome: 'completed' }, 5) ?? [];
    expect(sealSubagents(list, 50)?.[0]).toBe(list[0]);
  });

  it('封じるものが無ければ同一参照', () => {
    const list = settleSubagent(listOf('a'), 'a', { outcome: 'completed' }, 5) ?? [];
    expect(sealSubagents(list, 50)).toBe(list);
    expect(sealSubagents(undefined, 50)).toBeUndefined();
  });
});

describe('findSubagentByRef / appendSubagentLog', () => {
  it('帰属キーで引ける', () => {
    expect(findSubagentByRef(listOf('a', 'b'), 'tool-b')?.id).toBe('b');
    expect(findSubagentByRef(listOf('a'), 'nope')).toBeUndefined();
    expect(findSubagentByRef(undefined, 'tool-a')).toBeUndefined();
  });

  // 呼び側の契約: undefined なら親ログへ落とす（= 行を捨てない）。
  it('帰属先が引けなければ undefined を返す', () => {
    expect(appendSubagentLog(listOf('a'), 'unknown', entry(1))).toBeUndefined();
    expect(appendSubagentLog(undefined, 'tool-a', entry(1))).toBeUndefined();
  });

  it('専用ログへ積む（他のサブエージェントには触らない）', () => {
    const list = listOf('a', 'b');
    const next = appendSubagentLog(list, 'tool-a', entry(1, 'hello')) ?? [];
    expect(next[0]?.messages.map((e) => e.text)).toEqual(['hello']);
    expect(next[1]?.messages).toEqual([]);
    // 元のリストは変えない（immutable）。
    expect(list[0]?.messages).toEqual([]);
  });

  it('専用ログの予算で古い行が落ちる', () => {
    let list: readonly SubagentRun[] | undefined = listOf('a');
    for (let i = 1; i <= SUBAGENT_LOG_LIMITS.maxEntries + 20; i += 1) {
      list = appendSubagentLog(list, 'tool-a', entry(i, 'x'));
    }
    const messages = list?.[0]?.messages ?? [];
    expect(messages.length).toBeLessThanOrEqual(SUBAGENT_LOG_LIMITS.maxEntries);
    expect(messages.at(-1)?.seq).toBe(SUBAGENT_LOG_LIMITS.maxEntries + 20);
  });
});

describe('activeSubagents', () => {
  it('走っているものだけを返す（★完了ゲートではない）', () => {
    const list = settleSubagent(listOf('a', 'b', 'c'), 'b', { outcome: 'completed' }, 5) ?? [];
    expect(idsOf(activeSubagents(list))).toEqual(['a', 'c']);
    expect(activeSubagents(undefined)).toEqual([]);
  });
});
