import { describe, expect, it } from 'vitest';
import {
  type AgentCapabilitySource,
  agentSupports,
  capabilityLookup,
  showsAccountUsage,
  supportsCapability,
} from './agent-capabilities';
import { NO_CAPABILITIES } from './agent-ports';
import type { AgentId, SessionStatus } from './types';

const FULL = {
  permissions: true,
  interrupt: true,
  setModel: true,
  resume: true,
  modelCatalog: true,
  usage: true,
  cost: true,
  transcript: true,
};

const AGENTS: AgentCapabilitySource[] = [
  { id: 'claude', capabilities: FULL },
  { id: 'codex', capabilities: NO_CAPABILITIES },
  { id: 'grok', capabilities: { ...NO_CAPABILITIES, permissions: true, interrupt: true } },
];

describe('supportsCapability', () => {
  it.each([
    ['持っている', FULL, 'usage' as const, true],
    ['持っていない', NO_CAPABILITIES, 'usage' as const, false],
  ])('%s', (_label, caps, key, expected) => {
    expect(supportsCapability(caps, key)).toBe(expected);
  });

  it('不明（undefined）なら縮退しない', () => {
    // 未登録の provider・`agent` を持たない古いセッションで機能を隠すと、
    // 動くはずの操作が黙って消える。
    expect(supportsCapability(undefined, 'usage')).toBe(true);
    expect(supportsCapability(undefined, 'permissions')).toBe(true);
  });
});

describe('capabilityLookup / agentSupports', () => {
  const lookup = capabilityLookup(AGENTS);

  it.each<[AgentId | undefined, keyof typeof FULL, boolean]>([
    ['claude', 'usage', true],
    ['claude', 'cost', true],
    ['codex', 'usage', false],
    ['codex', 'permissions', false],
    ['grok', 'permissions', true],
    ['grok', 'cost', false],
    [undefined, 'usage', true],
  ])('%s の %s → %s', (agent, key, expected) => {
    expect(agentSupports(lookup, agent, key)).toBe(expected);
  });

  it('未登録の provider は不明として扱う', () => {
    const only = capabilityLookup([{ id: 'codex', capabilities: NO_CAPABILITIES }]);
    expect(only('claude')).toBeUndefined();
    expect(agentSupports(only, 'claude', 'usage')).toBe(true);
  });
});

describe('showsAccountUsage', () => {
  const capabilities = capabilityLookup(AGENTS);
  const session = (agent: AgentId, status: SessionStatus = 'completed') => ({ agent, status });

  it.each<[string, AgentId | undefined, { agent?: AgentId; status: SessionStatus }[], boolean]>([
    ['既定が usage を報告する', 'claude', [], true],
    ['既定は報告しないがセッションが報告する', 'codex', [session('claude')], true],
    ['既定もセッションも報告しない', 'codex', [session('codex'), session('grok')], false],
    ['archived だけの claude は数えない', 'codex', [session('claude', 'archived')], false],
    ['既定が不明なら出す', undefined, [session('codex')], true],
  ])('%s', (_label, defaultAgent, sessions, expected) => {
    expect(showsAccountUsage({ sessions, defaultAgent, capabilities })).toBe(expected);
  });
});
