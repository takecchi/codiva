import type { Options, Query } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';
import type { AgentRunRequest } from './agent-ports';
import { createClaudeAdapter, type QueryFn } from './claude-adapter';

/** 呼び出された `query()` の options を覗くだけのフェイク（推論も I/O も無い）。 */
function makeQuerySpy(): { queryFn: QueryFn; seen: () => Options | undefined } {
  let seen: Options | undefined;
  const queryFn: QueryFn = ({ options }) => {
    seen = options;
    return (async function* () {})() as unknown as Query;
  };
  return { queryFn, seen: () => seen };
}

function request(): AgentRunRequest {
  return {
    cwd: '/tmp/worktree',
    prompt: (async function* () {})(),
    options: {},
    requestPermission: async () => ({ behavior: 'deny' }),
    abortController: new AbortController(),
  };
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
});
