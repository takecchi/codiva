import { describe, expect, it } from 'vitest';
import { noAgentInstalled, resolveDefaultAgentId } from '@/core/agent-availability';
import type { AgentAvailability } from '@/core/agent-ports';
import type { AgentId } from '@/core/types';

const ORDER: readonly AgentId[] = ['claude', 'codex'];
const REG: readonly AgentId[] = ['claude', 'codex'];

function avail(
  entries: Partial<Record<AgentId, AgentAvailability>>,
): Map<AgentId, AgentAvailability> {
  return new Map(Object.entries(entries) as [AgentId, AgentAvailability][]);
}

const YES: AgentAvailability = { installed: true, loggedIn: true };
const INSTALLED_NO_LOGIN: AgentAvailability = { installed: true, loggedIn: false };
const MISSING: AgentAvailability = { installed: false, loggedIn: false };

describe('resolveDefaultAgentId', () => {
  it('honours an explicit configured agent even when it is not installed', () => {
    // 明示設定はすり替えない（UI が導入を促す側に回る）。
    expect(resolveDefaultAgentId('codex', REG, avail({ codex: MISSING, claude: YES }), ORDER)).toBe(
      'codex',
    );
  });

  it('ignores a configured agent that is not registered', () => {
    // 型にはあるがアダプタ未登録（grok）は無視して自動選択へ。
    expect(resolveDefaultAgentId('grok', REG, avail({ claude: YES }), ORDER)).toBe('claude');
  });

  it('auto-picks the first installed agent in order when unconfigured', () => {
    expect(resolveDefaultAgentId(undefined, REG, avail({ codex: YES }), ORDER)).toBe('codex');
    expect(resolveDefaultAgentId(undefined, REG, avail({ claude: YES, codex: YES }), ORDER)).toBe(
      'claude',
    );
  });

  it('treats installed-but-not-logged-in as installed for the auto-pick', () => {
    expect(resolveDefaultAgentId(undefined, REG, avail({ codex: INSTALLED_NO_LOGIN }), ORDER)).toBe(
      'codex',
    );
  });

  it('falls back to the first registered agent when nothing is installed', () => {
    expect(
      resolveDefaultAgentId(undefined, REG, avail({ claude: MISSING, codex: MISSING }), ORDER),
    ).toBe('claude');
  });

  it('falls back to the first registered agent before detection resolves', () => {
    expect(resolveDefaultAgentId(undefined, REG, new Map(), ORDER)).toBe('claude');
  });
});

describe('noAgentInstalled', () => {
  it('is false while detection has not resolved (unknown, not "missing")', () => {
    expect(noAgentInstalled(REG, new Map())).toBe(false);
    expect(noAgentInstalled(REG, avail({ claude: MISSING }))).toBe(false); // codex 未検出
  });

  it('is false when at least one agent is installed', () => {
    expect(noAgentInstalled(REG, avail({ claude: MISSING, codex: INSTALLED_NO_LOGIN }))).toBe(
      false,
    );
  });

  it('is true only once every registered agent is confirmed missing', () => {
    expect(noAgentInstalled(REG, avail({ claude: MISSING, codex: MISSING }))).toBe(true);
  });

  it('is true when there are no registered agents at all', () => {
    expect(noAgentInstalled([], new Map())).toBe(true);
  });
});
