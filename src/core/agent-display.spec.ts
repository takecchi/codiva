import { describe, expect, it } from 'vitest';
import { sessionAgentId, usesMultipleAgents } from './agent-display';
import type { AgentId } from './types';

describe('sessionAgentId', () => {
  it.each<[{ agent?: AgentId }, AgentId]>([
    [{ agent: 'codex' }, 'codex'],
    [{ agent: 'grok' }, 'grok'],
    // 切替対応より前に保存された状態（`agent` 無し）は既定（claude）扱い。
    [{}, 'claude'],
  ])('%o → %s', (session, expected) => {
    expect(sessionAgentId(session)).toBe(expected);
  });
});

describe('usesMultipleAgents', () => {
  it.each<[string, { agent?: AgentId }[], boolean]>([
    ['0 件', [], false],
    ['全部同じ', [{ agent: 'codex' }, { agent: 'codex' }], false],
    ['未設定は claude と同じ', [{}, { agent: 'claude' }], false],
    ['混在', [{ agent: 'claude' }, { agent: 'codex' }], true],
    ['未設定と別 provider の混在', [{}, { agent: 'grok' }], true],
  ])('%s', (_label, sessions, expected) => {
    expect(usesMultipleAgents(sessions)).toBe(expected);
  });
});
