import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  type GrokMessage,
  grokUpdateOf,
  isGrokUpdateMethod,
  toGrokMessage,
  toGrokModelState,
  toGrokPermissionParams,
  toGrokQuestionParams,
  toGrokUpdate,
} from '@/core/grok-events';

/**
 * 受理ガードの番人。ここを通った行は `grok-parse.ts` / `grok-adapter.ts` が中身を
 * ほぼ無条件に読むので、欠けたものを通すと TypeError が readLoop を突き抜けて
 * ターンごと死ぬ（そのうえ `grok agent stdio` が孤児として残る）。
 *
 * 形は想定で書かない — 実バイナリ（grok 1.0.0）から採った
 * `__fixtures__/grok-*.jsonl` が唯一の出所（規約: `.claude/rules/sdk-integration.md`）。
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
    .filter((n) => n.startsWith('grok-') && n.endsWith('.jsonl'))
    .sort();
}

/** 生の行から `method` を読む（テストの選別用。型を緩めないための小さな窓）。 */
function methodOf(line: unknown): string | undefined {
  const method = (line as { method?: unknown }).method;
  return typeof method === 'string' ? method : undefined;
}

/** 生の行から `id` を読む。 */
function idOf(line: unknown): unknown {
  return (line as { id?: unknown }).id;
}

function findLine(name: string, predicate: (line: unknown) => boolean): unknown {
  const line = loadRaw(name).find(predicate);
  if (line === undefined) {
    throw new Error(`fixture ${name} carries no line matching the predicate`);
  }
  return line;
}

describe('toGrokMessage', () => {
  it('実データの 4 種（response / error / request / notification）を振り分ける', () => {
    // 応答: `initialize`（id 1 + result）。
    const response = toGrokMessage(findLine('grok-basic.jsonl', (l) => idOf(l) === 1));
    expect(response?.kind).toBe('response');

    // エラー: 401 でターンが落ちたときの `session/prompt` の応答。
    const error = toGrokMessage(
      findLine('grok-autherror.jsonl', (l) => (l as { error?: unknown }).error !== undefined),
    );
    expect(error).toMatchObject({
      kind: 'error',
      error: { code: -32603, message: 'Internal error' },
    });

    // 要求: 許可（応答を返さないとターンが止まる）。
    const request = toGrokMessage(
      findLine('grok-permission.jsonl', (l) => methodOf(l) === 'session/request_permission'),
    );
    expect(request).toMatchObject({ kind: 'request', id: 0, method: 'session/request_permission' });

    // 通知: `method` はあるが `id` が無い。
    const notification = toGrokMessage(
      findLine('grok-basic.jsonl', (l) => methodOf(l) === 'session/update'),
    );
    expect(notification?.kind).toBe('notification');
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', '{"jsonrpc":"2.0"}'],
    ['a number', 42],
    // id も method も無い = JSON-RPC のどの役でもない。
    ['an empty object', {}],
    ['jsonrpc だけの行', { jsonrpc: '2.0' }],
    ['method が文字列でない行', { jsonrpc: '2.0', method: 123 }],
    ['配列', []],
  ])('%s を捨てる', (_name, value) => {
    expect(toGrokMessage(value)).toBeUndefined();
  });

  it('フィクスチャの全行を受理する（1 行でも落とすとその通信が消える）', () => {
    const names = fixtureNames();
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      for (const line of loadRaw(name)) {
        const message = toGrokMessage(line);
        if (!message) {
          throw new Error(`${name} carries a line toGrokMessage rejected: ${JSON.stringify(line)}`);
        }
      }
    }
  });
});

