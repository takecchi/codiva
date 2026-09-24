import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '@/core/agent-events';
import { toAntigravityEvent } from '@/core/antigravity-events';
import { antigravityToolKind, createAntigravityParser } from '@/core/antigravity-parse';

/**
 * `createAntigravityParser` をフィクスチャで駆動する。フィクスチャの出所と
 * 「どれが実採取でどれが公式スキーマ由来か」は `antigravity-events.spec.ts` の
 * ヘッダに書いてある。
 */
function replay(name: string): AgentEvent[] {
  const path = fileURLToPath(new URL(`./__fixtures__/${name}`, import.meta.url));
  const parser = createAntigravityParser();
  const out: AgentEvent[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n').filter(Boolean)) {
    const event = toAntigravityEvent(JSON.parse(line) as unknown);
    if (event) {
      out.push(...parser.parse(event));
    }
  }
  out.push(...parser.flush());
  return out;
}

function pick<K extends AgentEvent['kind']>(
  events: readonly AgentEvent[],
  kind: K,
): Extract<AgentEvent, { kind: K }>[] {
  return events.filter((e): e is Extract<AgentEvent, { kind: K }> => e.kind === kind);
}

describe('createAntigravityParser over fixtures', () => {
  it('init から resume 用の会話 id を出す', () => {
    const started = pick(replay('antigravity-basic.jsonl'), 'session_started');
    expect(started).toHaveLength(1);
    expect(started[0]?.sessionId).toBe('055a398f-db14-4c5f-abbb-1bf03f8120a7');
    // `--model` 未指定なら空文字で来る = モデル名ではないので出さない。
    expect(started[0]?.model).toBeUndefined();
  });

  it('init が model を運ぶときは載せる', () => {
    const started = pick(replay('antigravity-shell.jsonl'), 'session_started');
    expect(started[0]?.model).toBe('gemini-3-pro');
  });

  it('text_delta を積んで確定した本文を 1 件の assistant_text にする', () => {
    const events = replay('antigravity-basic.jsonl');
    expect(pick(events, 'stream_text').map((e) => e.text)).toEqual(['Hello', ', world']);
    const texts = pick(events, 'assistant_text');
    expect(texts).toHaveLength(1);
    expect(texts[0]?.text).toBe('Hello, world');
  });

  it('最初の delta の前に stream_reset と assistant_message を出す', () => {
    const events = replay('antigravity-basic.jsonl');
    const reset = events.findIndex((e) => e.kind === 'stream_reset');
    const message = events.findIndex((e) => e.kind === 'assistant_message');
    const firstDelta = events.findIndex((e) => e.kind === 'stream_text');
    expect(reset).toBeGreaterThanOrEqual(0);
    expect(reset).toBeLessThan(firstDelta);
    expect(message).toBeLessThan(firstDelta);
  });

  it('本文を既に積んだターンでは turn_completed に本文を二重に載せない', () => {
    const completed = pick(replay('antigravity-basic.jsonl'), 'turn_completed');
    expect(completed).toHaveLength(1);
    expect(completed[0]?.text).toBe('');
  });

  it('user_input / checkpoint の step はログに出さない', () => {
    // `antigravity-basic.jsonl` の step 0 は user_input。ツール行も本文行も生まない。
    const events = replay('antigravity-basic.jsonl');
    expect(pick(events, 'tool_use')).toHaveLength(0);
  });

  it('ツールの ACTIVE / DONE を tool_use ↔ tool_result の 2 段組みへ割る', () => {
    const events = replay('antigravity-shell.jsonl');
    const uses = pick(events, 'tool_use');
    const results = pick(events, 'tool_result');
    expect(uses.map((e) => [e.tool, e.summary])).toEqual([
      ['shell', '$ echo hello'],
      ['read', 'view_file /tmp/repo/README.md'],
    ]);
    // id が対応していないと畳み込み（log-collapse / pr-detect）が崩れる。
    expect(results.map((e) => e.toolUseId)).toEqual(uses.map((e) => e.id));
    expect(results[0]?.summary).toBe('hello');
  });

  it('未サインインの実採取行を auth の turn_stopped にする', () => {
    const stopped = pick(replay('antigravity-autherror.jsonl'), 'turn_stopped');
    expect(stopped).toHaveLength(1);
    expect(stopped[0]?.cause).toBe('auth');
    expect(stopped[0]?.detail).toBe('authentication failed or timed out');
  });
});

