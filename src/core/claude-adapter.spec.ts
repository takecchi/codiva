import type { Options, Query } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';
import type { AgentRunOptions, AgentRunRequest } from './agent-ports';
import { createClaudeAdapter, type QueryFn } from './claude-adapter';

/** 呼び出された `query()` の options とプロンプト列を覗くフェイク（推論も I/O も無い）。 */
function makeQuerySpy(): {
  queryFn: QueryFn;
  seen: () => Options | undefined;
  /** SDK へ実際に渡ったユーザーメッセージの本文（渡された順）。 */
  prompts: () => Promise<string[]>;
} {
  let seen: Options | undefined;
  let drained: Promise<string[]> = Promise.resolve([]);
  const queryFn: QueryFn = ({ options, prompt }) => {
    seen = options;
    drained = (async () => {
      const texts: string[] = [];
      for await (const message of prompt) {
        const content = message.message.content;
        texts.push(typeof content === 'string' ? content : JSON.stringify(content));
      }
      return texts;
    })();
    return (async function* () {})() as unknown as Query;
  };
  return { queryFn, seen: () => seen, prompts: () => drained };
}

function request(over: Partial<AgentRunRequest> = {}): AgentRunRequest {
  return {
    cwd: '/tmp/worktree',
    prompt: (async function* () {})(),
    options: {},
    requestPermission: async () => ({ behavior: 'deny' }),
    abortController: new AbortController(),
    ...over,
  };
}

async function* prompts(...texts: readonly string[]): AsyncIterable<string> {
  for (const text of texts) {
    yield text;
  }
}

describe('createClaudeAdapter', () => {
  // 既定は project のみ。ここが広がるとユーザーの手元設定（hooks 等）が worktree の
  // セッションへ黙って載るので、既定値そのものを固定しておく。
  it('reads only project settings by default', () => {
    const spy = makeQuerySpy();
    createClaudeAdapter({ queryFn: spy.queryFn }).open(request());
    expect(spy.seen()?.settingSources).toEqual(['project']);
  });

  // `~/.claude/settings.json` の `enabledPlugins` は user 層にあるので、'user' を渡せない限り
  // Claude Code のプラグインはセッションにロードされない（実測: init の plugins が空）。
  it('forwards the configured setting sources (user = plugins are loaded)', () => {
    const spy = makeQuerySpy();
    createClaudeAdapter({
      queryFn: spy.queryFn,
      settingSources: ['user', 'project', 'local'],
    }).open(request());
    expect(spy.seen()?.settingSources).toEqual(['user', 'project', 'local']);
  });

  // `/agent` の引き継ぎは systemPrompt ではなく**最初のユーザーメッセージ**に前置する
  // （3 provider 共通の契約。ここが抜けると切替の文脈が黙って消える）。
  it('prepends the handoff to the first user message only', async () => {
    const spy = makeQuerySpy();
    const options: AgentRunOptions = { handoff: 'HANDOVER' };
    createClaudeAdapter({ queryFn: spy.queryFn }).open(
      request({ prompt: prompts('now you', 'and this'), options }),
    );
    expect(await spy.prompts()).toEqual([
      'HANDOVER\n\n# Current instruction after the switch\n\nnow you',
      'and this',
    ]);
  });

  it('passes the prompt through untouched when there is no handoff', async () => {
    const spy = makeQuerySpy();
    createClaudeAdapter({ queryFn: spy.queryFn }).open(request({ prompt: prompts('just this') }));
    expect(await spy.prompts()).toEqual(['just this']);
  });
});