describe('isGrokUpdateMethod / grokUpdateOf', () => {
  it.each([
    ['session/update', true],
    ['_x.ai/session_notification', true],
    ['_x.ai/models/update', false],
    ['_x.ai/queue/changed', false],
    ['session/request_permission', false],
  ])('%s が update 封筒を運ぶか = %s', (method, expected) => {
    expect(isGrokUpdateMethod(method)).toBe(expected);
  });

  it('2 本のレール（ACP 標準と xAI 拡張）の両方から update を取り出す', () => {
    // 標準レール: `session/update` の agent_message_chunk。
    const standard = toGrokMessage(
      findLine(
        'grok-basic.jsonl',
        (l) =>
          methodOf(l) === 'session/update' &&
          JSON.stringify(l).includes('"sessionUpdate":"agent_message_chunk"'),
      ),
    ) as GrokMessage;
    expect(grokUpdateOf(standard)).toMatchObject({
      sessionUpdate: 'agent_message_chunk',
      content: { text: 'Hello' },
    });

    // 拡張レール: `_x.ai/session_notification` の retry_state（snake_case の封筒）。
    const extension = toGrokMessage(
      findLine(
        'grok-autherror.jsonl',
        (l) =>
          methodOf(l) === '_x.ai/session_notification' &&
          JSON.stringify(l).includes('"sessionUpdate":"retry_state"'),
      ),
    ) as GrokMessage;
    expect(grokUpdateOf(extension)).toMatchObject({
      sessionUpdate: 'retry_state',
      error_type: 'auth',
    });
  });

  it.each([
    [
      '通知でない（要求）',
      { kind: 'request', id: 1, method: 'session/update', params: {} } as GrokMessage,
    ],
    [
      'update を運ばない通知',
      { kind: 'notification', method: '_x.ai/queue/changed', params: {} } as GrokMessage,
    ],
    ['params がオブジェクトでない', { kind: 'notification', method: 'session/update', params: 1 }],
    ['update が無い', { kind: 'notification', method: 'session/update', params: {} }],
  ] as [string, GrokMessage][])('%s なら undefined', (_name, message) => {
    expect(grokUpdateOf(message)).toBeUndefined();
  });
});

describe('toGrokUpdate', () => {
  it.each([
    ['agent_message_chunk', { sessionUpdate: 'agent_message_chunk', content: { text: 'hi' } }],
    ['agent_thought_chunk', { sessionUpdate: 'agent_thought_chunk', content: { text: 'hmm' } }],
    ['tool_call', { sessionUpdate: 'tool_call', toolCallId: 'call_1' }],
    ['tool_call_update', { sessionUpdate: 'tool_call_update', toolCallId: 'call_1' }],
    ['plan', { sessionUpdate: 'plan', entries: [] }],
    ['retry_state', { sessionUpdate: 'retry_state', message: 'boom' }],
  ])('%s を受理する', (_name, value) => {
    expect(toGrokUpdate(value)).toBe(value);
  });

  it.each([
    ['null', null],
    ['文字列', 'plan'],
    ['sessionUpdate が無い', { entries: [] }],
    ['sessionUpdate が文字列でない', { sessionUpdate: 7 }],
    // 実データに出てくるが codiva が解釈しない種別（CLI が種別を足しても落ちない）。
    ['available_commands_update', { sessionUpdate: 'available_commands_update' }],
    ['user_message_chunk', { sessionUpdate: 'user_message_chunk', content: { text: 'hi' } }],
    ['session_info_update', { sessionUpdate: 'session_info_update', title: 'x' }],
    ['response_completed', { sessionUpdate: 'response_completed', usage: {} }],
    ['pending_interaction', { sessionUpdate: 'pending_interaction', kind: 'permission' }],
    ['turn_completed', { sessionUpdate: 'turn_completed', stop_reason: 'end_turn' }],
    // 壊れた形（parse が中身を無条件に読むところ）。
    ['content の無い chunk', { sessionUpdate: 'agent_message_chunk' }],
    ['content が文字列の chunk', { sessionUpdate: 'agent_thought_chunk', content: 'hi' }],
    ['entries が配列でない plan', { sessionUpdate: 'plan', entries: { a: 1 } }],
    ['entries の無い plan', { sessionUpdate: 'plan' }],
    // `e.content` / `e.status` を無条件に読むので、要素まで見る。
    ['entries の要素が object でない plan', { sessionUpdate: 'plan', entries: [null] }],
    // `content` は for-of で回す（配列でない truthy は TypeError = ターンごと死ぬ）。
    [
      'content が配列でない tool_call_update',
      { sessionUpdate: 'tool_call_update', toolCallId: 'c1', content: { text: 'x' } },
    ],
    [
      'content の要素が object でない tool_call_update',
      { sessionUpdate: 'tool_call_update', toolCallId: 'c1', content: ['x'] },
    ],
    ['message の無い retry_state', { sessionUpdate: 'retry_state', type: 'failed' }],
  ])('%s を捨てる', (_name, value) => {
    expect(toGrokUpdate(value)).toBeUndefined();
  });
});