describe('createAntigravityParser streaming invariants', () => {
  const init = { event: 'init', conversation_id: 'c1', init: {} };
  const step = (over: Record<string, unknown>) => ({
    event: 'step_update',
    conversation_id: 'c1',
    step_update: over,
  });
  const result = (over: Record<string, unknown>) => ({
    event: 'result',
    result: { conversation_id: 'c1', ...over },
  });

  const run = (lines: readonly unknown[], andFlush = true): AgentEvent[] => {
    const parser = createAntigravityParser();
    const out: AgentEvent[] = [];
    for (const line of lines) {
      const event = toAntigravityEvent(line);
      if (event) {
        out.push(...parser.parse(event));
      }
    }
    if (andFlush) {
      out.push(...parser.flush());
    }
    return out;
  };

  it('DONE を貰えないまま終わった本文を flush で確定する', () => {
    const events = run([
      init,
      step({ step_index: 1, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'partial' }),
    ]);
    expect(pick(events, 'assistant_text').map((e) => e.text)).toEqual(['partial']);
  });

  it('開いたままのツールを flush で閉じる（対応の取れない tool_use を残さない）', () => {
    const events = run([
      init,
      step({ step_index: 1, state: 'ACTIVE', step_type: 'tool', tool_name: 'run_command' }),
    ]);
    expect(pick(events, 'tool_use')).toHaveLength(1);
    expect(pick(events, 'tool_result')).toHaveLength(1);
  });

  it('同じ step の ACTIVE が複数回来ても tool_use は 1 回だけ', () => {
    const active = step({
      step_index: 1,
      state: 'ACTIVE',
      step_type: 'tool',
      tool_name: 'view_file',
    });
    const events = run([init, active, active, active]);
    expect(pick(events, 'tool_use')).toHaveLength(1);
  });

  it('DONE が複数回来ても決着は 1 回だけ', () => {
    const done = step({
      step_index: 1,
      state: 'DONE',
      step_type: 'tool',
      tool_name: 'run_command',
      tool_info: { name: 'run_command', output: 'ok' },
    });
    const events = run([init, done, done]);
    expect(pick(events, 'tool_result')).toHaveLength(1);
  });

  it('知らない state は ACTIVE 側に倒す（早すぎる確定を出さない）', () => {
    const events = run(
      [
        init,
        step({ step_index: 1, state: 'PENDING', step_type: 'agent_response', text_delta: 'hi' }),
      ],
      false,
    );
    expect(pick(events, 'assistant_text')).toHaveLength(0);
  });

  it.each([
    ['WAITING', 'WAITING'],
    ['RUNNING', 'RUNNING'],
  ])('%s の result は決着として扱わない', (_label, status) => {
    const events = run([init, result({ status })], false);
    expect(pick(events, 'turn_completed')).toHaveLength(0);
    expect(pick(events, 'turn_stopped')).toHaveLength(0);
  });

  it.each([
    ['CANCELED', 'connection'],
    ['INTERRUPTED', 'connection'],
    ['INVALID', 'failed'],
  ])('%s は %s へ分類する', (status, cause) => {
    const stopped = pick(run([init, result({ status, error: 'stopped' })]), 'turn_stopped');
    expect(stopped[0]?.cause).toBe(cause);
  });

  it('本文を積んでいないターンは result.response を turn_completed に載せる', () => {
    const completed = pick(
      run([init, result({ status: 'SUCCESS', response: 'done' })]),
      'turn_completed',
    );
    expect(completed[0]?.text).toBe('done');
  });

  it('init を取りこぼしても step_update から会話 id を拾う', () => {
    const events = run([step({ step_index: 0, state: 'DONE', step_type: 'user_input' })], false);
    expect(pick(events, 'session_started')[0]?.sessionId).toBe('c1');
  });

  it('session_started は終端イベントより前に出す（完了を running へ巻き戻さない）', () => {
    const events = run([result({ status: 'SUCCESS', response: 'x' })]);
    const started = events.findIndex((e) => e.kind === 'session_started');
    const completed = events.findIndex((e) => e.kind === 'turn_completed');
    expect(started).toBeGreaterThanOrEqual(0);
    expect(started).toBeLessThan(completed);
  });

  it('gh pr create のシェル実行に prCreate の印を付ける', () => {
    const events = run([
      init,
      step({
        step_index: 1,
        state: 'ACTIVE',
        step_type: 'tool',
        tool_name: 'run_command',
        tool_info: { name: 'run_command', parameters: { CommandLine: 'gh pr create --fill' } },
      }),
    ]);
    expect(pick(events, 'tool_use')[0]?.prCreate).toBe(true);
  });
});

describe('antigravityToolKind', () => {
  // 名前は実バイナリ（agy 1.2.10）から採取したもの。
  it.each([
    ['run_command', 'shell'],
    ['command_status', 'shell'],
    ['view_file', 'read'],
    ['view_code_item', 'read'],
    ['read_url_content', 'read'],
    ['edit_file', 'edit'],
    ['create_file', 'edit'],
    ['write_to_file', 'edit'],
    ['grep_search', 'search'],
    ['list_dir', 'search'],
    ['search_web', 'search'],
    ['ask_permission', 'other'],
    ['browser_click_element', 'other'],
    ['totally_unknown_tool', 'other'],
  ])('%s → %s', (name, kind) => {
    expect(antigravityToolKind(name)).toBe(kind);
  });

  it('名前が無ければ other', () => {
    expect(antigravityToolKind(undefined)).toBe('other');
  });
});
