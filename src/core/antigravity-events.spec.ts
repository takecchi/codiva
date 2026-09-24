import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { antigravityConversationId, toAntigravityEvent } from '@/core/antigravity-events';

/**
 * 受理ガードの番人。ここを通った行は `antigravity-parse.ts` が中身を読むので、
 * 欠けたものを通すと TypeError がターンごと突き抜ける。
 *
 * **フィクスチャの出所**（規約: `.claude/rules/sdk-integration.md`）:
 * - `antigravity-autherror.jsonl` … **実バイナリから採取**（agy 1.2.10 を未サインインで
 *   `--input-format=stream-json --output-format=stream-json` 実行して得た 1 行）。
 * - `antigravity-basic.jsonl` / `antigravity-shell.jsonl` … **公式ドキュメントの
 *   stream-json スキーマから構成**。実セッションの採取には Google アカウントの
 *   サインインが必要なため未採取。実採取した `result` 行が公式スキーマと
 *   フィールド単位で完全一致したことが、この形を採った根拠（`docs/TECH_NOTES.md`）。
 *   **実データを採れたら差し替える。**
 */
function loadRaw(name: string): unknown[] {
  const path = fileURLToPath(new URL(`./__fixtures__/${name}`, import.meta.url));
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as unknown);
}

function fixtureNames(): string[] {
  const dir = fileURLToPath(new URL('./__fixtures__/', import.meta.url));
  return readdirSync(dir)
    .filter((n) => n.startsWith('antigravity-') && n.endsWith('.jsonl'))
    .sort();
}

describe('toAntigravityEvent', () => {
  it('フィクスチャに 3 種類のイベントが揃っている（形の網羅を固定する）', () => {
    const kinds = new Set(
      fixtureNames().flatMap((name) =>
        loadRaw(name)
          .map((line) => toAntigravityEvent(line)?.event)
          .filter(Boolean),
      ),
    );
    expect([...kinds].sort()).toEqual(['init', 'result', 'step_update']);
  });

  it.each(fixtureNames())('%s の全行を受理する', (name) => {
    for (const line of loadRaw(name)) {
      expect(toAntigravityEvent(line)).toBeDefined();
    }
  });

  it('未サインインの実採取行を result として読む', () => {
    const [line] = loadRaw('antigravity-autherror.jsonl');
    const event = toAntigravityEvent(line);
    expect(event?.event).toBe('result');
    if (event?.event !== 'result') {
      throw new Error('unreachable');
    }
    expect(event.result?.status).toBe('ERROR');
    expect(event.result?.error).toBe('authentication failed or timed out');
    // 会話 id は空文字で来る = id ではないので undefined へ丸める。
    expect(antigravityConversationId(event)).toBeUndefined();
  });

  it('ツール実行の step から名前・入力・出力を読む', () => {
    const events = loadRaw('antigravity-shell.jsonl')
      .map(toAntigravityEvent)
      .filter((e) => e?.event === 'step_update');
    const tool = events.find((e) => e?.event === 'step_update' && e.step_update?.tool_name);
    if (tool?.event !== 'step_update') {
      throw new Error('fixture carries no tool step');
    }
    expect(tool.step_update?.tool_name).toBe('run_command');
    expect(tool.step_update?.tool_info?.parameters).toEqual({ CommandLine: 'echo hello' });
  });

  const rejected: [string, unknown][] = [
    ['非オブジェクト', 'nope'],
    ['null', null],
    ['配列', [1, 2]],
    ['event なし', { result: {} }],
    ['未知の event', { event: 'telemetry', telemetry: {} }],
  ];
  it.each(rejected)('%s は捨てる', (_label, raw) => {
    expect(toAntigravityEvent(raw)).toBeUndefined();
  });

  const malformed: [string, unknown][] = [
    ['init の中身が無い', { event: 'init' }],
    ['step_update の中身が無い', { event: 'step_update' }],
    ['result の中身が無い', { event: 'result' }],
    ['入れ子が別の型', { event: 'result', result: 'boom' }],
    ['数値であるべき場所が文字列', { event: 'step_update', step_update: { step_index: 'x' } }],
  ];
  it.each(malformed)('%s でも throw せず受理する', (_label, raw) => {
    expect(() => toAntigravityEvent(raw)).not.toThrow();
    expect(toAntigravityEvent(raw)).toBeDefined();
  });
});

describe('antigravityConversationId', () => {
  it('入れ子の id を優先し、無ければ外側を読む', () => {
    const nested = toAntigravityEvent({
      event: 'step_update',
      conversation_id: 'outer',
      step_update: { conversation_id: 'inner' },
    });
    expect(nested && antigravityConversationId(nested)).toBe('inner');

    const outer = toAntigravityEvent({ event: 'init', conversation_id: 'outer', init: {} });
    expect(outer && antigravityConversationId(outer)).toBe('outer');
  });

  it('空文字は id として扱わない', () => {
    const event = toAntigravityEvent({ event: 'init', conversation_id: '', init: {} });
    expect(event && antigravityConversationId(event)).toBeUndefined();
  });
});