describe('toGrokPermissionParams', () => {
  it('実データの許可要求を受理する', () => {
    const raw = (
      findLine('grok-permission.jsonl', (l) => methodOf(l) === 'session/request_permission') as {
        params?: unknown;
      }
    ).params;
    const params = toGrokPermissionParams(raw);
    expect(params?.toolCall?.toolCallId).toBe('call_mock1');
    expect(params?.toolCall?._meta?.['x.ai/tool']?.name).toBe('run_terminal_command');
    expect(params?.toolCall?.rawInput?.command).toBe('rm -rf /repo/work');
    expect(params?.options.map((o) => o.optionId)).toEqual(['allow-once', 'reject-once']);
  });

  it.each([
    ['null', null],
    ['options が無い', { sessionId: 's' }],
    ['options が配列でない', { options: {} }],
    // 選べる選択肢が 1 つも無い要求には答えようがない（放置するとターンが止まる）。
    ['options が空', { options: [] }],
    ['optionId の無い選択肢だけ', { options: [{ name: 'Yes', kind: 'allow_once' }] }],
  ])('%s を捨てる', (_name, value) => {
    expect(toGrokPermissionParams(value)).toBeUndefined();
  });

  it('optionId を持たない選択肢だけを落とす', () => {
    const params = toGrokPermissionParams({
      options: [{ optionId: 'allow-once' }, { name: 'broken' }, null],
    });
    expect(params?.options).toEqual([{ optionId: 'allow-once' }]);
  });
});

describe('toGrokQuestionParams', () => {
  it('実データの質問要求を受理する', () => {
    const raw = (
      findLine('grok-question.jsonl', (l) => methodOf(l) === '_x.ai/ask_user_question') as {
        params?: unknown;
      }
    ).params;
    const params = toGrokQuestionParams(raw);
    expect(params?.toolCallId).toBe('call_mock1');
    expect(params?.mode).toBe('default');
    expect(params?.questions).toHaveLength(1);
    expect(params?.questions[0]?.question).toBe('Which approach should I use?');
    expect(params?.questions[0]?.multiSelect).toBe(false);
    expect(params?.questions[0]?.options?.map((o) => o.label)).toEqual(['Rewrite', 'Patch']);
  });

  it.each([
    ['null', null],
    ['文字列', 'questions'],
    ['questions が無い', { sessionId: 's', toolCallId: 'call_1' }],
    ['questions が配列でない', { questions: { question: 'x' } }],
  ])('%s を捨てる', (_name, value) => {
    expect(toGrokQuestionParams(value)).toBeUndefined();
  });
});

describe('toGrokModelState', () => {
  it('`{models:{...}}`（session/new の応答）から読む', () => {
    const raw = (findLine('grok-basic.jsonl', (l) => idOf(l) === 2) as { result?: unknown }).result;
    const state = toGrokModelState((raw as { models?: unknown }).models);
    expect(state?.currentModelId).toBe('grok-4.5');
    expect(state?.availableModels?.map((m) => m.modelId)).toEqual(['grok-4.5', 'grok-code-fast-2']);
  });

  it('裸の `{currentModelId, availableModels}`（_x.ai/models/update の params）から読む', () => {
    const raw = (
      findLine('grok-reasoning.jsonl', (l) => methodOf(l) === '_x.ai/models/update') as {
        params?: unknown;
      }
    ).params;
    const state = toGrokModelState(raw);
    expect(state?.currentModelId).toBe('grok-4.5');
    expect(state?.availableModels).toHaveLength(2);
  });

  it('片方だけでも読む（現在のモデルだけ / 一覧だけ）', () => {
    expect(toGrokModelState({ currentModelId: 'grok-4.5' })).toEqual({
      currentModelId: 'grok-4.5',
      availableModels: undefined,
    });
    expect(toGrokModelState({ availableModels: [{ modelId: 'grok-4.5' }] })).toEqual({
      currentModelId: undefined,
      availableModels: [{ modelId: 'grok-4.5' }],
    });
  });

  it('オブジェクトでない要素を一覧から落とす', () => {
    expect(
      toGrokModelState({ availableModels: [{ modelId: 'a' }, 'b', null, 3] })?.availableModels,
    ).toEqual([{ modelId: 'a' }]);
  });

  it.each([
    ['null', null],
    ['文字列', 'grok-4.5'],
    ['空オブジェクト', {}],
    ['models が空', { models: {} }],
    ['currentModelId が文字列でなく一覧も無い', { currentModelId: 7 }],
  ])('%s なら undefined（無いものを埋めない）', (_name, value) => {
    expect(toGrokModelState(value)).toBeUndefined();
  });
});
