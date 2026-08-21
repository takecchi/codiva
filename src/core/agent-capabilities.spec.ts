import { describe, expect, it } from 'vitest';
import {
  type AgentCapabilitySource,
  agentSupports,
  capabilityLookup,
  showsAccountInfo,
  supportsCapability,
} from './agent-capabilities';
import { NO_CAPABILITIES } from './agent-ports';
import type { AgentId } from './types';

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

describe('showsAccountInfo', () => {
  const capabilities = capabilityLookup(AGENTS);

  // 見るのは**既定エージェントだけ**（引数に稼働中セッションを取らないのがその表明）。
  // ヘッダのアカウント節は「次に動くエージェント」の説明なので、Claude のセッションが
  // 残っているからといって Codex を選んだ人に claude.ai のプランと枠を出さない。
  it.each<[string, AgentId | undefined, boolean]>([
    ['既定が usage を報告する', 'claude', true],
    ['既定が報告しない（Codex）', 'codex', false],
    ['既定が報告しない（Grok）', 'grok', false],
    ['既定が不明なら出す', undefined, true],
  ])('%s', (_label, defaultAgent, expected) => {
    expect(showsAccountInfo({ defaultAgent, capabilities })).toBe(expected);
  });
});
